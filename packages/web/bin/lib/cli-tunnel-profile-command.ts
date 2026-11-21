import crypto from 'crypto';
import { EXIT_CODE, TunnelCliError } from './cli-errors.js';
import { findClosestMatch } from './cli-args.js';
import { discoverRunningInstances, resolveTunnelProviders } from './cli-lifecycle.js';
import {
  normalizeProfileProvider,
  normalizeProfileName,
  normalizeProfileHostname,
  normalizeProfileCustomDomain,
  normalizeProfilePublicHostname,
  normalizeProfilePublicUrl,
  normalizeProfileServerAddress,
  normalizeProfileServerPort,
  normalizeProfileRemotePort,
  normalizeProfileToken,
  resolveToken,
  redactProfileForOutput,
  redactProfilesForOutput,
  formatProfileTokenStatus,
  formatProfileEndpoint,
  persistTunnelProfilesToDisk,
  resolveProfileByName,
} from './cli-tunnel-profiles.js';
import { DEFAULT_TUNNEL_PROVIDER_CAPABILITIES } from './cli-tunnel-capabilities.js';
import {
  intro as clackIntro,
  outro as clackOutro,
  log as clackLog,
  confirm as clackConfirm,
  select as clackSelect,
  text as clackText,
  password as clackPassword,
  cancel as clackCancel,
  isCancel as clackIsCancel,
  isJsonMode,
  isQuietMode,
  canPrompt,
  printJson,
  logStatus,
  formatProviderWithIcon as clackFormatProviderWithIcon,
} from '../cli-output.js';
import type { TunnelProfile } from './cli-tunnel-profiles.js';
import type { ServeOptions } from './commands-serve.js';
import { isString } from '../../server/lib/shared/object-guards.js';
import type { TunnelCommandOptions, TunnelCommandDependencies } from './commands-tunnel.js';

export const TUNNEL_PROFILES_VERSION = 2;

export const FRPC_PROVIDER = 'frpc';

export const TUNNEL_PROVIDER_CAPABILITIES_BY_ID = new Map(
  DEFAULT_TUNNEL_PROVIDER_CAPABILITIES.map((capabilities) => [capabilities.provider, capabilities])
);

interface FrpcEndpointInput {
  remotePort?: number | undefined;
  publicUrl?: string | undefined;
  customDomain?: string | undefined;
  hostname?: string | undefined;
}

export type FrpcEndpoint =
  | { kind: 'tcp'; remotePort: number; publicUrl: string }
  | { kind: 'http'; customDomain: string; hostname: string };

type FrpcEndpointFields =
  | { remotePort: number; publicUrl: string }
  | { customDomain: string; hostname: string };

export function normalizeCliTunnelProvider(value: string | null | undefined) {
  if (value === undefined || value === null) {
    return '';
  }
  const provider = isString(value) ? value.trim().toLowerCase() : '';
  if (!provider || !TUNNEL_PROVIDER_CAPABILITIES_BY_ID.has(provider)) {
    throw new TunnelCliError(
      `Unsupported tunnel provider: ${provider || String(value) || '(empty)'}`,
      EXIT_CODE.USAGE_ERROR,
    );
  }
  return provider;
}

export function normalizeCliTunnelMode(value: string | null | undefined) {
  if (value === undefined || value === null) {
    return '';
  }
  const mode = isString(value) ? value.trim().toLowerCase() : '';
  const supported = DEFAULT_TUNNEL_PROVIDER_CAPABILITIES.some(
    (capabilities) => capabilities.modes?.some((entry) => entry?.key === mode)
  );
  if (!mode || !supported) {
    throw new TunnelCliError(
      `Unsupported tunnel mode: ${mode || String(value) || '(empty)'}`,
      EXIT_CODE.USAGE_ERROR,
    );
  }
  return mode;
}

export function assertCliProviderMode(provider: string, mode: string) {
  const capabilities = TUNNEL_PROVIDER_CAPABILITIES_BY_ID.get(provider);
  if (!capabilities?.modes?.some((entry) => entry?.key === mode)) {
    throw new TunnelCliError(
      `Provider '${provider}' does not support mode '${mode}'.`,
      EXIT_CODE.USAGE_ERROR,
    );
  }
}

export function createTunnelAutoStartOptions(options: Partial<TunnelCommandOptions>, overrides: ServeOptions = {}): ServeOptions {
  return {
    ...options,
    ...overrides,
    json: false,
    quiet: true,
    suppressQuietOutput: true,
    suppressUnsafePortWarning: true,
    suppressUiPasswordWarning: true,
    suppressStartupSummary: true,
  };
}

export function hasNonEmptyString(value: unknown): value is string {
  return isString(value) && value.trim().length > 0;
}

export function normalizeExplicitFrpcServerAddress(options: Pick<Partial<TunnelCommandOptions>, 'serverAddress'>) {
  const normalized = normalizeProfileServerAddress(options.serverAddress);
  if (options.serverAddress !== undefined && !normalized) {
    throw new TunnelCliError(
      'Invalid --frps-address. Provide an IP address or bare hostname without a scheme, port, or path.',
      EXIT_CODE.USAGE_ERROR,
    );
  }
  return normalized;
}

export function getFrpcEndpointKind({ remotePort, customDomain, hostname, publicUrl }: FrpcEndpointInput): 'tcp' | 'http' | null {
  const hasRemotePort = remotePort !== undefined && remotePort !== null;
  const hasCustomDomain = hasNonEmptyString(customDomain);
  const hasHostname = hasNonEmptyString(hostname);
  const hasPublicUrl = hasNonEmptyString(publicUrl);

  if (hasRemotePort && (hasCustomDomain || hasHostname)) {
    throw new TunnelCliError(
      'FRPC endpoint options are mutually exclusive: use --remote-port for TCP or --custom-domain with --hostname for HTTP, not both.',
      EXIT_CODE.USAGE_ERROR,
    );
  }
  if (hasPublicUrl && (hasCustomDomain || hasHostname)) {
    throw new TunnelCliError(
      'FRPC endpoint options are mutually exclusive: use --remote-port with --public-url for TCP or --custom-domain with --hostname for HTTP, not both.',
      EXIT_CODE.USAGE_ERROR,
    );
  }
  if (hasRemotePort || hasPublicUrl) return 'tcp';
  if (hasCustomDomain || hasHostname) return 'http';
  return null;
}

export function normalizeFrpcEndpointOrThrow(endpoint: FrpcEndpointInput): FrpcEndpoint {
  const kind = getFrpcEndpointKind(endpoint);
  if (!kind) {
    throw new TunnelCliError(
      'FRPC requires exactly one endpoint: --remote-port <port> with --public-url <https-origin> for TCP, or --custom-domain <hostname> with --hostname <hostname> for HTTP.',
      EXIT_CODE.USAGE_ERROR,
    );
  }

  if (kind === 'tcp') {
    const remotePort = normalizeProfileRemotePort(endpoint.remotePort);
    if (!remotePort) {
      throw new TunnelCliError('--remote-port must be between 1 and 65535.', EXIT_CODE.USAGE_ERROR);
    }
    const publicUrl = normalizeProfilePublicUrl(endpoint.publicUrl);
    if (!publicUrl) {
      throw new TunnelCliError(
        'FRPC TCP requires --public-url with an origin-only https:// URL whose TLS endpoint forwards to the FRPS remote port.',
        EXIT_CODE.USAGE_ERROR,
      );
    }
    return { kind, remotePort, publicUrl };
  }

  if (!hasNonEmptyString(endpoint.customDomain) || !hasNonEmptyString(endpoint.hostname)) {
    throw new TunnelCliError(
      'FRPC HTTP endpoint requires both --custom-domain <hostname> and --hostname <hostname>.',
      EXIT_CODE.USAGE_ERROR,
    );
  }
  const customDomain = normalizeProfileCustomDomain(endpoint.customDomain);
  if (!customDomain) {
    throw new TunnelCliError(
      'Invalid FRPC custom domain. Provide a bare hostname with --custom-domain <hostname>.',
      EXIT_CODE.USAGE_ERROR,
    );
  }
  const hostname = normalizeProfilePublicHostname(endpoint.hostname);
  if (!hostname) {
    throw new TunnelCliError(
      'Invalid FRPC public hostname. Provide a bare hostname with --hostname <hostname>.',
      EXIT_CODE.USAGE_ERROR,
    );
  }
  return { kind, customDomain, hostname };
}

export function getFrpcEndpointFields(endpoint: FrpcEndpoint): FrpcEndpointFields {
  return endpoint.kind === 'tcp'
    ? { remotePort: endpoint.remotePort, publicUrl: endpoint.publicUrl }
    : { customDomain: endpoint.customDomain, hostname: endpoint.hostname };
}

export function resolveFrpcEndpointInput(
  options: FrpcEndpointInput,
  profile: TunnelProfile | null | undefined,
): FrpcEndpointInput {
  const hasRemotePortOverride = options.remotePort !== undefined && options.remotePort !== null;
  const hasPublicUrlOverride = hasNonEmptyString(options.publicUrl);
  const hasCustomDomainOverride = hasNonEmptyString(options.customDomain);
  const hasHostnameOverride = hasNonEmptyString(options.hostname);
  const hasEndpointOverride = hasRemotePortOverride || hasPublicUrlOverride || hasCustomDomainOverride || hasHostnameOverride;

  if (!profile || !hasEndpointOverride) {
    const source = profile || options;
    return {
      remotePort: source.remotePort,
      publicUrl: source.publicUrl,
      customDomain: source.customDomain,
      hostname: source.hostname,
    };
  }

  if (hasRemotePortOverride || hasPublicUrlOverride) {
    const profileIsTcp = profile.remotePort !== undefined && profile.remotePort !== null;
    return {
      remotePort: hasRemotePortOverride ? options.remotePort : (profileIsTcp ? profile.remotePort : undefined),
      publicUrl: hasPublicUrlOverride ? options.publicUrl : (profileIsTcp ? profile.publicUrl : undefined),
      customDomain: hasCustomDomainOverride ? options.customDomain : undefined,
      hostname: hasHostnameOverride ? options.hostname : undefined,
    };
  }

  const profileIsHttp = hasNonEmptyString(profile.customDomain) && hasNonEmptyString(profile.hostname);
  return {
    remotePort: undefined,
    publicUrl: undefined,
    customDomain: hasCustomDomainOverride
      ? options.customDomain
      : (profileIsHttp ? profile.customDomain : undefined),
    hostname: hasHostnameOverride
      ? options.hostname
      : (profileIsHttp ? profile.hostname : undefined),
  };
}

export async function promptForFrpcEndpoint({
  options,
  input,
  existingProfile,
  cancellationMessage,
}: {
  options: TunnelCommandOptions;
  input: FrpcEndpointInput;
  existingProfile: TunnelProfile | null | undefined;
  cancellationMessage: string;
}): Promise<FrpcEndpoint | null> {
  let { remotePort, publicUrl, customDomain, hostname } = input;
  let kind = getFrpcEndpointKind({ remotePort, publicUrl, customDomain, hostname });

  if (!kind && canPrompt(options)) {
    const existingKind: 'tcp' | 'http' = hasNonEmptyString(existingProfile?.customDomain) ? 'http' : 'tcp';
    const selectedKind = await clackSelect<'tcp' | 'http'>({
      message: 'Select FRPC endpoint type',
      options: [
        { value: 'tcp', label: 'TCP port mapping', hint: 'Expose server-address:remote-port' },
        { value: 'http', label: 'HTTP vhost', hint: 'Route a custom domain to a public hostname' },
      ],
      initialValue: existingKind,
    });
    if (isPromptCancelled(selectedKind)) {
      clackCancel(cancellationMessage);
      return null;
    }
    kind = selectedKind;
  }

  if (kind === 'tcp') {
    customDomain = undefined;
    hostname = undefined;
    if (remotePort === undefined && canPrompt(options)) {
      const enteredPort = await clackText({
        message: 'FRPS remote mapping port',
        placeholder: String(existingProfile?.remotePort || 18080),
        initialValue: String(existingProfile?.remotePort || 18080),
        validate(value) {
          return normalizeProfileRemotePort(value) ? undefined : 'Port must be between 1 and 65535.';
        },
      });
      if (isPromptCancelled(enteredPort)) {
        clackCancel(cancellationMessage);
        return null;
      }
      remotePort = normalizeProfileRemotePort(enteredPort);
    }
    if (!hasNonEmptyString(publicUrl) && canPrompt(options)) {
      const suggestedPublicUrl = existingProfile?.publicUrl || `https://app.example.com:${remotePort || 18080}`;
      const enteredPublicUrl = await clackText({
        message: 'Externally TLS-terminated public HTTPS URL',
        placeholder: suggestedPublicUrl,
        initialValue: suggestedPublicUrl,
        validate(value) {
          return normalizeProfilePublicUrl(value) ? undefined : 'An origin-only https:// URL is required.';
        },
      });
      if (isPromptCancelled(enteredPublicUrl)) {
        clackCancel(cancellationMessage);
        return null;
      }
      publicUrl = enteredPublicUrl;
    }
  } else if (kind === 'http') {
    remotePort = undefined;
    publicUrl = undefined;
    if (!hasNonEmptyString(customDomain) && canPrompt(options)) {
      const suggestedCustomDomain = existingProfile?.customDomain || 'openchamber.internal';
      const enteredCustomDomain = await clackText({
        message: 'FRPC HTTP-vhost custom domain',
        placeholder: suggestedCustomDomain,
        initialValue: suggestedCustomDomain,
        validate(value) {
          return normalizeProfileCustomDomain(value) ? undefined : 'A valid bare hostname is required.';
        },
      });
      if (isPromptCancelled(enteredCustomDomain)) {
        clackCancel(cancellationMessage);
        return null;
      }
      customDomain = enteredCustomDomain;
    }

    if (!hasNonEmptyString(hostname) && canPrompt(options)) {
      const suggestedHostname = existingProfile?.hostname || 'app.example.com';
      const enteredHostname = await clackText({
        message: 'External public hostname',
        placeholder: suggestedHostname,
        initialValue: suggestedHostname,
        validate(value) {
          return normalizeProfilePublicHostname(value) ? undefined : 'A valid bare hostname is required.';
        },
      });
      if (isPromptCancelled(enteredHostname)) {
        clackCancel(cancellationMessage);
        return null;
      }
      hostname = enteredHostname;
    }
  }

  return normalizeFrpcEndpointOrThrow({ remotePort, publicUrl, customDomain, hostname });
}

export function isPromptCancelled<Value>(value: Value | symbol): value is symbol {
  return clackIsCancel(value);
}

export async function handleTunnelProfileSubcommand(
  options: TunnelCommandOptions,
  action: string | null | undefined,
  { boldText, ensureTunnelProfilesMigrated }: Pick<TunnelCommandDependencies, 'boldText' | 'ensureTunnelProfilesMigrated'>,
) {
  const sub = isString(action) ? action.trim().toLowerCase() : '';
  const requestedProvider = normalizeCliTunnelProvider(options.provider);
  const store = ensureTunnelProfilesMigrated();

  if (!sub) {
    if (isJsonMode(options)) {
      printJson({
        command: 'tunnel profile',
        subcommands: ['list', 'show', 'add', 'remove'],
      });
      return;
    }

    if (!isQuietMode(options)) {
      clackIntro('Tunnel Profile');
      logStatus('info', 'Available subcommands', 'list, show, add, remove');
      clackLog.step('List profiles: `openchamber tunnel profile list`');
      clackLog.step('Show one profile: `openchamber tunnel profile show --name <name>`');
      clackLog.step('Add profile: `openchamber tunnel profile add --provider cloudflare --mode managed-remote --name <name> --hostname <host> --token-file <path>`');
      clackLog.step('Remove profile: `openchamber tunnel profile remove --name <name>`');
      clackOutro('Choose a subcommand');
    }
    return;
  }

  if (sub === 'list') {
    const providerFilter = requestedProvider;
    const profiles = providerFilter
      ? store.profiles.filter((entry) => entry.provider === providerFilter)
      : store.profiles;
    if (isJsonMode(options)) {
      printJson({ profiles: redactProfilesForOutput(profiles) });
      return;
    }

    if (isQuietMode(options)) {
      for (const profile of profiles) {
        process.stdout.write(`${profile.name} ${profile.provider}/${profile.mode} ${formatProfileEndpoint(profile)}\n`);
      }
      return;
    }

    clackIntro('Tunnel Profiles');
    for (const profile of profiles) {
      logStatus('success', `${profile.name} (${profile.provider}/${profile.mode})`, `${formatProfileEndpoint(profile)} ${formatProfileTokenStatus(profile)}`);
    }
    clackOutro(`${profiles.length} profile(s)`);
    return;
  }

  if (sub === 'show') {
    const name = normalizeProfileName(options.name);
    if (!name) {
      throw new Error('`tunnel profile show` requires --name <name>.');
    }
    const { profile, error } = resolveProfileByName(store.profiles, name, requestedProvider);
    if (!profile) {
      throw new Error(error);
    }
    if (isJsonMode(options)) {
      printJson({ profile: redactProfileForOutput(profile) });
      return;
    }
    if (isQuietMode(options)) {
      process.stdout.write(`${profile.name} ${profile.provider}/${profile.mode} ${formatProfileEndpoint(profile)} ${formatProfileTokenStatus(profile)}\n`);
      return;
    }
    clackIntro('Tunnel Profile');
    logStatus('success', `${profile.name} (${profile.provider}/${profile.mode})`, `${formatProfileEndpoint(profile)} ${formatProfileTokenStatus(profile)}`);
    clackOutro('show complete');
    return;
  }

  if (sub === 'add') {
    let provider = requestedProvider;
    let mode = normalizeCliTunnelMode(options.mode);
    let name = normalizeProfileName(options.name);
    let hostname = normalizeProfileHostname(options.hostname);
    let publicUrl = isString(options.publicUrl) ? options.publicUrl : undefined;
    let customDomain = isString(options.customDomain) ? options.customDomain : undefined;
    let serverAddress = normalizeExplicitFrpcServerAddress(options);
    let serverPort = normalizeProfileServerPort(options.serverPort);
    let remotePort = normalizeProfileRemotePort(options.remotePort);
    let frpcEndpoint: FrpcEndpoint | null = null;
    const resolvedTokenValue = resolveToken(options);
    let token = normalizeProfileToken(resolvedTokenValue);

    if (canPrompt(options)) {
      if (!provider) {
        const providerResult = await resolveTunnelProviders(options, {
          readPorts: async () => (await discoverRunningInstances()).map((entry) => entry.port),
        });
        const providerOptions = (Array.isArray(providerResult.providers) ? providerResult.providers : [])
          .map((entry) => normalizeProfileProvider(entry?.provider))
          .filter(Boolean)
          .map((providerId) => ({ value: providerId, label: clackFormatProviderWithIcon(providerId) }));

        if (providerOptions.length === 1 && providerOptions[0]) {
          provider = providerOptions[0].value;
        } else if (providerOptions.length > 1) {
          const selectedProvider = await clackSelect({
            message: 'Select tunnel provider',
            options: providerOptions,
          });
          if (isPromptCancelled(selectedProvider)) {
            clackCancel('Profile add cancelled.');
            return;
          }
          provider = normalizeProfileProvider(selectedProvider);
        }
      }

      if (!mode) {
        mode = 'managed-remote';
      }

      if (!name) {
        const enteredName = await clackText({
          message: 'Profile name (Enter to accept/edit)',
          placeholder: 'prod-main',
          initialValue: 'prod-main',
          validate(value) {
            return normalizeProfileName(value).length > 0 ? undefined : 'Profile name is required.';
          },
        });
        if (isPromptCancelled(enteredName)) {
          clackCancel('Profile add cancelled.');
          return;
        }
        name = normalizeProfileName(enteredName);
      }

      const existingProfile = provider && name
        ? store.profiles.find((entry) => entry.provider === provider && entry.name.toLowerCase() === name.toLowerCase())
        : null;

      if (provider === FRPC_PROVIDER && isString(options.token) && options.token.trim().length > 0) {
        throw new TunnelCliError(
          'FRPC tokens cannot be passed with --token. Use --token-file, --token-stdin, or the interactive password prompt.',
          EXIT_CODE.USAGE_ERROR,
        );
      }

      if (provider === FRPC_PROVIDER && !serverAddress) {
        const enteredAddress = await clackText({
          message: 'FRPS server IP address or hostname',
          placeholder: '203.0.113.10',
          validate(value) {
            return normalizeProfileServerAddress(value) ? undefined : 'A valid FRPS server address is required.';
          },
        });
        if (isPromptCancelled(enteredAddress)) {
          clackCancel('Profile add cancelled.');
          return;
        }
        serverAddress = normalizeProfileServerAddress(enteredAddress);
      }

      if (provider === FRPC_PROVIDER && !serverPort) {
        const enteredPort = await clackText({
          message: 'FRPS control port',
          placeholder: String(existingProfile?.serverPort || 7000),
          initialValue: String(existingProfile?.serverPort || 7000),
          validate(value) {
            return normalizeProfileServerPort(value) ? undefined : 'Port must be between 1 and 65535.';
          },
        });
        if (isPromptCancelled(enteredPort)) {
          clackCancel('Profile add cancelled.');
          return;
        }
        serverPort = normalizeProfileServerPort(enteredPort);
      }

      if (provider === FRPC_PROVIDER) {
        frpcEndpoint = await promptForFrpcEndpoint({
          options,
          input: { remotePort, publicUrl, customDomain, hostname },
          existingProfile,
          cancellationMessage: 'Profile add cancelled.',
        });
        if (!frpcEndpoint) return;
        if (frpcEndpoint.kind === 'tcp') {
          remotePort = frpcEndpoint.remotePort;
          publicUrl = frpcEndpoint.publicUrl;
          customDomain = undefined;
          hostname = '';
        } else {
          remotePort = undefined;
          publicUrl = undefined;
          customDomain = frpcEndpoint.customDomain;
          hostname = frpcEndpoint.hostname;
        }
      }

      if (provider !== FRPC_PROVIDER && !hostname) {
        const enteredHostname = await clackText({
          message: 'Tunnel hostname (Enter to accept/edit)',
          placeholder: existingProfile?.hostname || 'app.example.com',
          initialValue: existingProfile?.hostname || 'app.example.com',
          validate(value) {
            return normalizeProfileHostname(value).length > 0 ? undefined : 'Hostname is required.';
          },
        });
        if (isPromptCancelled(enteredHostname)) {
          clackCancel('Profile add cancelled.');
          return;
        }
        hostname = normalizeProfileHostname(enteredHostname);
      }

      if (!token && existingProfile?.token) {
        const useExistingToken = await clackConfirm({
          message: `Reuse saved token for profile '${existingProfile.name}'?`,
          initialValue: true,
        });
        if (isPromptCancelled(useExistingToken)) {
          clackCancel('Profile add cancelled.');
          return;
        }
        if (useExistingToken) {
          token = existingProfile.token;
        }
      }
    }

    if (provider === FRPC_PROVIDER && isString(options.token) && options.token.trim().length > 0) {
      throw new TunnelCliError(
        'FRPC tokens cannot be passed with --token. Use --token-file, --token-stdin, or the interactive password prompt.',
        EXIT_CODE.USAGE_ERROR,
      );
    }
    if (provider === FRPC_PROVIDER && !frpcEndpoint) {
      frpcEndpoint = normalizeFrpcEndpointOrThrow({ remotePort, publicUrl, customDomain, hostname });
      if (frpcEndpoint.kind === 'tcp') {
        remotePort = frpcEndpoint.remotePort;
        publicUrl = frpcEndpoint.publicUrl;
        customDomain = undefined;
        hostname = '';
      } else {
        remotePort = undefined;
        publicUrl = undefined;
        customDomain = frpcEndpoint.customDomain;
        hostname = frpcEndpoint.hostname;
      }
    }
    const endpointReady = provider === FRPC_PROVIDER
      ? Boolean(serverAddress && serverPort !== undefined && frpcEndpoint)
      : Boolean(hostname);
    if (!provider || !mode || !name || !endpointReady) {
      throw new Error(provider === FRPC_PROVIDER
        ? '`tunnel profile add` requires --provider frpc, --name, --frps-address, --frps-port, and one FRPC endpoint.'
        : '`tunnel profile add` requires --provider, --mode managed-remote, --name, and --hostname.');
    }

    if (!token) {
      if (canPrompt(options)) {
        const entered = await clackPassword({
          message: `Enter tunnel token for profile '${name}'`,
        });
        if (isPromptCancelled(entered) || !entered || !entered.trim()) {
          clackCancel('Profile add cancelled.');
          return;
        }
        token = normalizeProfileToken(entered.trim());
      }
      if (!token) {
        throw new Error('`tunnel profile add` requires a token (--token-file, --token-stdin, or interactive prompt).');
      }
    }
    if (mode !== 'managed-remote') {
      throw new Error('`tunnel profile add` currently supports only --mode managed-remote.');
    }
    assertCliProviderMode(provider, mode);
    const profileEndpointFields: Pick<TunnelProfile, 'hostname' | 'customDomain' | 'publicUrl' | 'serverAddress' | 'serverPort' | 'remotePort'> =
      provider === FRPC_PROVIDER && frpcEndpoint && serverPort !== undefined
        ? { serverAddress, serverPort, ...getFrpcEndpointFields(frpcEndpoint) }
        : { hostname };

    const existingIndex = store.profiles.findIndex(
      (entry) => entry.provider === provider && entry.name.toLowerCase() === name.toLowerCase()
    );

    if (existingIndex >= 0 && !options.force && !options.dryRun) {
      if (canPrompt(options)) {
        const shouldOverwrite = await clackConfirm({
          message: `Profile '${name}' already exists for provider '${provider}'. Overwrite?`,
        });
        if (isPromptCancelled(shouldOverwrite) || !shouldOverwrite) {
          clackCancel('Profile add cancelled.');
          return;
        }
      } else {
        throw new Error(`Profile '${name}' already exists for provider '${provider}'. Use --force to overwrite.`);
      }
    }

    if (options.dryRun) {
      const dryRunResult = {
        ok: true,
        dryRun: true,
        action: existingIndex >= 0 ? 'overwrite' : 'create',
        profile: redactProfileForOutput({
          name,
          provider,
          mode,
          ...profileEndpointFields,
          token,
        }),
      };
      if (isJsonMode(options)) {
        printJson(dryRunResult);
      } else if (!isQuietMode(options)) {
        clackIntro('Tunnel Profile Add (dry-run)');
        logStatus('info', `Would ${existingIndex >= 0 ? 'overwrite' : 'create'}: ${name} (${provider}/${mode})`, `${formatProfileEndpoint({ provider, ...profileEndpointFields })} ${formatProfileTokenStatus({ token })}`);
        clackOutro('dry-run complete (no changes applied)');
      }
      return;
    }

    const next = [...store.profiles];
    const now = Date.now();
    const current = existingIndex >= 0 ? next[existingIndex] : undefined;
    if (current) {
      next[existingIndex] = {
        id: current.id,
        name,
        provider,
        mode,
        ...profileEndpointFields,
        token,
        createdAt: current.createdAt,
        updatedAt: now,
      };
    } else {
      next.push({
        id: crypto.randomUUID(),
        name,
        provider,
        mode,
        ...profileEndpointFields,
        token,
        createdAt: now,
        updatedAt: now,
      });
    }

    const persisted = { version: TUNNEL_PROFILES_VERSION, profiles: next };
    persistTunnelProfilesToDisk(persisted);
    const added = persisted.profiles.find((entry) => entry.provider === provider && entry.name.toLowerCase() === name.toLowerCase());

    if (isJsonMode(options)) {
      printJson({ ok: true, profile: redactProfileForOutput(added) });
      return;
    }

    if (added === undefined) {
      throw new TypeError("Cannot read properties of undefined (reading 'name')");
    }

    if (isQuietMode(options)) {
      process.stdout.write(`saved ${added.name} ${added.provider}/${added.mode} ${formatProfileEndpoint(added)}\n`);
      return;
    }

    console.log('');
    clackIntro(boldText('Tunnel Profile Saved'));
    logStatus('success', `${added.name} (${added.provider}/${added.mode})`, `${formatProfileEndpoint(added)} ${formatProfileTokenStatus(added)}`);
    clackOutro('save complete');
    logStatus('info', '[START_PROFILE]', `openchamber tunnel start --profile ${added.name}`);
    clackOutro('');
    return;
  }

  if (sub === 'remove') {
    const name = normalizeProfileName(options.name);
    if (!name) {
      throw new Error('`tunnel profile remove` requires --name <name>.');
    }
    const { profile, error } = resolveProfileByName(store.profiles, name, requestedProvider);
    if (!profile) {
      throw new Error(error);
    }

    const next = store.profiles.filter((entry) => entry.id !== profile.id);
    const persisted = { version: TUNNEL_PROFILES_VERSION, profiles: next };
    persistTunnelProfilesToDisk(persisted);

    if (isJsonMode(options)) {
      printJson({ ok: true, removed: redactProfileForOutput(profile) });
      return;
    }

    if (isQuietMode(options)) {
      process.stdout.write(`removed ${profile.name} ${profile.provider}/${profile.mode} ${formatProfileEndpoint(profile)}\n`);
      return;
    }

    clackIntro('Tunnel Profile Removed');
    logStatus('success', `${profile.name} (${profile.provider}/${profile.mode})`, formatProfileEndpoint(profile));
    clackOutro('remove complete');
    return;
  }

  const knownProfileActions = ['list', 'show', 'add', 'remove'];
  const suggestion = findClosestMatch(sub, knownProfileActions);
  const hint = suggestion ? ` Did you mean '${suggestion}'?` : '';
  throw new TunnelCliError(
    `Unknown tunnel profile subcommand '${sub}'.${hint} Use 'openchamber tunnel help'.`,
    EXIT_CODE.USAGE_ERROR
  );
}
