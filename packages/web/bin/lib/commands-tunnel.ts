import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { EXIT_CODE, TunnelCliError } from './cli-errors.js';
import { findClosestMatch, generateCompletionScript, showTunnelHelp } from './cli-args.js';
import { requestJson, fetchSystemInfoFromPort, waitForServerHealth } from './cli-http.js';
import {
  discoverRunningInstances,
  getLatestInstance,
  inspectTunnelAttachability,
  isDesktopRuntimeForPort,
  resolveDoctorPortStatuses,
  resolveTunnelProviders,
} from './cli-lifecycle.js';
import {
  normalizeProfileName,
  normalizeProfileHostname,
  normalizeProfileCustomDomain,
  normalizeProfilePublicHostname,
  normalizeProfilePublicUrl,
  normalizeProfileServerAddress,
  normalizeProfileServerPort,
  normalizeProfileRemotePort,
  normalizeProfileToken,
  suggestProfileNameFromHostname,
  resolveToken,
  formatProfileEndpoint,
  getCliManagedRemoteCredentialId,
  persistTunnelProfilesToDisk,
  resolveProfileByName,
} from './cli-tunnel-profiles.js';
import {
  buildTunnelProfileAddCommand,
  buildTunnelStartReplayCommand,
  resolveTunnelTtlOverrides,
} from './cli-tunnel-utils.js';
import {
  FRPC_DEFAULT_DOWNLOAD_TIMEOUT_MS,
  FRPC_DEFAULT_LOCK_TIMEOUT_MS,
} from '../../server/lib/tunnels/frpc-binary-manager.js';
import { FRPC_DEFAULT_STARTUP_TIMEOUT_MS } from '../../server/lib/tunnels/frpc-client.js';
import { TUNNEL_PENDING_START_SETTLE_TIMEOUT_MS } from '../../server/lib/tunnels/index.js';
import { assertSafeBrowserPort, buildLocalUrl, generateUiPassword, hasUiPasswordConfigured, isUnsafeBrowserPort } from './cli-network.js';
import {
  readLastManagedLocalConfigPath,
  writeLastManagedLocalConfigPath,
} from './cli-paths.js';
import {
  intro as clackIntro,
  outro as clackOutro,
  log as clackLog,
  box as clackBox,
  confirm as clackConfirm,
  select as clackSelect,
  text as clackText,
  password as clackPassword,
  cancel as clackCancel,
  isJsonMode,
  isQuietMode,
  shouldRenderHumanOutput,
  canPrompt,
  createSpinner,
  createProgress,
  printJson,
  logStatus,
  formatProviderWithIcon as clackFormatProviderWithIcon,
} from '../cli-output.js';

import type { CliOptions } from './cli-args.js';
import type { LifecycleInstance } from './cli-lifecycle.js';
import type { JsonRequestOptions } from './cli-http.js';
import type { TunnelProfile, TunnelProfilesStore } from './cli-tunnel-profiles.js';
import type { ServeOptions, createServeCommand } from './commands-serve.js';
import type { createLifecycleCommands } from './commands-lifecycle.js';
import { isRecord, isString } from '../../server/lib/shared/object-guards.js';
import type { JsonValue } from '../../server/lib/shared/json-values.js';
import type { FrpcEndpoint } from './cli-tunnel-profile-command.js';
import {
  TUNNEL_PROFILES_VERSION,
  FRPC_PROVIDER,
  TUNNEL_PROVIDER_CAPABILITIES_BY_ID,
  normalizeCliTunnelProvider,
  normalizeCliTunnelMode,
  assertCliProviderMode,
  createTunnelAutoStartOptions,
  hasNonEmptyString,
  normalizeExplicitFrpcServerAddress,
  getFrpcEndpointKind,
  normalizeFrpcEndpointOrThrow,
  getFrpcEndpointFields,
  resolveFrpcEndpointInput,
  promptForFrpcEndpoint,
  isPromptCancelled,
  handleTunnelProfileSubcommand,
} from './cli-tunnel-profile-command.js';

const FRPC_START_SERVER_BUDGET_MS = FRPC_DEFAULT_LOCK_TIMEOUT_MS
  + FRPC_DEFAULT_DOWNLOAD_TIMEOUT_MS
  + FRPC_DEFAULT_STARTUP_TIMEOUT_MS;
const TUNNEL_START_REQUEST_TIMEOUT_MS = FRPC_START_SERVER_BUDGET_MS + 40000;
const TUNNEL_STOP_REQUEST_TIMEOUT_MS = TUNNEL_PENDING_START_SETTLE_TIMEOUT_MS + 10000;

export interface TunnelCommandOptions extends CliOptions {
  noQr?: boolean;
}

type ServeCommand = ReturnType<typeof createServeCommand>;
type StopCommand = ReturnType<typeof createLifecycleCommands>['stop'];
type TargetServeCommand = (options: ServeOptions) => ReturnType<ServeCommand>;
type TargetInstance = LifecycleInstance & { autoStarted?: true };

export interface TunnelCommandDependencies {
  serveCommand: ServeCommand;
  stopCommand: StopCommand;
  setCancelCleanup: (handler: (() => Promise<void>) | null) => void;
  boldText: (text: string) => string;
  ensureTunnelProfilesMigrated: () => TunnelProfilesStore;
}

interface TunnelQrOptions {
  json?: boolean;
  quiet?: boolean;
  explicitQr?: boolean;
  qr?: boolean;
}

type TunnelDoctorCheck = {
  id?: JsonValue | undefined;
  status?: JsonValue | undefined;
  label?: JsonValue | undefined;
  detail?: JsonValue | undefined;
};

type TunnelDoctorMode = {
  mode: string;
  ready?: JsonValue | undefined;
  blockers?: JsonValue | undefined;
  checks?: JsonValue | undefined;
  summary?: JsonValue | undefined;
};

interface TunnelDoctorResponse {
  ok: true;
  provider?: JsonValue | undefined;
  providerChecks: JsonValue[];
  modes: TunnelDoctorMode[];
}

interface TunnelDoctorRequestBody {
  managedRemoteTunnelTokenProvided: boolean;
  managedRemoteTunnelHostnameProvided: boolean;
  managedRemoteTunnelToken?: string;
}

type TunnelModeRequirements = {
  key?: string;
  label?: string;
  requires?: readonly string[];
};

interface TunnelStatusLineBody {
  active?: unknown;
  provider?: string;
  mode?: string;
  url?: string;
}

interface TunnelStatusLine {
  status: 'success' | 'neutral';
  line: string;
  detail: string;
}

type TunnelProviderList = Awaited<ReturnType<typeof resolveTunnelProviders>>['providers'];

interface TunnelModeOption {
  value: string;
  label: string;
  hint?: string;
}

interface TunnelStartPayload {
  provider: string;
  mode: string;
  connectTtlMs?: number;
  sessionTtlMs?: number;
  configPath?: string | null;
  token?: string;
  hostname?: string;
  customDomain?: string;
  serverAddress?: string;
  serverPort?: number;
  remotePort?: number;
  publicUrl?: string;
  httpsPort?: number | undefined;
  managedRemoteTunnelPresetId?: string;
  managedRemoteTunnelPresetName?: string;
}

interface TroubleshootingHint {
  key: string;
  code: string;
  lines: string[];
}

function getDefaultCloudflaredConfigPath() {
  return path.join(os.homedir(), '.cloudflared', 'config.yml');
}

function isReadableRegularFile(filePath: string) {
  if (filePath.trim().length === 0) {
    return false;
  }
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function isQrFailure(value: unknown): value is { message?: unknown } {
  return value !== null && value !== undefined;
}

async function displayTunnelQrCode(url: string) {
  try {
    const qrcode = await import('qrcode-terminal');
    console.log('\n📱 Scan this QR code to access the tunnel:\n');
    qrcode.default.generate(url, { small: true });
    console.log('');
  } catch (error) {
    console.warn(`Warning: Could not generate QR code: ${isQrFailure(error) ? error.message : undefined}`);
  }
}

function isTruthyEnv(value: string | undefined) {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  return normalized !== '0' && normalized !== 'false' && normalized !== 'no';
}

function shouldDisplayTunnelQr(options: TunnelQrOptions | null | undefined) {
  if (options?.json) return false;
  if (options?.quiet) return false;
  if (options?.explicitQr === true) return options.qr === true;
  if (!process.stdout?.isTTY) return false;
  return !isTruthyEnv(process.env.CI);
}

function isDoctorRecord(value: unknown): value is { ok?: unknown; providerChecks?: unknown; modes?: unknown } {
  return Boolean(value) && typeof value === 'object';
}

function isDoctorModeRecord(value: unknown): value is { mode?: unknown; ready?: unknown; blockers?: unknown; checks?: unknown; summary?: unknown } {
  return Boolean(value) && typeof value === 'object';
}

function isDoctorModeEntry(value: unknown): value is TunnelDoctorMode {
  if (!isDoctorModeRecord(value) || typeof value.mode !== 'string') return false;
  if (typeof value.ready === 'boolean' && Array.isArray(value.blockers)) return true;
  if (Array.isArray(value.checks) && isDoctorModeRecord(value.summary) && typeof value.summary.ready === 'boolean') return true;
  return false;
}

function isValidTunnelDoctorResponse(body: unknown): body is TunnelDoctorResponse {
  if (!isDoctorRecord(body)) {
    return false;
  }
  if (body.ok !== true) {
    return false;
  }
  if (!Array.isArray(body.providerChecks)) {
    return false;
  }
  if (!Array.isArray(body.modes)) {
    return false;
  }
  return body.modes.every((entry) => isDoctorModeEntry(entry));
}

function isDoctorCheck(value: JsonValue | undefined): value is TunnelDoctorCheck {
  return isRecord(value);
}

function isDoctorModeReady(modeEntry: TunnelDoctorMode) {
  return modeEntry.ready === true || (isRecord(modeEntry.summary) && modeEntry.summary.ready === true);
}

function listDoctorModeBlockers(modeEntry: TunnelDoctorMode) {
  return Array.isArray(modeEntry.blockers)
    ? modeEntry.blockers
    : (Array.isArray(modeEntry.checks)
      ? modeEntry.checks
        .filter((c): c is TunnelDoctorCheck => isDoctorCheck(c) && c.status === 'fail' && c.id !== 'startup_readiness')
        .map((c) => c.detail || c.label || c.id)
      : []);
}

function assertDoctorCheckPresent(value: JsonValue | undefined) {
  if (value === null || value === undefined) {
    if ('Bun' in globalThis) {
      throw new TypeError(`${value} is not an object (evaluating 'check.status')`);
    }
    throw new TypeError(`Cannot read properties of ${value} (reading 'status')`);
  }
}

interface TargetInstanceRequest {
  options: TunnelCommandOptions;
  serveCommand: TargetServeCommand;
  allowAutoStart: boolean;
  requireAll?: boolean;
  rejectDesktopRuntime?: boolean;
}

function resolveTargetInstance(request: TargetInstanceRequest & { requireAll: true }): Promise<TargetInstance | LifecycleInstance[]>;
function resolveTargetInstance(request: TargetInstanceRequest & { requireAll?: false }): Promise<TargetInstance>;
async function resolveTargetInstance({
  options,
  serveCommand,
  allowAutoStart,
  requireAll = false,
  rejectDesktopRuntime = false,
}: TargetInstanceRequest): Promise<TargetInstance | LifecycleInstance[]> {
  let running = await discoverRunningInstances();

  if (options.all && requireAll) {
    if (running.length === 0) {
      throw new Error('No running OpenChamber instance found. Start one with `openchamber serve`.');
    }
    return running;
  }

  if (options.explicitPort) {
    const found = running.find((entry) => entry.port === options.port);
    if (found) {
      if (rejectDesktopRuntime) {
        const attachability = await inspectTunnelAttachability(found.port, { requireHealthy: true });
        if (!attachability.attachable) {
          if (attachability.reason === 'desktop') {
            throw new Error(
              `Port ${options.port} is used by OpenChamber Desktop app. Tunnel attach requires a CLI instance from \`openchamber serve\`.`
            );
          }
          throw new Error(
            `Port ${options.port} is not an attachable OpenChamber tunnel instance. Ensure it is healthy and running OpenChamber CLI runtime.`
          );
        }
      }
      return found;
    }

    if (rejectDesktopRuntime) {
      const systemInfo = await fetchSystemInfoFromPort(options.port, globalThis.fetch, options.host);
      if (isDesktopRuntimeForPort(systemInfo, options.port)) {
        throw new Error(
          `Port ${options.port} is used by OpenChamber Desktop app. Tunnel attach requires a CLI instance from \`openchamber serve\`.`
        );
      }
    }

    if (allowAutoStart) {
      await serveCommand(createTunnelAutoStartOptions(options, {
        port: options.port,
        explicitPort: true,
        host: options.host,
        uiPassword: options.uiPassword,
        apiOnly: options.apiOnly,
      }));
      running = await discoverRunningInstances();
      const started = running.find((entry) => entry.port === options.port);
      if (started) return { ...started, autoStarted: true };
    }
    throw new Error(`No running OpenChamber instance found on port ${options.port}.`);
  }

  if (rejectDesktopRuntime) {
    const attachableEntries: LifecycleInstance[] = [];
    let sawDesktop = false;
    for (const entry of running) {
      const attachability = await inspectTunnelAttachability(entry.port, { requireHealthy: true });
      if (attachability.reason === 'desktop') {
        sawDesktop = true;
      }
      if (attachability.attachable) {
        attachableEntries.push(entry);
      }
    }

    if (attachableEntries.length === 1 && attachableEntries[0]) {
      return attachableEntries[0];
    }

    if (attachableEntries.length > 1) {
      const ports = attachableEntries.map((entry) => entry.port).join(', ');
      throw new Error(`Multiple attachable OpenChamber instances found: ${ports}. Use --port <port> or --all.`);
    }

    if (allowAutoStart) {
      const startedPort = await serveCommand(createTunnelAutoStartOptions(options, {
        explicitPort: false,
      }));
      running = await discoverRunningInstances();
      const started = running.find((entry) => entry.port === startedPort) || getLatestInstance(running);
      if (started) return { ...started, autoStarted: true };
    }

    if (sawDesktop) {
      throw new Error('Only OpenChamber Desktop instance(s) detected. Tunnel attach requires a CLI instance from `openchamber serve`.');
    }

    throw new Error('No attachable OpenChamber instance found. Start one with `openchamber serve`.');
  }

  if (running.length === 1 && running[0]) {
    return running[0];
  }

  if (running.length === 0) {
    if (allowAutoStart) {
      const startedPort = await serveCommand(createTunnelAutoStartOptions(options, {
        explicitPort: false,
      }));
      running = await discoverRunningInstances();
      const started = running.find((entry) => entry.port === startedPort) || getLatestInstance(running);
      if (started) return { ...started, autoStarted: true };
    }
    throw new Error('No running OpenChamber instance found. Start one with `openchamber serve`.');
  }

  const ports = running.map((entry) => entry.port).join(', ');
  throw new Error(`Multiple OpenChamber instances found: ${ports}. Use --port <port> or --all.`);
}

async function resolveTunnelReadEntries(options: TunnelCommandOptions) {
  const running = await discoverRunningInstances();

  if (options.explicitPort) {
    const found = running.find((entry) => entry.port === options.port);
    if (!found) {
      throw new Error(`No running OpenChamber instance found on port ${options.port}.`);
    }
    return [found];
  }

  if (running.length === 0) {
    throw new Error('No running OpenChamber instance found. Start one with `openchamber serve`.');
  }

  return running;
}

function formatTunnelStatusLine(statusBody: TunnelStatusLineBody | null | undefined, port: number): TunnelStatusLine {
  const active = Boolean(statusBody?.active);
  const provider = statusBody?.provider || 'unknown';
  const mode = statusBody?.mode || 'unknown';
  const url = statusBody?.url || 'n/a';
  return {
    status: active ? 'success' : 'neutral',
    line: `port ${port} ${active ? 'active' : 'inactive'} (${clackFormatProviderWithIcon(provider)}/${mode})`,
    detail: url,
  };
}

function formatModeRequirements(mode: TunnelModeRequirements | null | undefined) {
  const requires = Array.isArray(mode?.requires) ? mode.requires.filter(Boolean) : [];
  if ((mode?.key || '') === 'managed-local') {
    return 'config-path (or default cloudflared config)';
  }
  if (requires.length === 0) {
    return 'none';
  }
  return requires.join(', ');
}

function annotateTunnelProvidersForOutput(providers: TunnelProviderList) {
  return providers.map((provider) => {
    const modes: readonly TunnelModeRequirements[] = Array.isArray(provider?.modes) ? provider.modes : [];
    return {
      ...provider,
      modes: modes.map((mode) => ({
        ...mode,
        displayRequires: formatModeRequirements(mode),
      })),
    };
  });
}

function createTunnelCommand(deps: TunnelCommandDependencies) {
  return (options: TunnelCommandOptions, subcommand?: string | null, action?: string | null) => tunnelCommand(options, subcommand, action, deps);
}

async function tunnelCommand(options: TunnelCommandOptions, subcommand: string | null | undefined, action: string | null | undefined, deps: TunnelCommandDependencies) {
    const { serveCommand, stopCommand, setCancelCleanup, boldText, ensureTunnelProfilesMigrated } = deps;
    const explicitProvider = normalizeCliTunnelProvider(options.provider);
    const explicitMode = normalizeCliTunnelMode(options.mode);
    if (explicitProvider && explicitMode) {
      assertCliProviderMode(explicitProvider, explicitMode);
    }
    switch (subcommand) {
      case 'help':
        showTunnelHelp();
        return;
      case 'profile':
        await handleTunnelProfileSubcommand(options, action, { boldText, ensureTunnelProfilesMigrated });
        return;
      case 'providers': {
        const result = await resolveTunnelProviders(options, {
          readPorts: async () => (await discoverRunningInstances()).map((entry) => entry.port),
        });
        if (isJsonMode(options)) {
          printJson({ providers: annotateTunnelProvidersForOutput(result.providers), source: result.source });
          return;
        }
        if (isQuietMode(options)) {
          for (const provider of result.providers) {
            const modes = Array.isArray(provider?.modes) ? provider.modes : [];
            const providerId = provider?.provider || 'unknown';
            process.stdout.write(`provider ${providerId} modes ${modes.length}\n`);
            for (const mode of modes) {
              const requires = formatModeRequirements(mode).replace(/,\s+/g, ',');
              process.stdout.write(`mode ${mode?.key || 'unknown'} requires ${requires}\n`);
            }
          }
          return;
        }
        clackIntro('Tunnel Providers');
        for (const provider of result.providers) {
          const modes = Array.isArray(provider?.modes) ? provider.modes : [];
          clackLog.success(`${clackFormatProviderWithIcon(provider.provider)} — ${modes.length} mode(s)`);
          for (const mode of modes) {
            const label = mode.label || mode.key;
            const requires = formatModeRequirements(mode);
            clackLog.step(`${mode.key} — ${label}\n  requires: ${requires}`);
          }
        }
        clackOutro(`${result.providers.length} provider(s)`);
        return;
      }
      case 'ready': {
        const provider = normalizeCliTunnelProvider(options.provider) || 'cloudflare';
        const entries = await resolveTunnelReadEntries(options);

        const results = [];
        for (const entry of entries) {
          try {
            const { response, body } = await requestJson(entry.port, `/api/openchamber/tunnel/check?provider=${encodeURIComponent(provider)}`);
            if (!response.ok) {
              results.push({ port: entry.port, error: body?.error || `check ${response.status}` });
              continue;
            }
            results.push({ port: entry.port, result: body });
          } catch (error) {
            results.push({ port: entry.port, error: error instanceof Error ? error.message : String(error) });
          }
        }

        if (isJsonMode(options)) {
          printJson({ instances: results });
          return;
        }

        if (isQuietMode(options)) {
          for (const result of results) {
            if (result.error) {
              process.stderr.write(`port ${result.port} failed: ${result.error}\n`);
              continue;
            }
            const providerId = result.result?.provider || provider;
            if (result.result?.available) {
              process.stdout.write(`port ${result.port} ready ${providerId} ${result.result?.version || 'unknown'}\n`);
            } else {
              process.stdout.write(`port ${result.port} not-ready ${providerId} ${result.result?.message || 'not ready'}\n`);
            }
          }
          return;
        }

        clackIntro('Tunnel Ready');
        for (const result of results) {
          if (result.error) {
            logStatus('error', `port ${result.port} failed`, result.error);
            continue;
          }

          logStatus(
            result.result?.available ? 'success' : 'warning',
            `port ${result.port} provider ${clackFormatProviderWithIcon(result.result?.provider || provider)}`,
            result.result?.available
              ? `ready (${result.result?.version || 'unknown version'})`
              : (result.result?.message || 'not ready'),
          );
        }
        clackOutro(`${results.length} instance(s)`);
        return;
      }
      case 'status': {
        const entries = await resolveTunnelReadEntries(options);

        const results = [];
        for (const entry of entries) {
          try {
            const { response, body } = await requestJson(entry.port, '/api/openchamber/tunnel/status');
            if (!response.ok) {
              results.push({ port: entry.port, error: body?.error || `status ${response.status}` });
              continue;
            }
            results.push({ port: entry.port, status: body });
          } catch (error) {
            results.push({ port: entry.port, error: error instanceof Error ? error.message : String(error) });
          }
        }

        if (isJsonMode(options)) {
          printJson({ instances: results });
          return;
        }

        if (isQuietMode(options)) {
          for (const result of results) {
            if (result.error) {
              process.stderr.write(`port ${result.port} failed: ${result.error}\n`);
              continue;
            }
            const active = Boolean(result.status?.active);
            const provider = result.status?.provider || 'unknown';
            const mode = result.status?.mode || 'unknown';
            const url = result.status?.url || 'n/a';
            process.stdout.write(`port ${result.port} ${active ? 'active' : 'inactive'} ${provider}/${mode} ${url}\n`);
          }
          return;
        }

        clackIntro('Tunnel Status');
        for (const result of results) {
          if (result.error) {
            logStatus('error', `port ${result.port} failed`, result.error);
            continue;
          }
          const sl = formatTunnelStatusLine(result.status, result.port);
          logStatus(sl.status, sl.line, sl.detail);
        }
        clackOutro(`${results.length} instance(s)`);
        return;
      }
      case 'doctor': {
        const requestedDoctorProvider = normalizeCliTunnelProvider(options.provider);
        const requestedDoctorMode = normalizeCliTunnelMode(options.mode);
        const doctorSpin = createSpinner(options);
        doctorSpin?.start('Running tunnel diagnostics...');

        const { statuses: portStatuses, availableEntries } = await resolveDoctorPortStatuses(options);

        doctorSpin?.message('Checking provider...');
        let providerOption = requestedDoctorProvider;

        let doctorProfile: TunnelProfile | null | undefined = null;
        let doctorHostnameOverride = isString(options.hostname) ? options.hostname.trim() : '';
        let doctorCustomDomain = isString(options.customDomain) ? options.customDomain.trim() : '';
        let doctorServerAddress = normalizeExplicitFrpcServerAddress(options);
        let doctorServerPort = normalizeProfileServerPort(options.serverPort);
        let doctorRemotePort = normalizeProfileRemotePort(options.remotePort);
        let doctorPublicUrl = isString(options.publicUrl) ? options.publicUrl.trim() : '';
        const explicitHostnameProvided = doctorHostnameOverride.length > 0;
        const explicitTokenProvided = Boolean(options.tokenStdin)
          || (isString(options.token) && options.token.trim().length > 0)
          || (isString(options.tokenFile) && options.tokenFile.trim().length > 0);
        let doctorTokenValue = resolveToken(options);
        let hasSavedManagedRemoteProfile = false;
        const normalizedMode = requestedDoctorMode;

        if (isString(options.profile) && options.profile.trim().length > 0) {
          const store = ensureTunnelProfilesMigrated();
          const resolved = resolveProfileByName(store.profiles, options.profile, providerOption || options.provider);
          if (!resolved.profile) {
            throw new Error(resolved.error);
          }
          doctorProfile = resolved.profile;
        } else if (!doctorHostnameOverride && !explicitTokenProvided && (!normalizedMode || normalizedMode === 'managed-remote')) {
          const store = ensureTunnelProfilesMigrated();
          const remoteProfiles = store.profiles.filter((entry) => {
            if (entry.mode !== 'managed-remote') return false;
            if (!providerOption) return true;
            return entry.provider === providerOption;
          });
          hasSavedManagedRemoteProfile = remoteProfiles.some((entry) => {
            const savedHostname = normalizeProfileHostname(entry.hostname);
            const savedToken = normalizeProfileToken(entry.token);
            const savedFrpcEndpoint = entry.provider === FRPC_PROVIDER
              && normalizeProfileServerAddress(entry.serverAddress)
              && normalizeProfileServerPort(entry.serverPort)
              && (
                (normalizeProfileRemotePort(entry.remotePort) && normalizeProfilePublicUrl(entry.publicUrl))
                || (normalizeProfileCustomDomain(entry.customDomain) && normalizeProfilePublicHostname(entry.hostname))
              );
            return Boolean((savedHostname || savedFrpcEndpoint) && savedToken);
          });
          if (remoteProfiles.length === 1) {
            doctorProfile = remoteProfiles[0];
          }
        }

        if (doctorProfile) {
          providerOption = providerOption || normalizeCliTunnelProvider(doctorProfile.provider);
          if (providerOption !== FRPC_PROVIDER && !doctorHostnameOverride && isString(doctorProfile.hostname)) {
            doctorHostnameOverride = doctorProfile.hostname.trim();
          }
          if ((!doctorTokenValue || doctorTokenValue.trim().length === 0) && isString(doctorProfile.token)) {
            doctorTokenValue = doctorProfile.token.trim();
          }
          doctorServerAddress = doctorServerAddress || doctorProfile.serverAddress || '';
          doctorServerPort = doctorServerPort || doctorProfile.serverPort;
          if (providerOption === FRPC_PROVIDER) {
            const endpointInput = resolveFrpcEndpointInput(options, doctorProfile);
            doctorRemotePort = endpointInput.remotePort;
            doctorPublicUrl = endpointInput.publicUrl || '';
            doctorCustomDomain = endpointInput.customDomain || '';
            doctorHostnameOverride = endpointInput.hostname || '';
          }
        }

        if (providerOption && normalizedMode) {
          assertCliProviderMode(providerOption, normalizedMode);
        }

        if (providerOption === FRPC_PROVIDER) {
          const doctorEndpointKind = getFrpcEndpointKind({
            remotePort: doctorRemotePort,
            publicUrl: doctorPublicUrl,
            customDomain: doctorCustomDomain,
            hostname: doctorHostnameOverride,
          });
          if (doctorEndpointKind) {
            const doctorEndpoint = normalizeFrpcEndpointOrThrow({
              remotePort: doctorRemotePort,
              publicUrl: doctorPublicUrl,
              customDomain: doctorCustomDomain,
              hostname: doctorHostnameOverride,
            });
            if (doctorEndpoint.kind === 'tcp') {
              doctorRemotePort = doctorEndpoint.remotePort;
              doctorPublicUrl = doctorEndpoint.publicUrl;
              doctorCustomDomain = '';
              doctorHostnameOverride = '';
            } else {
              doctorRemotePort = undefined;
              doctorPublicUrl = '';
              doctorCustomDomain = doctorEndpoint.customDomain;
              doctorHostnameOverride = doctorEndpoint.hostname;
            }
          }
        }

        if (providerOption === FRPC_PROVIDER && isString(options.token) && options.token.trim().length > 0) {
          throw new TunnelCliError(
            'FRPC tokens cannot be passed with --token. Use --token-file, --token-stdin, or a saved profile.',
            EXIT_CODE.USAGE_ERROR,
          );
        }

        let doctorResult: TunnelDoctorResponse | null = null;
        let doctorError: string | null | undefined = null;
        const diagnosticsEntries = [...availableEntries].sort((a, b) => b.mtime - a.mtime);
        if (diagnosticsEntries.length > 0) {
          const query = new URLSearchParams();
          if (providerOption) query.set('provider', providerOption);
          if (normalizedMode) {
            query.set('mode', normalizedMode);
          }
          if (isString(options.configPath)) query.set('configPath', options.configPath);
          if (providerOption === FRPC_PROVIDER && doctorHostnameOverride) {
            query.set('hostname', doctorHostnameOverride);
          } else if (doctorHostnameOverride.length > 0) {
            query.set('managedRemoteTunnelHostname', doctorHostnameOverride);
          }
          if (doctorCustomDomain) query.set('customDomain', doctorCustomDomain);
          if (doctorServerAddress) query.set('serverAddress', doctorServerAddress);
          if (doctorServerPort) query.set('serverPort', String(doctorServerPort));
          if (doctorRemotePort) query.set('remotePort', String(doctorRemotePort));
          if (doctorPublicUrl) query.set('publicUrl', doctorPublicUrl);
          if (hasSavedManagedRemoteProfile) {
            query.set('hasSavedManagedRemoteProfile', '1');
          }
          const doctorBody: TunnelDoctorRequestBody = {
            managedRemoteTunnelTokenProvided: explicitTokenProvided,
            managedRemoteTunnelHostnameProvided: explicitHostnameProvided,
          };
          if (isString(doctorTokenValue) && doctorTokenValue.trim().length > 0) {
            doctorBody.managedRemoteTunnelToken = doctorTokenValue;
          }

          const failedPorts: string[] = [];
          for (const diagnosticsEntry of diagnosticsEntries) {
            try {
              doctorSpin?.message(`Diagnosing provider on port ${diagnosticsEntry.port}...`);
              const doctorFetchOptions: JsonRequestOptions = { timeoutMs: 10000 };
              if (Object.keys(doctorBody).length > 0) {
                doctorFetchOptions.method = 'POST';
                doctorFetchOptions.body = JSON.stringify(doctorBody);
              }
              const { response, body } = await requestJson(
                diagnosticsEntry.port,
                `/api/openchamber/tunnel/doctor?${query.toString()}`,
                doctorFetchOptions,
              );
              if (response.ok && body?.ok && isValidTunnelDoctorResponse(body)) {
                doctorResult = body;
                doctorError = null;
                break;
              }

              const looksIncompatible = response.ok && (!isDoctorRecord(body) || !body.ok);
              const fallbackError = looksIncompatible
                ? `port ${diagnosticsEntry.port}: doctor endpoint unavailable or incompatible (restart this CLI instance)`
                : `port ${diagnosticsEntry.port}: ${body?.error || `doctor ${response.status}`}`;
              failedPorts.push(fallbackError);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              failedPorts.push(`port ${diagnosticsEntry.port}: ${message}`);
            }
          }

          if (!doctorResult) {
            doctorError = failedPorts.length > 0
              ? failedPorts[0]
              : 'No compatible CLI instance found for tunnel doctor.';
          }
        }

        doctorSpin?.clear();

        if (isJsonMode(options)) {
          const cliPorts = portStatuses
            .filter((s) => s.available)
            .map((s) => ({ port: s.port, type: 'cli', available: true }));
          const desktopPorts = portStatuses
            .filter((s) => !s.available)
            .map((s) => ({ port: s.port, type: 'desktop', available: false }));
          printJson({
            ports: [...cliPorts, ...desktopPorts],
            provider: doctorResult ? {
              id: doctorResult.provider,
              checks: doctorResult.providerChecks || [],
            } : null,
            modes: doctorResult?.modes || [],
            error: doctorError || undefined,
          });
          return;
        }

        if (isQuietMode(options)) {
          const cliPorts = portStatuses.filter((s) => s.available).map((s) => s.port);
          process.stdout.write(`cli-ports ${cliPorts.join(',') || 'none'}\n`);
          if (doctorError) {
            process.stderr.write(`doctor-error ${doctorError}\n`);
            return;
          }
          if (!doctorResult) {
            process.stdout.write('doctor unavailable\n');
            return;
          }

          const providerLabel = doctorResult.provider || providerOption || 'unknown';
          process.stdout.write(`provider ${providerLabel}\n`);
          const modes = Array.isArray(doctorResult.modes) ? doctorResult.modes : [];
          for (const modeEntry of modes) {
            const ready = isDoctorModeReady(modeEntry);
            if (ready) {
              process.stdout.write(`mode ${modeEntry.mode} ready\n`);
              continue;
            }

            const blockers = listDoctorModeBlockers(modeEntry);
            process.stdout.write(`mode ${modeEntry.mode} not-ready ${blockers.length || 0}\n`);
            for (const blocker of blockers) {
              process.stdout.write(`blocker ${modeEntry.mode} ${String(blocker)}\n`);
            }
          }
          return;
        }

        const cliPorts = portStatuses.filter((s) => s.available);
        const unavailablePorts = portStatuses.filter((s) => !s.available);

        clackIntro(boldText('Ports'));
        for (const entry of cliPorts) {
          logStatus('success', `port ${entry.port} — CLI (available)`);
        }
        const desktopUnavailablePorts: (number | null | undefined)[] = [];
        for (const entry of unavailablePorts) {
          const isDesktop = isString(entry?.line) && entry.line.includes('desktop runtime');
          if (isDesktop) {
            desktopUnavailablePorts.push(entry.port);
            logStatus('error', `port ${entry.port} — Desktop (tunneling not supported)`);
            continue;
          }
          logStatus('error', `port ${entry.port} — No running instance`);
        }
        if (desktopUnavailablePorts.length > 0) {
          clackLog.message('Only CLI instances (openchamber serve) support tunneling.');
        }

        if (cliPorts.length === 0 && unavailablePorts.length === 0) {
          logStatus('warning', 'No running instances found', 'Start one with `openchamber serve`.');
          clackOutro('No ports available');
          return;
        }
        if (cliPorts.length === 0) {
          logStatus('warning', 'No CLI instances available for tunneling', 'Start one with `openchamber serve`.');
          clackOutro('No CLI ports available');
          return;
        }
        clackOutro(`${cliPorts.length} CLI ${cliPorts.length === 1 ? 'port' : 'ports'} available`);
        console.log('');

        if (doctorProfile) {
          logStatus('info', 'Using saved profile for managed-remote checks', `${doctorProfile.name} (${doctorProfile.provider}/${doctorProfile.mode})`);
          console.log('');
        }

        if (doctorError) {
          clackIntro(boldText('Provider'));
          logStatus('error', 'Provider diagnostics failed', doctorError);
          clackOutro('Failed');
          return;
        }
        if (!doctorResult) {
          clackIntro(boldText('Provider'));
          logStatus('warning', 'Could not reach a running instance for diagnostics');
          clackOutro('Unavailable');
          return;
        }

        const providerLabel = clackFormatProviderWithIcon(isString(doctorResult.provider) ? doctorResult.provider : 'unknown');
        clackIntro(boldText(`Provider: ${providerLabel}`));

        let providerPassCount = 0;
        for (const entry of (doctorResult.providerChecks || [])) {
          assertDoctorCheckPresent(entry);
          const check: TunnelDoctorCheck = isDoctorCheck(entry) ? entry : {};
          const passed = check.status === 'pass';
          if (passed) {
            providerPassCount++;
            logStatus('success', `${check.label}${check.detail ? ` — ${check.detail}` : ''}`);
          } else {
            logStatus('error', check.detail ? `${check.label}\n${check.detail}` : `${check.label}`);
          }
        }

        const depCheck = (doctorResult.providerChecks || []).find(
          (c): c is TunnelDoctorCheck => isDoctorCheck(c) && (c.id === 'dependency' || c.id === 'provider_dependency'),
        );
        if (depCheck && depCheck.status !== 'pass') {
          clackOutro('1 blocker — resolve before checking modes');
          return;
        }
        clackOutro(`${providerPassCount} ${providerPassCount === 1 ? 'check' : 'checks'} passed`);
        console.log('');

        const DOCTOR_NOISE_CHECK_IDS = new Set(['startup_readiness', 'quick_mode_prerequisites']);
        const modes = doctorResult.modes || [];
        if (modes.length === 0) {
          return;
        }

        clackIntro(boldText('Modes'));
        let totalBlockers = 0;
        const troubleshootingHints: TroubleshootingHint[] = [];
        for (const modeEntry of modes) {
          const isReady = isDoctorModeReady(modeEntry);
          if (isReady) {
            const passDetail = Array.isArray(modeEntry.checks)
              ? modeEntry.checks.find((c): c is TunnelDoctorCheck => isDoctorCheck(c) && c.status === 'pass' && !(isString(c.id) && DOCTOR_NOISE_CHECK_IDS.has(c.id)))?.detail
              : null;
            logStatus('success', `${modeEntry.mode} — Ready${passDetail ? ` (${passDetail})` : ''}`);
          } else {
            const blockers = listDoctorModeBlockers(modeEntry);
            totalBlockers += blockers.length;
            const blockerCount = blockers.length;
            const blockerWord = blockerCount === 1 ? 'blocker' : 'blockers';
            logStatus('error', `${modeEntry.mode} — Not ready${blockerCount > 0 ? ` (${blockerCount} ${blockerWord})` : ''}`);
            for (const blocker of blockers) {
              clackLog.message(`  ${blocker}`);
            }

            const normalizedBlockers = blockers.map((blocker) => String(blocker).toLowerCase());
            const isManagedRemote = modeEntry.mode === 'managed-remote';
            const hasTokenIssue = normalizedBlockers.some((line) => line.includes('token')
              || line.includes('unauthorized')
              || line.includes('forbidden')
              || line.includes('authentication')
              || line.includes('auth'));
            const hasPortOrOriginIssue = normalizedBlockers.some((line) => line.includes('port')
              || line.includes('localhost')
              || line.includes('127.0.0.1')
              || line.includes('connection refused')
              || line.includes('dial tcp'));

            if (doctorResult.provider === 'cloudflare' && isManagedRemote && (hasPortOrOriginIssue || hasTokenIssue)) {
              troubleshootingHints.push({
                key: 'managed-remote-port',
                code: '[PORT_MISMATCH]',
                lines: [
                  'Cloudflare target must match the active OpenChamber CLI port.',
                  'Example: `http://127.0.0.1:<port>`',
                  'If CLI picked a different port, update Cloudflare or run `openchamber serve --port <port>`.',
                ],
              });
            }

            if (isManagedRemote && hasTokenIssue) {
              troubleshootingHints.push({
                key: 'managed-remote-token',
                code: '[QR_PREFETCH_TOKEN]',
                lines: [
                  'Some QR readers pre-fetch scanned URLs.',
                  'Pre-fetch can consume one-time bootstrap tokens.',
                  'If validation fails, generate a fresh token/QR and use it immediately in one browser/device.',
                ],
              });
            }
          }
        }
        clackOutro(totalBlockers > 0 ? `Done (${totalBlockers} ${totalBlockers === 1 ? 'issue' : 'issues'})` : 'All modes ready');

        const dedupedHints: TroubleshootingHint[] = [];
        const seenHintKeys = new Set<string>();
        for (const hint of troubleshootingHints) {
          if (!seenHintKeys.has(hint.key)) {
            seenHintKeys.add(hint.key);
            dedupedHints.push(hint);
          }
        }

        if (dedupedHints.length > 0) {
          console.log('');
          clackIntro(boldText('Suggestion notes'));
          for (const hint of dedupedHints) {
            const lines = Array.isArray(hint.lines) ? hint.lines : [];
            const detail = lines.length > 0 ? lines.map((line) => `  ${line}`).join('\n') : undefined;
            logStatus('info', hint.code || '[NOTE]', detail);
          }
          clackOutro(`${dedupedHints.length} ${dedupedHints.length === 1 ? 'suggestion' : 'suggestions'}`);
        }
        return;
      }
      case 'start': {
        let provider = normalizeCliTunnelProvider(options.provider);
        let mode = normalizeCliTunnelMode(options.mode);
        const resolvedTokenValue = resolveToken(options);
        let token = isString(resolvedTokenValue) ? resolvedTokenValue : undefined;
        let hostname = isString(options.hostname) ? options.hostname : undefined;
        let publicUrl = isString(options.publicUrl) ? options.publicUrl : undefined;
        let customDomain = isString(options.customDomain) ? options.customDomain : undefined;
        let serverAddress = normalizeExplicitFrpcServerAddress(options);
        let serverPort = normalizeProfileServerPort(options.serverPort);
        let remotePort = normalizeProfileRemotePort(options.remotePort);
        let frpcEndpoint: FrpcEndpoint | null = null;
        let selectedProfile: TunnelProfile | null | undefined = null;

        if (options.explicitPort) {
          assertSafeBrowserPort(options.port, { context: 'Tunnel start' });
        }

        if (isString(options.profile) && options.profile.trim().length > 0) {
          const store = ensureTunnelProfilesMigrated();
          const resolved = resolveProfileByName(store.profiles, options.profile, provider || options.provider);
          if (!resolved.profile) {
            throw new Error(resolved.error);
          }
          selectedProfile = resolved.profile;
          provider = provider || normalizeCliTunnelProvider(selectedProfile.provider);
          mode = mode || normalizeCliTunnelMode(selectedProfile.mode);
          token = (isString(token) && token.trim().length > 0) ? token : selectedProfile.token;
          serverAddress = serverAddress || selectedProfile.serverAddress || '';
          serverPort = serverPort || selectedProfile.serverPort;
        }

        if (!selectedProfile && !mode && canPrompt(options)) {
          const store = ensureTunnelProfilesMigrated();
          if (store.profiles.length > 0) {
            const profileChoice = await clackSelect({
              message: 'Start from a saved profile or choose a mode?',
              options: [
                { value: '__mode__', label: 'Choose a mode manually' },
                ...store.profiles.map((p) => ({
                  value: p.id,
                  label: `${p.name} (${p.provider}/${p.mode})`,
                  hint: formatProfileEndpoint(p),
                })),
              ],
            });
            if (isPromptCancelled(profileChoice)) {
              clackCancel('Tunnel start cancelled.');
              return;
            }
            if (profileChoice !== '__mode__') {
              selectedProfile = store.profiles.find((p) => p.id === profileChoice);
              if (selectedProfile) {
                provider = provider || normalizeCliTunnelProvider(selectedProfile.provider);
                mode = mode || normalizeCliTunnelMode(selectedProfile.mode);
                token = (isString(token) && token.trim().length > 0) ? token : selectedProfile.token;
                serverAddress = serverAddress || selectedProfile.serverAddress || '';
                serverPort = serverPort || selectedProfile.serverPort;
              }
            }
          }
        }

        provider = provider || 'cloudflare';
        if (provider === FRPC_PROVIDER) {
          const endpointInput = resolveFrpcEndpointInput(options, selectedProfile);
          remotePort = endpointInput.remotePort;
          publicUrl = endpointInput.publicUrl;
          customDomain = endpointInput.customDomain;
          hostname = endpointInput.hostname;
        } else if (selectedProfile && !hasNonEmptyString(options.hostname)) {
          hostname = selectedProfile.hostname;
        }
        if (provider === FRPC_PROVIDER && isString(options.token) && options.token.trim().length > 0) {
          throw new TunnelCliError(
            'FRPC tokens cannot be passed with --token. Use --token-file, --token-stdin, a saved profile, or the interactive password prompt.',
            EXIT_CODE.USAGE_ERROR,
          );
        }

        const providerCaps = TUNNEL_PROVIDER_CAPABILITIES_BY_ID.get(provider);
        if (!mode && canPrompt(options)) {
          const modes = providerCaps?.modes || [];
          const firstMode = modes[0];
          if (modes.length === 1 && firstMode) {
            mode = firstMode.key;
          } else if (modes.length > 1) {
            const modeChoice = await clackSelect({
              message: `Select tunnel mode for ${clackFormatProviderWithIcon(provider)}`,
              options: modes.map((m) => {
                const option: TunnelModeOption = {
                  value: m.key,
                  label: `${m.key} — ${m.label}`,
                };
                if (formatModeRequirements(m) !== 'none') option.hint = `requires: ${formatModeRequirements(m)}`;
                return option;
              }),
            });
            if (isPromptCancelled(modeChoice)) {
              clackCancel('Tunnel start cancelled.');
              return;
            }
            mode = modeChoice;
          }
        }

        mode = mode || providerCaps?.defaults?.mode || 'quick';
        assertCliProviderMode(provider, mode);
        if (mode === 'managed-remote') {
          if (provider === FRPC_PROVIDER && !serverAddress) {
            if (canPrompt(options)) {
              const enteredAddress = await clackText({
                message: 'FRPS server IP address or hostname',
                placeholder: '203.0.113.10',
                validate(value) {
                  return normalizeProfileServerAddress(value) ? undefined : 'A valid FRPS server address is required.';
                },
              });
              if (isPromptCancelled(enteredAddress)) {
                clackCancel('Tunnel start cancelled.');
                return;
              }
              serverAddress = normalizeProfileServerAddress(enteredAddress);
            } else {
              throw new Error('FRPC requires --frps-address <address>.');
            }
          }

          if (provider === FRPC_PROVIDER && !serverPort) {
            if (canPrompt(options)) {
              const enteredPort = await clackText({
                message: 'FRPS control port',
                placeholder: String(selectedProfile?.serverPort || 7000),
                initialValue: String(selectedProfile?.serverPort || 7000),
                validate(value) {
                  return normalizeProfileServerPort(value) ? undefined : 'Port must be between 1 and 65535.';
                },
              });
              if (isPromptCancelled(enteredPort)) {
                clackCancel('Tunnel start cancelled.');
                return;
              }
              serverPort = normalizeProfileServerPort(enteredPort);
            } else {
              throw new Error('FRPC requires --frps-port <port>.');
            }
          }

          if (provider === FRPC_PROVIDER) {
            frpcEndpoint = await promptForFrpcEndpoint({
              options,
              input: { remotePort, publicUrl, customDomain, hostname },
              existingProfile: selectedProfile,
              cancellationMessage: 'Tunnel start cancelled.',
            });
            if (!frpcEndpoint) return;
            if (frpcEndpoint.kind === 'tcp') {
              remotePort = frpcEndpoint.remotePort;
              publicUrl = frpcEndpoint.publicUrl;
              customDomain = undefined;
              hostname = undefined;
            } else {
              remotePort = undefined;
              publicUrl = undefined;
              customDomain = frpcEndpoint.customDomain;
              hostname = frpcEndpoint.hostname;
            }
          }

          if (provider !== FRPC_PROVIDER && !(isString(hostname) && hostname.trim().length > 0)) {
            if (canPrompt(options)) {
              const profilesStore = ensureTunnelProfilesMigrated();
              const lastManagedRemoteProfile = [...profilesStore.profiles]
                .filter((entry) => entry.provider === provider && entry.mode === 'managed-remote')
                .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
              const suggestedHostname = normalizeProfileHostname(lastManagedRemoteProfile?.hostname) || 'app.example.com';
              const enteredHostname = await clackText({
                message: 'Enter managed-remote tunnel hostname',
                placeholder: suggestedHostname,
                initialValue: suggestedHostname,
                validate(value) {
                  if (!isString(value) || value.trim().length === 0) {
                    return 'Hostname is required.';
                  }
                  return undefined;
                },
              });
              if (isPromptCancelled(enteredHostname)) {
                clackCancel('Tunnel start cancelled.');
                return;
              }
              hostname = enteredHostname.trim();
            } else {
              throw new Error('Managed-remote mode requires --hostname <hostname>.');
            }
          }

          if (!(isString(token) && token.trim().length > 0)) {
            if (canPrompt(options)) {
              const entered = await clackPassword({
                message: 'Enter managed-remote tunnel token',
              });
              if (isPromptCancelled(entered) || !entered || !entered.trim()) {
                clackCancel('Tunnel start cancelled.');
                return;
              }
              token = entered.trim();
            } else {
              throw new Error('Managed-remote mode requires a token (--token, --token-file, or --token-stdin).');
            }
          }

          if (!selectedProfile && canPrompt(options)) {
            const runChoice = await clackSelect({
              message: 'Run once, or save profile and run?',
              options: [
                { value: 'run', label: 'Run once', hint: 'Do not save profile' },
                { value: 'save-run', label: 'Save profile and run', hint: 'Reuse with --profile later' },
              ],
            });
            if (isPromptCancelled(runChoice)) {
              clackCancel('Tunnel start cancelled.');
              return;
            }

            if (runChoice === 'save-run') {
              const suggestedName = suggestProfileNameFromHostname(
                provider === FRPC_PROVIDER && frpcEndpoint?.kind === 'tcp' ? serverAddress : hostname,
              );
              const enteredProfileName = await clackText({
                message: 'Profile name',
                placeholder: suggestedName,
                initialValue: suggestedName,
                validate(value) {
                  return normalizeProfileName(value).length > 0 ? undefined : 'Profile name is required.';
                },
              });
              if (isPromptCancelled(enteredProfileName)) {
                clackCancel('Tunnel start cancelled.');
                return;
              }

              const desiredName = normalizeProfileName(enteredProfileName);
              const store = ensureTunnelProfilesMigrated();
              const existingIndex = store.profiles.findIndex(
                (entry) => entry.provider === provider && entry.name.toLowerCase() === desiredName.toLowerCase()
              );

              if (existingIndex >= 0) {
                const shouldOverwrite = await clackConfirm({
                  message: `Profile '${desiredName}' already exists. Overwrite and run?`,
                  initialValue: true,
                });
                if (isPromptCancelled(shouldOverwrite) || !shouldOverwrite) {
                  clackCancel('Tunnel start cancelled.');
                  return;
                }
              }

              const now = Date.now();
              const nextProfiles = [...store.profiles];
              const current = existingIndex >= 0 ? nextProfiles[existingIndex] : undefined;
              const savedEndpointFields: Pick<TunnelProfile, 'hostname' | 'customDomain' | 'publicUrl' | 'serverAddress' | 'serverPort' | 'remotePort'> =
                provider === FRPC_PROVIDER && frpcEndpoint && serverPort !== undefined
                  ? { serverAddress, serverPort, ...getFrpcEndpointFields(frpcEndpoint) }
                  : (hostname !== undefined ? { hostname } : {});
              if (current) {
                nextProfiles[existingIndex] = {
                  id: current.id,
                  name: desiredName,
                  provider,
                  mode: 'managed-remote',
                  ...savedEndpointFields,
                  token,
                  createdAt: current.createdAt,
                  updatedAt: now,
                };
              } else {
                nextProfiles.push({
                  id: crypto.randomUUID(),
                  name: desiredName,
                  provider,
                  mode: 'managed-remote',
                  ...savedEndpointFields,
                  token,
                  createdAt: now,
                  updatedAt: now,
                });
              }

              const persisted = { version: TUNNEL_PROFILES_VERSION, profiles: nextProfiles };
              persistTunnelProfilesToDisk(persisted);

              selectedProfile = persisted.profiles.find(
                (entry) => entry.provider === provider && entry.name.toLowerCase() === desiredName.toLowerCase()
              ) || null;
            }
          }

          if (isString(options.token) && !options.tokenFile && !options.tokenStdin && canPrompt(options)) {
            clackBox(
              'Token passed via --token is visible in your shell history and process list.\n' +
              'Consider using --token-file or --token-stdin for better security.',
              'Security Warning',
            );
          }
        }

        if (provider === FRPC_PROVIDER && !frpcEndpoint) {
          frpcEndpoint = normalizeFrpcEndpointOrThrow({ remotePort, publicUrl, customDomain, hostname });
          if (frpcEndpoint.kind === 'tcp') {
            remotePort = frpcEndpoint.remotePort;
            publicUrl = frpcEndpoint.publicUrl;
            customDomain = undefined;
            hostname = undefined;
          } else {
            remotePort = undefined;
            publicUrl = undefined;
            customDomain = frpcEndpoint.customDomain;
            hostname = frpcEndpoint.hostname;
          }
        }

        if (mode === 'managed-local') {
          const hasConfigPath = isString(options.configPath) && options.configPath.trim().length > 0;
          if (!hasConfigPath && canPrompt(options)) {
            const lastConfigPath = readLastManagedLocalConfigPath();
            const defaultConfigPath = getDefaultCloudflaredConfigPath();
            const suggestedConfigPath = lastConfigPath || defaultConfigPath;
            const suggestedConfigFound = isReadableRegularFile(suggestedConfigPath);
            const defaultConfigFound = isReadableRegularFile(defaultConfigPath);

            if (suggestedConfigFound || defaultConfigFound) {
              const foundPath = suggestedConfigFound ? suggestedConfigPath : defaultConfigPath;
              const configChoice = await clackSelect({
                message: 'Managed-local config',
                options: [
                  {
                    value: 'default',
                    label: 'Use found config',
                    hint: foundPath,
                  },
                  {
                    value: 'custom',
                    label: 'Enter config path',
                  },
                ],
              });
              if (isPromptCancelled(configChoice)) {
                clackCancel('Tunnel start cancelled.');
                return;
              }
              if (configChoice === 'default') {
                options.configPath = foundPath;
              }
            }

            if (!(isString(options.configPath) && options.configPath.trim().length > 0)) {
              const enteredPath = await clackText({
                message: 'Enter managed-local config path',
                placeholder: suggestedConfigPath,
                initialValue: suggestedConfigPath,
                validate(value) {
                  if (!isString(value) || value.trim().length === 0) {
                    return 'Config path is required.';
                  }
                  return undefined;
                },
              });
              if (isPromptCancelled(enteredPath)) {
                clackCancel('Tunnel start cancelled.');
                return;
              }
              options.configPath = enteredPath.trim();
            }

            if (isString(options.configPath) && options.configPath.trim().length > 0) {
              writeLastManagedLocalConfigPath(options.configPath);
            }
          }
        }

        const ttlOverrides = await resolveTunnelTtlOverrides(options);
        if (ttlOverrides === null) {
          return;
        }
        const { connectTtlMs, sessionTtlMs } = ttlOverrides;
        const buildReplayCommandForPort = (port: number) => buildTunnelStartReplayCommand({
          port,
          provider,
          mode,
          profileName: selectedProfile?.name,
          configPath: options.configPath,
          hostname,
          customDomain,
          serverAddress,
          serverPort,
          remotePort,
          publicUrl,
          httpsPort: options.httpsPort,
          connectTtlMs,
          sessionTtlMs,
          qr: options.qr === true,
          noQr: options.noQr === true,
          json: isJsonMode(options),
          quiet: isQuietMode(options),
          includeTokenPlaceholder: !selectedProfile && mode === 'managed-remote' && isString(token) && token.trim().length > 0,
          tokenViaStdin: options.tokenStdin === true,
          tokenFileProvided: isString(options.tokenFile) && options.tokenFile.trim().length > 0,
        });

        if (options.dryRun) {
          const dryRunResult = {
            ok: true,
            dryRun: true,
            provider,
            mode,
            hostname: hostname || null,
            customDomain: customDomain || null,
            serverAddress: serverAddress || null,
            serverPort: serverPort || null,
            remotePort: remotePort || null,
            publicUrl: publicUrl || null,
            hasToken: isString(token) && token.trim().length > 0,
            profile: selectedProfile ? selectedProfile.name : null,
            configPath: options.configPath || null,
            connectTtlMs: connectTtlMs ?? null,
            sessionTtlMs: sessionTtlMs ?? null,
            httpsPort: options.httpsPort ?? null,
          };
          if (isJsonMode(options)) {
            printJson(dryRunResult);
          } else if (!isQuietMode(options)) {
            clackIntro('Tunnel Start (dry-run)');
            logStatus('info', `Would start ${clackFormatProviderWithIcon(provider)}/${mode}`, provider === FRPC_PROVIDER
              ? formatProfileEndpoint(Object.assign({ provider, serverAddress, serverPort }, frpcEndpoint && getFrpcEndpointFields(frpcEndpoint)))
              : (hostname || '(ephemeral URL)'));
            clackOutro('dry-run complete (no changes applied)');
          }
          return;
        }

        if (!options.explicitPort && canPrompt(options)) {
          const runningInstances = await discoverRunningInstances();
          if (runningInstances.length > 1) {
            const safeInstances = runningInstances.filter((entry) => !isUnsafeBrowserPort(entry.port));
            if (safeInstances.length === 0) {
              throw new TunnelCliError(
                'All discovered OpenChamber instance ports are browser-unsafe. Start or target a safe port (3000, 5173, 8080, or high ephemeral).',
                EXIT_CODE.USAGE_ERROR,
              );
            }

            const attachabilityResults = await Promise.all(
              safeInstances.map(async (entry) => ({
                entry,
                attachability: await inspectTunnelAttachability(entry.port, { requireHealthy: true }),
              }))
            );
            const attachableSafeInstances = attachabilityResults
              .filter((item) => item.attachability.attachable)
              .map((item) => item.entry);

            if (attachableSafeInstances.length === 0) {
              throw new TunnelCliError(
                'No attachable OpenChamber CLI instances found on safe ports. Start one with `openchamber serve --port 3000`.',
                EXIT_CODE.USAGE_ERROR,
              );
            }

            const selectedPort = await clackSelect({
              message: 'Select OpenChamber instance port',
              options: attachableSafeInstances.map((entry) => ({
                value: entry.port,
                label: `port ${entry.port}`,
              })),
            });
            if (isPromptCancelled(selectedPort)) {
              clackCancel('Tunnel start cancelled.');
              return;
            }
            options.port = Number(selectedPort);
            options.explicitPort = true;
          }
        }

        let generatedUiPassword: string | null = null;
        const serveProtected = (serveOptions: ServeOptions) => {
          if (hasUiPasswordConfigured(serveOptions.uiPassword)) return serveCommand(serveOptions);
          generatedUiPassword = generateUiPassword();
          options.uiPassword = generatedUiPassword;
          return serveCommand({ ...serveOptions, uiPassword: generatedUiPassword });
        };
        const instance = await resolveTargetInstance({ options, serveCommand: serveProtected, allowAutoStart: true, rejectDesktopRuntime: true });
        if (instance?.autoStarted && shouldRenderHumanOutput(options)) {
          logStatus(
            'info',
            `Using auto-started instance on port ${instance.port}`,
            `logs: openchamber logs -p ${instance.port}`,
          );
        }

        if (instance?.autoStarted) {
          setCancelCleanup(async () => {
            await stopCommand({
              explicitPort: true,
              port: instance.port,
              quiet: true,
              suppressQuietOutput: true,
            }).catch(() => undefined);
          });
        }

        if (instance?.autoStarted) {
          const healthProgress = await createProgress(options, { max: 60 });
          healthProgress?.start(`Waiting for OpenChamber on port ${instance.port} to become healthy (up to 60s)...`);
          let progressedSeconds = 0;
          const healthy = await waitForServerHealth(instance.port, {
            timeoutMs: 60000,
            intervalMs: 250,
            onTick({ elapsedMs, complete }) {
              if (!healthProgress) return;
              const elapsedSeconds = Math.min(60, Math.floor(elapsedMs / 1000));
              const delta = elapsedSeconds - progressedSeconds;
              if (delta > 0) {
                healthProgress.advance(delta);
                progressedSeconds = elapsedSeconds;
                healthProgress.message(`Waiting for OpenChamber health (${progressedSeconds}s / 60s)...`);
              }
              if (complete && progressedSeconds < 60) {
                const remaining = 60 - progressedSeconds;
                if (remaining > 0) {
                  healthProgress.advance(remaining);
                  progressedSeconds = 60;
                }
              }
            },
          });
          if (!healthy) {
            healthProgress?.stop('OpenChamber is still starting');
            throw new Error(
              `OpenChamber on port ${instance.port} is still starting after 60s. Startup time can vary by machine performance. ` +
              `Wait another minute, then check health with \`curl -fsS ${buildLocalUrl(instance.port, '/health')}\`. ` +
              `If health is OK, retry with \`${buildReplayCommandForPort(instance.port)}\`. ` +
              `For diagnostics run \`openchamber logs -p ${instance.port}\`.`
            );
          }
          healthProgress?.stop(`Instance ${instance.port} is healthy`);
        }

        if (selectedProfile && provider === 'cloudflare' && mode === 'managed-remote') {
          const tokenSyncPayload = {
            presetId: getCliManagedRemoteCredentialId(selectedProfile.id),
            presetName: selectedProfile.name,
            managedRemoteTunnelHostname: hostname,
            managedRemoteTunnelToken: token,
          };
          const { response: presetResponse, body: presetBody } = await requestJson(instance.port, '/api/openchamber/tunnel/managed-remote-token', {
            method: 'PUT',
            body: JSON.stringify(tokenSyncPayload),
          });
          if (!presetResponse.ok || !presetBody?.ok) {
            throw new Error(presetBody?.error || `Failed to sync tunnel profile token (${presetResponse.status})`);
          }
        }

        const payload: TunnelStartPayload = { provider, mode };
        if (connectTtlMs !== undefined) payload.connectTtlMs = connectTtlMs;
        if (sessionTtlMs !== undefined) payload.sessionTtlMs = sessionTtlMs;
        if (options.configPath === null) payload.configPath = null;
        if (isString(options.configPath)) payload.configPath = options.configPath;
        if (isString(token)) payload.token = token;
        if (provider === FRPC_PROVIDER) {
          if (serverAddress) payload.serverAddress = serverAddress;
          if (serverPort !== undefined) payload.serverPort = serverPort;
          if (frpcEndpoint) Object.assign(payload, getFrpcEndpointFields(frpcEndpoint));
        } else if (isString(hostname)) {
          payload.hostname = hostname;
        }
        payload.httpsPort = options.httpsPort;
        if (selectedProfile) {
          payload.managedRemoteTunnelPresetId = provider === 'cloudflare'
            ? getCliManagedRemoteCredentialId(selectedProfile.id)
            : selectedProfile.id;
          payload.managedRemoteTunnelPresetName = selectedProfile.name;
        }

        const spin = createSpinner(options);
        spin?.start(`Starting ${clackFormatProviderWithIcon(provider)}/${mode} tunnel...`);

        let response;
        let body;
        try {
          ({ response, body } = await requestJson(instance.port, '/api/openchamber/tunnel/start', {
            method: 'POST',
            body: JSON.stringify(payload),
            timeoutMs: TUNNEL_START_REQUEST_TIMEOUT_MS,
          }));
        } catch (error) {
          if (error instanceof Error && /\/api\/openchamber\/tunnel\/start/.test(error.message) && /timed out/.test(error.message)) {
            spin?.error('Tunnel start timed out');
            throw new Error(
              `Tunnel start timed out after ${TUNNEL_START_REQUEST_TIMEOUT_MS / 1000}s and cancellation was requested. ` +
              `Retry with \`${buildReplayCommandForPort(instance.port)}\`. Run \`openchamber logs -p ${instance.port}\` for details.`
            );
          }
          spin?.error('Tunnel start failed');
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`${message} Run \`openchamber logs -p ${instance.port}\` for details.`);
        }

        if (!response.ok || !body?.ok) {
          spin?.error('Tunnel start failed');
          if (body?.code === 'ui_password_required') {
            throw new Error(
              `OpenChamber on port ${instance.port} runs without a UI password, which a public tunnel requires. `
              + `Stop it with \`openchamber stop -p ${instance.port}\`, then run tunnel start again: `
              + 'the instance it starts gets a UI password.'
            );
          }
          const baseError = body?.error || `Tunnel start failed (${response.status})`;
          const isCloudflareTimeout = /context deadline exceeded|Client\.Timeout exceeded while awaiting headers|failed to request quick Tunnel/i.test(baseError);
          const userError = isCloudflareTimeout
            ? `Cloudflare quick tunnel request timed out. ${baseError}`
            : baseError;
          throw new Error(`${userError} Run \`openchamber logs -p ${instance.port}\` for details.`);
        }

        spin?.clear();

        const replayCommand = buildReplayCommandForPort(instance.port);

        if (isJsonMode(options)) {
          const startOutput = {
            port: instance.port,
            replayCommand,
            ...body,
          };
          if (provider === FRPC_PROVIDER && frpcEndpoint) Object.assign(startOutput, getFrpcEndpointFields(frpcEndpoint));
          if (generatedUiPassword) startOutput.password = generatedUiPassword;
          printJson(startOutput);
        } else if (isQuietMode(options)) {
          const quietUrl = body.connectUrl || body.url || 'n/a';
          process.stdout.write(`port ${instance.port} ${quietUrl}${generatedUiPassword ? ` pass:${generatedUiPassword}` : ''}\n`);
        } else {
          console.log('');
          clackIntro(boldText('Tunnel Started'));
          logStatus('success', `port ${instance.port} ${clackFormatProviderWithIcon(body.provider)}/${body.mode}`);
          logStatus('success', body.connectUrl || body.url || 'n/a');
          if (generatedUiPassword) {
            logStatus('success', 'UI password', generatedUiPassword);
            logStatus('warning', 'save this password', 'it is not shown again');
          }
          if (body.replacedTunnel) {
            const revokedBootstrapCount = Number.isFinite(body.revokedBootstrapCount) ? body.revokedBootstrapCount : 0;
            const invalidatedSessionCount = Number.isFinite(body.invalidatedSessionCount) ? body.invalidatedSessionCount : 0;
            const previousMode = isString(body?.replaced?.mode) ? body.replaced.mode : 'unknown';
            logStatus(
              'warning',
              `replaced previous ${previousMode} tunnel`,
              `revoked ${revokedBootstrapCount}, invalidated ${invalidatedSessionCount}`,
            );
          }
          clackOutro('');

          const optionalTips = [
            { line: 'Check status', detail: 'openchamber tunnel status' },
            { line: 'Stop tunnel', detail: 'openchamber tunnel stop' },
            { line: 'If needed, repeat with same settings', detail: replayCommand },
          ];

          const hasReusableEndpoint = provider === FRPC_PROVIDER
            ? Boolean(serverAddress && serverPort !== undefined && frpcEndpoint)
            : isString(hostname) && hostname.trim().length > 0;
          if (!selectedProfile && mode === 'managed-remote' && hasReusableEndpoint) {
            const profileSaveCommand = buildTunnelProfileAddCommand({
              provider,
              hostname,
              customDomain,
              serverAddress,
              serverPort,
              remotePort,
              publicUrl,
            });
            optionalTips.push({ line: 'Optional: save reusable profile (stores endpoint + token locally)', detail: profileSaveCommand });
            optionalTips.push({ line: 'Start from saved profile', detail: 'openchamber tunnel start --profile <name>' });
          }

          console.log('');
          clackIntro('Optional Tips');
          for (const tip of optionalTips) {
            logStatus('info', tip.line, tip.detail);
          }
          clackOutro('');
        }

        setCancelCleanup(null);

        if (shouldDisplayTunnelQr(options)) {
          const url = body.connectUrl || body.url;
          if (isString(url) && url.length > 0) {
            await displayTunnelQrCode(url);
          }
        }
        return;
      }
      case 'stop': {
        if (
          options.all
          && !options.force
          && (isJsonMode(options) || isQuietMode(options) || !canPrompt(options))
        ) {
          throw new TunnelCliError(
            '`tunnel stop --all` requires --force when input is non-interactive or output uses --json/--quiet.',
            EXIT_CODE.USAGE_ERROR,
          );
        }

        let entries: LifecycleInstance[];
        if (options.all) {
          const resolvedEntries = await resolveTargetInstance({ options, serveCommand, allowAutoStart: false, requireAll: true });
          entries = Array.isArray(resolvedEntries) ? resolvedEntries : [resolvedEntries];
          if (entries.length > 1 && !options.force && canPrompt(options)) {
            const shouldStop = await clackConfirm({
              message: `Stop tunnels on all ${entries.length} instances?`,
            });
            if (isPromptCancelled(shouldStop) || !shouldStop) {
              clackCancel('Tunnel stop cancelled.');
              return;
            }
          }
        } else {
          entries = [await resolveTargetInstance({ options, serveCommand, allowAutoStart: false })];
        }

        const results = [];
        for (const entry of entries) {
          const tunnelStopSpin = shouldRenderHumanOutput(options) ? createSpinner(options) : null;
          tunnelStopSpin?.start(`Stopping tunnel on port ${entry.port}...`);
          try {
            const { response, body } = await requestJson(entry.port, '/api/openchamber/tunnel/stop', {
              method: 'POST',
              timeoutMs: TUNNEL_STOP_REQUEST_TIMEOUT_MS,
            });
            if (!response.ok || body?.ok === false) {
              tunnelStopSpin?.error(`Failed to stop tunnel on port ${entry.port}`);
              results.push({ port: entry.port, error: body?.error || `stop ${response.status}` });
              continue;
            }
            tunnelStopSpin?.stop(`Stopped tunnel on port ${entry.port}`);
            results.push({ port: entry.port, result: body });
          } catch (error) {
            tunnelStopSpin?.error(`Failed to stop tunnel on port ${entry.port}`);
            results.push({ port: entry.port, error: error instanceof Error ? error.message : String(error) });
          }
        }

        const failureCount = results.filter((result) => result.error).length;
        const hasFailures = failureCount > 0;

        if (isJsonMode(options)) {
          printJson({ status: hasFailures ? 'error' : 'ok', ok: !hasFailures, instances: results });
        } else if (isQuietMode(options)) {
          for (const result of results) {
            if (result.error) {
              process.stderr.write(`port ${result.port} failed: ${result.error}\n`);
              continue;
            }
            process.stdout.write(`port ${result.port} stopped\n`);
          }
        } else {
          clackIntro('Tunnel Stop');
          for (const result of results) {
            if (result.error) {
              logStatus('error', `port ${result.port} failed`, result.error);
              continue;
            }
            logStatus('success', `port ${result.port} stopped`, `revoked ${result.result?.revokedBootstrapCount || 0}, invalidated ${result.result?.invalidatedSessionCount || 0}`);
          }
          clackOutro(hasFailures
            ? `${failureCount} of ${results.length} instance(s) failed`
            : `${results.length} instance(s)`);
        }

        if (hasFailures) {
          throw new TunnelCliError(
            `${failureCount} tunnel stop operation(s) failed`,
            EXIT_CODE.NETWORK_RUNTIME_ERROR,
            { reported: true },
          );
        }
        return;
      }
      case 'completion': {
        const shell = action || 'bash';
        const completionScript = generateCompletionScript(shell);
        if (!completionScript) {
          throw new TunnelCliError(
            `Unsupported shell '${shell}'. Supported: bash, zsh, fish.`,
            EXIT_CODE.USAGE_ERROR
          );
        }
        process.stdout.write(completionScript);
        return;
      }
      default: {
        const knownTunnelSubcommands = ['help', 'providers', 'ready', 'doctor', 'status', 'start', 'stop', 'profile', 'completion'];
        const suggestion = findClosestMatch(subcommand, knownTunnelSubcommands);
        const hint = suggestion ? ` Did you mean '${suggestion}'?` : '';
        throw new TunnelCliError(
          `Unknown tunnel subcommand '${subcommand}'.${hint} Use 'openchamber tunnel help'.`,
          EXIT_CODE.USAGE_ERROR
        );
      }
    }
}

export {
  createTunnelCommand,
  isValidTunnelDoctorResponse,
  shouldDisplayTunnelQr,
  createTunnelAutoStartOptions,
  FRPC_START_SERVER_BUDGET_MS,
  TUNNEL_START_REQUEST_TIMEOUT_MS,
  TUNNEL_STOP_REQUEST_TIMEOUT_MS,
};
