import { isEnterpriseMode } from '../enterprise-mode.js';
import { z } from 'zod';
import type { Request } from '../shared/http-contracts.js';
import type { JsonValue } from '../shared/json-values.js';
import type { SettingsDocument } from '../settings/settings-helpers.js';
import type { TunnelController, TunnelDoctorCheck, TunnelDoctorRequest } from './contracts.js';
import type { createTunnelService } from './index.js';
import type { createTunnelProviderRegistry } from './registry.js';
import type { createTunnelAuth } from './tunnel-auth.js';
import type { createManagedTunnelConfigRuntime } from './managed-config.js';
import type { createSettingsNormalizationRuntime } from '../settings/settings-normalization-runtime.js';
import type * as tunnelTypes from './types.js';
import { isNumber, isString } from '../shared/object-guards.js';
import { createTunnelHttpRegistrar, TUNNEL_BLOCKED_ERROR } from './http-routes.js';

type ManagedConfigRuntime = ReturnType<typeof createManagedTunnelConfigRuntime>;
type SettingsNormalizationRuntime = ReturnType<typeof createSettingsNormalizationRuntime>;
type RouteDoctorRequest = TunnelDoctorRequest & Record<string, TunnelDoctorRequest[keyof TunnelDoctorRequest]>;

export interface TunnelRoutesDependencies {
  crypto: Pick<typeof import('node:crypto'), 'randomUUID'>;
  URL: typeof URL;
  tunnelService: ReturnType<typeof createTunnelService>;
  tunnelProviderRegistry: ReturnType<typeof createTunnelProviderRegistry>;
  tunnelAuthController: ReturnType<typeof createTunnelAuth>;
  hasUiPassword: boolean;
  readSettingsFromDiskMigrated: () => Promise<SettingsDocument>;
  readFrpcTunnelConfigFromDisk: ManagedConfigRuntime['readFrpcTunnelConfigFromDisk'];
  upsertFrpcTunnelConfig: ManagedConfigRuntime['upsertFrpcTunnelConfig'];
  resolveFrpcTunnelToken: ManagedConfigRuntime['resolveFrpcTunnelToken'];
  normalizeFrpcCustomDomain: typeof import('./frpc-client.js').normalizeFrpcCustomDomain;
  normalizeFrpcPublicHostname: typeof import('./frpc-client.js').normalizeFrpcPublicHostname;
  normalizeFrpcPublicUrl: typeof import('./frpc-client.js').normalizeFrpcPublicUrl;
  TUNNEL_MODE_QUICK: typeof tunnelTypes.TUNNEL_MODE_QUICK;
  TUNNEL_MODE_MANAGED_LOCAL: typeof tunnelTypes.TUNNEL_MODE_MANAGED_LOCAL;
  TUNNEL_PROVIDER_FRPC: typeof tunnelTypes.TUNNEL_PROVIDER_FRPC;
  readManagedRemoteTunnelConfigFromDisk: ManagedConfigRuntime['readManagedRemoteTunnelConfigFromDisk'];
  normalizeTunnelProvider: typeof tunnelTypes.normalizeTunnelProvider;
  normalizeTunnelMode: typeof tunnelTypes.normalizeTunnelMode;
  normalizeOptionalPath: typeof tunnelTypes.normalizeOptionalPath;
  normalizeManagedRemoteTunnelHostname: SettingsNormalizationRuntime['normalizeManagedRemoteTunnelHostname'];
  normalizeTunnelBootstrapTtlMs: (value: SettingsDocument[string]) => number | null;
  normalizeTunnelSessionTtlMs: (value: SettingsDocument[string]) => number;
  isSupportedTunnelMode: typeof tunnelTypes.isSupportedTunnelMode;
  upsertManagedRemoteTunnelToken: ManagedConfigRuntime['upsertManagedRemoteTunnelToken'];
  resolveManagedRemoteTunnelToken: ManagedConfigRuntime['resolveManagedRemoteTunnelToken'];
  TUNNEL_MODE_MANAGED_REMOTE: typeof tunnelTypes.TUNNEL_MODE_MANAGED_REMOTE;
  TUNNEL_PROVIDER_CLOUDFLARE: typeof tunnelTypes.TUNNEL_PROVIDER_CLOUDFLARE;
  TunnelServiceError: typeof tunnelTypes.TunnelServiceError;
  getActivePort: () => number;
  getRuntimeManagedRemoteTunnelHostname: () => string | undefined;
  setRuntimeManagedRemoteTunnelHostname: (value: string | undefined) => void;
  getRuntimeManagedRemoteTunnelToken: () => string;
  setRuntimeManagedRemoteTunnelToken: (value: string) => void;
  getActiveTunnelController: () => TunnelController | null;
}

export interface NormalizedTunnelRouteRequest {
  provider: string;
  mode: string;
  intent?: string | undefined;
  hostname?: string | undefined;
  token: string;
  configPath?: string | null | undefined;
  httpsPort?: unknown;
  selectedPresetId?: string;
  selectedPresetName?: string;
  serverAddress?: string | undefined;
  serverPort?: number | undefined;
  proxyType?: string | undefined;
  remotePort?: number | undefined;
  publicUrl?: string | undefined;
  customDomain?: string | undefined;
  frpcEndpointExplicit?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

export type FrpcEndpoint = Pick<NormalizedTunnelRouteRequest, 'remotePort' | 'publicUrl' | 'customDomain' | 'hostname'> & {
  proxyType?: 'http' | 'tcp' | undefined;
};
type StoredFrpcConfig = Awaited<ReturnType<ManagedConfigRuntime['readFrpcTunnelConfigFromDisk']>>;

export interface TunnelRouteBody {
  serverAddress?: unknown;
  frpcServerAddress?: unknown;
  serverPort?: unknown;
  frpcServerPort?: unknown;
  proxyType?: unknown;
  frpcProxyType?: unknown;
  remotePort?: unknown;
  frpcRemotePort?: unknown;
  publicUrl?: unknown;
  frpcPublicUrl?: unknown;
  customDomain?: unknown;
  frpcCustomDomain?: unknown;
  frpcPublicHostname?: unknown;
  trustedCaFile?: unknown;
  frpcTrustedCaFile?: unknown;

  provider?: JsonValue;
  mode?: JsonValue;
  intent?: unknown;
  presetId?: unknown;
  presetName?: unknown;
  managedRemoteTunnelPresetId?: unknown;
  managedRemoteTunnelPresetName?: unknown;
  configPath?: unknown;
  managedRemoteTunnelHostname?: unknown;
  tunnelHostname?: unknown;
  hostname?: unknown;
  managedRemoteTunnelToken?: unknown;
  tunnelToken?: unknown;
  token?: unknown;
  managedRemoteTunnelTokenProvided?: unknown;
  tunnelTokenProvided?: unknown;
  tokenProvided?: unknown;
  managedRemoteTunnelHostnameProvided?: unknown;
  tunnelHostnameProvided?: unknown;
  hostnameProvided?: unknown;
  connectTtlMs?: unknown;
  sessionTtlMs?: unknown;
  httpsPort?: unknown;
}

const trimmedText = z.unknown().transform((value) => isString(value) ? value.trim() : undefined).parse;

const createTunnelRouteOperations = (dependencies: TunnelRoutesDependencies) => {
  const {
    URL,
    tunnelService,
    tunnelProviderRegistry,
    hasUiPassword,
    readSettingsFromDiskMigrated,
    readFrpcTunnelConfigFromDisk,
    normalizeTunnelProvider,
    normalizeTunnelMode,
    normalizeFrpcCustomDomain,
    normalizeFrpcPublicHostname,
    normalizeFrpcPublicUrl,
    upsertManagedRemoteTunnelToken,
    upsertFrpcTunnelConfig,
    resolveFrpcTunnelToken,
    TUNNEL_MODE_QUICK,
    TUNNEL_MODE_MANAGED_LOCAL,
    TUNNEL_MODE_MANAGED_REMOTE,
    TUNNEL_PROVIDER_CLOUDFLARE,
    TUNNEL_PROVIDER_FRPC,
    TunnelServiceError,
    setRuntimeManagedRemoteTunnelHostname,
    setRuntimeManagedRemoteTunnelToken,
  } = dependencies;

  const hasOwn = (value: TunnelRouteBody | Request['query'] | null | undefined, key: string) => value != null && Object.hasOwn(value, key);
  const normalizeRequestedProvider = (value: JsonValue | undefined) => normalizeTunnelProvider(value, { strict: true });
  const normalizeRequestedMode = (value: JsonValue | undefined) => normalizeTunnelMode(value, { strict: true });
  const parsePort = z.unknown().transform((value) => {
    const parsed = isString(value) ? Number(value.trim()) : value;
    return isNumber(parsed) && Number.isInteger(parsed) ? parsed : undefined;
  }).parse;
  const normalizeFrpcProxyType = z.unknown().transform((value): 'tcp' | 'http' | undefined => {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }
    if (!isString(value)) {
      throw new TunnelServiceError('validation_error', 'FRPC proxy type must be tcp or http');
    }
    const normalized = value.trim().toLowerCase();
    if (normalized !== 'tcp' && normalized !== 'http') {
      throw new TunnelServiceError('validation_error', `Unsupported FRPC proxy type: ${value}`);
    }
    return normalized;
  }).parse;
  const resolveSettingsFrpcEndpoint = (settings: SettingsDocument): FrpcEndpoint => {
    const configuredProxyType = normalizeFrpcProxyType(settings?.frpcProxyType);
    const rawCustomDomain = isString(settings?.frpcCustomDomain)
      ? settings.frpcCustomDomain.trim()
      : '';
    const rawHostname = isString(settings?.frpcPublicHostname)
      ? settings.frpcPublicHostname.trim()
      : '';
    const rawPublicUrl = isString(settings?.frpcPublicUrl)
      ? settings.frpcPublicUrl.trim()
      : '';
    const remotePort = parsePort(settings?.frpcRemotePort);
    const hasHttpFields = Boolean(rawCustomDomain || rawHostname);
    const hasTcpFields = remotePort !== undefined || Boolean(rawPublicUrl);

    if (!configuredProxyType && hasHttpFields && hasTcpFields) {
      throw new TunnelServiceError('validation_error', 'FRPC settings contain mixed TCP and HTTP endpoint fields');
    }
    const proxyType = configuredProxyType
      || (hasHttpFields ? 'http' : (hasTcpFields ? 'tcp' : undefined));
    if (proxyType === 'http') {
      return {
        proxyType,
        remotePort: undefined,
        publicUrl: undefined,
        customDomain: normalizeFrpcCustomDomain(rawCustomDomain),
        hostname: normalizeFrpcPublicHostname(rawHostname),
      };
    }
    let publicUrl;
    if (proxyType === 'tcp') {
      try {
        publicUrl = normalizeFrpcPublicUrl(rawPublicUrl);
      } catch (error) {
        throw new TunnelServiceError(
          'validation_error',
          error instanceof Error ? error.message : 'FRPC TCP public HTTPS URL is invalid'
        );
      }
    }
    return {
      proxyType,
      remotePort,
      publicUrl,
      customDomain: undefined,
      hostname: undefined,
    };
  };
  const resolveFrpcEndpoint = ({
    proxyType,
    remotePort,
    publicUrl,
    customDomain,
    hostname,
    endpointExplicit,
    storedConfig,
    settings,
  }: FrpcEndpoint & { endpointExplicit: boolean | undefined; storedConfig: StoredFrpcConfig; settings: SettingsDocument }): FrpcEndpoint => {
    const normalizedProxyType = normalizeFrpcProxyType(proxyType);
    const hasRemotePort = remotePort !== undefined && remotePort !== null;
    const hasCustomDomain = isString(customDomain) && customDomain.trim().length > 0;
    const hasPublicUrl = isString(publicUrl) && publicUrl.trim().length > 0;
    const explicit = endpointExplicit === true || Boolean(normalizedProxyType || hasRemotePort || hasCustomDomain || hasPublicUrl);
    if (explicit) {
      return {
        proxyType: normalizedProxyType
          || (hasCustomDomain && !hasRemotePort ? 'http' : (hasRemotePort && !hasCustomDomain ? 'tcp' : undefined)),
        remotePort,
        publicUrl,
        customDomain,
        hostname,
      };
    }
    if (storedConfig) {
      return {
        proxyType: storedConfig.proxyType,
        remotePort: storedConfig.remotePort,
        publicUrl: storedConfig.publicUrl,
        customDomain: storedConfig.customDomain,
        hostname: storedConfig.hostname,
      };
    }
    return resolveSettingsFrpcEndpoint(settings);
  };

  const assertControllerStillActive = (controller: TunnelController | null) => {
    if (controller && tunnelService.isActiveController?.(controller) === false) {
      throw new TunnelServiceError(
        'startup_cancelled',
        'Tunnel start was stopped or superseded before completion'
      );
    }
  };

  const resolveActiveNormalizedTunnelMode = () => {
    const mode = tunnelService.resolveActiveMode();
    if (mode === TUNNEL_MODE_MANAGED_LOCAL) {
      return TUNNEL_MODE_MANAGED_LOCAL;
    }
    if (mode === TUNNEL_MODE_MANAGED_REMOTE) {
      return TUNNEL_MODE_MANAGED_REMOTE;
    }
    return TUNNEL_MODE_QUICK;
  };

  const resolveNormalizedTunnelHost = (publicUrl: string) => {
    if (publicUrl.trim().length === 0) {
      return null;
    }
    try {
      return new URL(publicUrl).hostname.toLowerCase();
    } catch {
      return null;
    }
  };

  const normalizeBrowserReadyPublicUrl = (value: string | null | undefined) => {
    if (!isString(value) || !value.trim()) {
      throw new TunnelServiceError('unsafe_public_url', 'Tunnel provider did not supply a browser-ready HTTPS URL');
    }
    let parsed;
    try {
      parsed = new URL(value.trim());
    } catch {
      throw new TunnelServiceError('unsafe_public_url', 'Tunnel provider supplied an invalid public URL');
    }
    if (
      parsed.protocol !== 'https:'
      || parsed.username
      || parsed.password
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash
      || parsed.origin === 'null'
    ) {
      throw new TunnelServiceError('unsafe_public_url', 'Tunnel public URL must be an origin-only HTTPS URL');
    }
    return parsed.origin;
  };

  const resolvePreferredTunnelProvider = async (reqBody: TunnelRouteBody | null = null) => {
    if (hasOwn(reqBody, 'provider')) {
      return normalizeRequestedProvider(reqBody?.provider);
    }
    const activeProvider = tunnelService.resolveActiveProvider();
    if (activeProvider) {
      return normalizeTunnelProvider(activeProvider);
    }
    const settings = await readSettingsFromDiskMigrated();
    return normalizeTunnelProvider(isString(settings?.tunnelProvider) ? settings.tunnelProvider : undefined);
  };

  const startTunnelWithNormalizedRequest = async ({
    provider,
    mode,
    intent,
    hostname,
    token,
    configPath,
    selectedPresetId,
    selectedPresetName,
    serverAddress,
    serverPort,
    proxyType,
    remotePort,
    publicUrl,
    customDomain,
    frpcEndpointExplicit,
    signal,
  }: NormalizedTunnelRouteRequest) => {
    if (isEnterpriseMode()) {
      throw Object.assign(new Error(TUNNEL_BLOCKED_ERROR), { code: 'enterprise_mode' });
    }
    if (!hasUiPassword) {
      throw new Error('A UI password is required before starting a public tunnel. Restart OpenChamber with --ui-password.');
    }
    if (provider === TUNNEL_PROVIDER_CLOUDFLARE && mode === TUNNEL_MODE_MANAGED_REMOTE) {
      setRuntimeManagedRemoteTunnelHostname(hostname);
      setRuntimeManagedRemoteTunnelToken(token);

      if (token && hostname) {
        await upsertManagedRemoteTunnelToken({
          id: selectedPresetId || hostname,
          name: selectedPresetName || hostname,
          hostname,
          token,
        });
      }
    }

    let effectiveServerAddress = serverAddress;
    let effectiveServerPort = serverPort;
    let effectiveProxyType = normalizeFrpcProxyType(proxyType);
    let effectiveRemotePort = remotePort;
    let effectivePublicUrl = publicUrl;
    let effectiveCustomDomain = customDomain;
    let effectiveHostname = hostname;
    let effectiveToken = token;
    if (provider === TUNNEL_PROVIDER_FRPC) {
      const settings = await readSettingsFromDiskMigrated();
      let storedConfig = null;
      try {
        storedConfig = await readFrpcTunnelConfigFromDisk();
      } catch (error) {
        const canReplaceInvalidConfig = frpcEndpointExplicit === true
          && isString(effectiveServerAddress)
          && effectiveServerAddress.trim().length > 0
          && effectiveServerPort !== undefined
          && isString(effectiveToken)
          && effectiveToken.trim().length > 0;
        if (!canReplaceInvalidConfig) {
          throw error;
        }
      }
      effectiveServerAddress = (isString(effectiveServerAddress) && effectiveServerAddress.trim())
        ? effectiveServerAddress
        : (storedConfig?.serverAddress ?? trimmedText(settings?.frpcServerAddress));
      effectiveServerPort = effectiveServerPort ?? storedConfig?.serverPort ?? parsePort(settings?.frpcServerPort);
      const endpoint = resolveFrpcEndpoint({
        proxyType: effectiveProxyType,
        remotePort: effectiveRemotePort,
        publicUrl: effectivePublicUrl,
        customDomain: effectiveCustomDomain,
        hostname: effectiveHostname,
        endpointExplicit: frpcEndpointExplicit,
        storedConfig,
        settings,
      });
      effectiveProxyType = endpoint.proxyType;
      effectiveRemotePort = endpoint.remotePort;
      effectivePublicUrl = endpoint.publicUrl;
      effectiveCustomDomain = endpoint.customDomain;
      effectiveHostname = endpoint.hostname;
      effectiveToken = effectiveToken || await resolveFrpcTunnelToken({
        serverAddress: effectiveServerAddress,
        serverPort: effectiveServerPort,
      });
    }

    const result = await tunnelService.start({
      provider,
      mode,
      intent,
      configPath,
      token: effectiveToken,
      hostname: effectiveHostname,
      customDomain: effectiveCustomDomain,
      proxyType: effectiveProxyType,
      serverAddress: effectiveServerAddress,
      serverPort: effectiveServerPort,
      remotePort: effectiveRemotePort,
      publicUrl: effectivePublicUrl,
    }, { signal });
    const startedController = result.controllerStarted ? result.controller : null;

    let browserPublicUrl;
    try {
      browserPublicUrl = normalizeBrowserReadyPublicUrl(result.publicUrl);
    } catch (error) {
      try {
        if (result.controller) {
          await tunnelService.stop(result.controller);
        }
      } catch (stopError) {
        throw new TunnelServiceError(
          'unsafe_public_url',
          `Tunnel did not provide a secure browser URL and termination failed: ${stopError instanceof Error ? stopError.message : String(stopError)}`
        );
      }
      throw error;
    }

    if (signal?.aborted) {
      if (startedController) {
        await tunnelService.stop(startedController);
      }
      throw new TunnelServiceError('startup_cancelled', 'Tunnel start was cancelled');
    }
    assertControllerStillActive(result.controller);

    if (provider === TUNNEL_PROVIDER_FRPC) {
      try {
        const metadata = result.providerMetadata || {};
        const persistedProxyType = metadata.proxyType
          || (result.request.customDomain ? 'http' : 'tcp');
        await upsertFrpcTunnelConfig({
          serverAddress: metadata.serverAddress ?? result.request.serverAddress,
          serverPort: metadata.serverPort ?? result.request.serverPort,
          proxyType: persistedProxyType,
          remotePort: persistedProxyType === 'tcp'
            ? (metadata.remotePort ?? result.request.remotePort)
            : undefined,
          publicUrl: persistedProxyType === 'tcp'
            ? (metadata.publicUrl ?? result.request.publicUrl)
            : undefined,
          customDomain: persistedProxyType === 'http'
            ? (metadata.customDomain ?? result.request.customDomain)
            : undefined,
          hostname: persistedProxyType === 'http'
            ? (metadata.hostname ?? result.request.hostname)
            : undefined,
          token: result.request.token,
        });
      } catch {
        try {
          if (startedController) {
            await tunnelService.stop(startedController);
          }
        } catch (stopError) {
          throw new TunnelServiceError(
            'config_persistence_failed',
            `FRPC connected, its private configuration could not be saved, and termination failed: ${stopError instanceof Error ? stopError.message : String(stopError)}`,
            { controllerReplaced: result.controllerReplaced === true }
          );
        }
        throw new TunnelServiceError(
          'config_persistence_failed',
          'FRPC connected, but its private configuration could not be saved',
          { controllerReplaced: result.controllerReplaced === true }
        );
      }
    }

    if (signal?.aborted) {
      if (startedController) {
        await tunnelService.stop(startedController);
      }
      throw new TunnelServiceError('startup_cancelled', 'Tunnel start was cancelled');
    }
    assertControllerStillActive(result.controller);

    console.log(`Tunnel active (${result.provider}): ${browserPublicUrl}`);
    return {
      publicUrl: browserPublicUrl,
      mode: result.activeMode,
      provider: result.provider,
      providerMetadata: result.providerMetadata,
      controllerReplaced: result.controllerReplaced === true,
      controller: result.controller,
      controllerStarted: result.controllerStarted === true,
    };
  };

  const createGenericModeChecks = ({ modeKey, requiredFields, doctorRequest, startupReady }: {
    modeKey: string;
    requiredFields: string[];
    doctorRequest: RouteDoctorRequest;
    startupReady: boolean;
  }) => {
    const checks: TunnelDoctorCheck[] = [
      {
        id: 'startup_readiness',
        label: 'Provider startup readiness',
        status: startupReady ? 'pass' : 'fail',
        detail: startupReady
          ? 'Provider dependency checks passed.'
          : 'Resolve provider checks before starting tunnels.',
      },
    ];

    for (const field of requiredFields) {
      const value = doctorRequest?.[field];
      const present = isString(value) ? value.trim().length > 0 : Boolean(value);
      checks.push({
        id: `requirement_${field}`,
        label: `Required: ${field}`,
        status: present ? 'pass' : 'fail',
        detail: present
          ? `${field} is configured.`
          : `${field} is required for ${modeKey}.`,
      });
    }

    const failures = checks.filter((entry) => entry.status === 'fail').length;
    const warnings = checks.filter((entry) => entry.status === 'warn').length;
    return {
      mode: modeKey,
      checks,
      summary: {
        ready: failures === 0,
        failures,
        warnings,
      },
      ready: failures === 0,
      blockers: checks
        .filter((entry) => entry.status === 'fail' && entry.id !== 'startup_readiness')
        .map((entry) => entry.detail || entry.label || entry.id),
    };
  };

  const runTunnelDoctor = async ({ providerId, modeFilter, doctorRequest }: {
    providerId: string;
    modeFilter: string | null;
    doctorRequest: RouteDoctorRequest;
  }) => {
    const provider = tunnelProviderRegistry.get(providerId);
    if (!provider) {
      throw new TunnelServiceError('provider_unsupported', `Unsupported tunnel provider: ${providerId}`);
    }

    const capabilities = provider.capabilities || {};
    const modeKeys = Array.isArray(capabilities.modes)
      ? capabilities.modes.map((entry) => entry?.key).filter((key) => key.length > 0)
      : [];

    if (modeFilter && !modeKeys.includes(modeFilter)) {
      throw new TunnelServiceError('mode_unsupported', `Provider '${providerId}' does not support mode '${modeFilter}'`);
    }

    if (provider.diagnose) {
      const diagnosed = await provider.diagnose({
        ...doctorRequest,
        mode: modeFilter || doctorRequest?.mode,
      }, {
        capabilities,
      });
      const providerChecks = Array.isArray(diagnosed?.providerChecks) ? diagnosed.providerChecks : [];
      const allModes = Array.isArray(diagnosed?.modes) ? diagnosed.modes : [];
      const modes = modeFilter ? allModes.filter((entry) => entry?.mode === modeFilter) : allModes;
      return {
        ok: true,
        provider: providerId,
        providerChecks,
        modes,
      };
    }

    const availability = await tunnelService.checkAvailability(providerId);
    const dependencyAvailable = Boolean(availability?.available);
    const providerChecks = [{
      id: 'dependency',
      label: 'Provider dependency',
      status: dependencyAvailable ? 'pass' : 'fail',
      detail: dependencyAvailable
        ? (availability?.version || 'available')
        : (availability?.message || 'Required provider dependency is unavailable.'),
    }];

    const targetModes = (Array.isArray(capabilities.modes) ? capabilities.modes : [])
      .filter((entry) => !modeFilter || entry?.key === modeFilter);
    const modes = targetModes.map((entry) => createGenericModeChecks({
      modeKey: entry.key,
      requiredFields: Array.isArray(entry?.requires) ? entry.requires : [],
      doctorRequest,
      startupReady: dependencyAvailable,
    }));

    return {
      ok: true,
      provider: providerId,
      providerChecks,
      modes,
    };
  };

  return {
    assertControllerStillActive,
    hasOwn,
    normalizeFrpcProxyType,
    normalizeRequestedMode,
    normalizeRequestedProvider,
    parsePort,
    resolveActiveNormalizedTunnelMode,
    resolveFrpcEndpoint,
    resolveNormalizedTunnelHost,
    resolvePreferredTunnelProvider,
    resolveSettingsFrpcEndpoint,
    runTunnelDoctor,
    startTunnelWithNormalizedRequest,
    trimmedText,
  };
};

export type TunnelRouteOperations = ReturnType<typeof createTunnelRouteOperations>;

export const createTunnelRoutesRuntime = (dependencies: TunnelRoutesDependencies) => {
  const scope = { ...dependencies };
  const operations = createTunnelRouteOperations(scope);
  return {
    registerRoutes: createTunnelHttpRegistrar(scope, operations),
    startTunnelWithNormalizedRequest: operations.startTunnelWithNormalizedRequest,
  };
};
