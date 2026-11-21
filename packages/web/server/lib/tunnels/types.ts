import os from 'os';
import path from 'path';
import { isNumber, isString } from '../shared/object-guards.js';
import type { JsonValue } from '../shared/json-values.js';

export interface TunnelStartInput {
  provider?: JsonValue | undefined;
  mode?: JsonValue | undefined;
  intent?: unknown;
  configPath?: unknown;
  token?: unknown;
  hostname?: unknown;
  httpsPort?: unknown;
  customDomain?: unknown;
  publicUrl?: unknown;
  proxyType?: unknown;
  serverAddress?: unknown;
  serverPort?: JsonValue | undefined;
  remotePort?: JsonValue | undefined;
}

export interface TunnelModeDescriptor {
  key: string;
  label?: string;
  intent?: string;
  requires?: string[];
  supports?: string[];
  proxyTypes?: string[];
  stability?: string;
  httpsPorts?: number[];
}

export interface TunnelCapabilities {
  provider: string;
  defaults?: {
    mode?: string;
    optionDefaults?: Record<string, JsonValue | undefined>;
  };
  modes: TunnelModeDescriptor[];
}

const isText = (value: unknown): value is string => typeof value === 'string';

export const TUNNEL_PROVIDER_CLOUDFLARE = 'cloudflare';
export const TUNNEL_PROVIDER_FRPC = 'frpc';
export const TUNNEL_PROVIDER_NGROK = 'ngrok';
export const TUNNEL_PROVIDER_TAILSCALE = 'tailscale';

export const TUNNEL_MODE_QUICK = 'quick';
export const TUNNEL_MODE_MANAGED_REMOTE = 'managed-remote';
export const TUNNEL_MODE_MANAGED_LOCAL = 'managed-local';
export const TUNNEL_MODE_SERVE = 'serve';
export const TUNNEL_MODE_FUNNEL = 'funnel';

export const TUNNEL_INTENT_EPHEMERAL_PUBLIC = 'ephemeral-public';
export const TUNNEL_INTENT_PERSISTENT_PUBLIC = 'persistent-public';
export const TUNNEL_INTENT_PRIVATE_NETWORK = 'private-network';

const SUPPORTED_TUNNEL_INTENTS = new Set([
  TUNNEL_INTENT_EPHEMERAL_PUBLIC,
  TUNNEL_INTENT_PERSISTENT_PUBLIC,
  TUNNEL_INTENT_PRIVATE_NETWORK,
]);

const SUPPORTED_TUNNEL_MODES = new Set([
  TUNNEL_MODE_QUICK,
  TUNNEL_MODE_MANAGED_REMOTE,
  TUNNEL_MODE_MANAGED_LOCAL,
  TUNNEL_MODE_SERVE,
  TUNNEL_MODE_FUNNEL,
]);

export interface TunnelServiceErrorDetails {
  approvalUrl?: string;
  controllerReplaced?: boolean;
  [key: string]: JsonValue | undefined;
}

export class TunnelServiceError extends Error {
  code: string;
  details: TunnelServiceErrorDetails | null;

  constructor(code: string, message: string, details: TunnelServiceErrorDetails | null = null) {
    super(message);
    this.name = 'TunnelServiceError';
    this.code = code;
    this.details = details;
  }
}

const SUPPORTED_TUNNEL_PROVIDERS = new Set([
  TUNNEL_PROVIDER_CLOUDFLARE,
  TUNNEL_PROVIDER_FRPC,
  TUNNEL_PROVIDER_NGROK,
  TUNNEL_PROVIDER_TAILSCALE,
]);

const getPathApiForPlatform = (platform: NodeJS.Platform) => (platform === 'win32' ? path.win32 : path);

export function isPathWithinDirectory(candidatePath: string, directoryPath: string, platform: NodeJS.Platform = process.platform) {
  if (!isText(candidatePath) || !isText(directoryPath)) {
    return false;
  }

  const pathApi = getPathApiForPlatform(platform);
  const resolvedCandidate = pathApi.resolve(candidatePath);
  const resolvedDirectory = pathApi.resolve(directoryPath);
  const comparableCandidate = platform === 'win32' ? resolvedCandidate.toLowerCase() : resolvedCandidate;
  const comparableDirectory = platform === 'win32' ? resolvedDirectory.toLowerCase() : resolvedDirectory;
  const directoryPrefix = comparableDirectory.endsWith(pathApi.sep)
    ? comparableDirectory
    : `${comparableDirectory}${pathApi.sep}`;

  return comparableCandidate === comparableDirectory || comparableCandidate.startsWith(directoryPrefix);
}

export function resolveTunnelConfigPath(value: string, home = os.homedir(), platform: NodeJS.Platform = process.platform) {
  const pathApi = getPathApiForPlatform(platform);
  let resolved;
  if (value === '~') {
    resolved = home;
  } else if (value.startsWith('~/') || value.startsWith('~\\')) {
    resolved = pathApi.join(home, value.slice(2));
  } else {
    resolved = pathApi.resolve(value);
  }

  if (!isPathWithinDirectory(resolved, home, platform)) {
    throw new TunnelServiceError(
      'validation_error',
      `Config path must be within the home directory (${home}). Got: ${resolved}`
    );
  }
  return resolved;
}

export function normalizeTunnelProvider(value: JsonValue | undefined, { strict = false }: { strict?: boolean } = {}) {
  const provider = isText(value) ? value.trim().toLowerCase() : '';
  if (provider && SUPPORTED_TUNNEL_PROVIDERS.has(provider)) {
    return provider;
  }
  if (strict) {
    throw new TunnelServiceError(
      'provider_unsupported',
      `Unsupported tunnel provider: ${provider || String(value ?? '') || '(empty)'}`
    );
  }
  return TUNNEL_PROVIDER_CLOUDFLARE;
}

export function normalizeTunnelMode(value: JsonValue | undefined, {
  strict = false,
  defaultMode = TUNNEL_MODE_QUICK,
}: { strict?: boolean; defaultMode?: string } = {}) {
  const mode = isText(value) ? value.trim().toLowerCase() : '';
  if (SUPPORTED_TUNNEL_MODES.has(mode)) {
    return mode;
  }
  if (strict) {
    throw new TunnelServiceError(
      'mode_unsupported',
      `Unsupported tunnel mode: ${mode || String(value ?? '') || '(empty)'}`
    );
  }
  return defaultMode;
}

function normalizeTunnelIntent(value: string | null | undefined) {
  if (!isText(value)) {
    return undefined;
  }
  const intent = value.trim().toLowerCase();
  if (!intent || !SUPPORTED_TUNNEL_INTENTS.has(intent)) {
    return undefined;
  }
  return intent;
}

function modeIntentFallback(mode: string) {
  if (mode === TUNNEL_MODE_QUICK) {
    return TUNNEL_INTENT_EPHEMERAL_PUBLIC;
  }
  if (mode === TUNNEL_MODE_MANAGED_REMOTE || mode === TUNNEL_MODE_MANAGED_LOCAL || mode === TUNNEL_MODE_FUNNEL) {
    return TUNNEL_INTENT_PERSISTENT_PUBLIC;
  }
  if (mode === TUNNEL_MODE_SERVE) {
    return TUNNEL_INTENT_PRIVATE_NETWORK;
  }
  return undefined;
}

export function normalizeOptionalPath(value: string | null | undefined) {
  if (value === null) {
    return null;
  }
  if (!isText(value)) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return resolveTunnelConfigPath(trimmed);
}

export function isSupportedTunnelMode(mode: string) {
  return SUPPORTED_TUNNEL_MODES.has(mode);
}

export function normalizeTunnelStartRequest(input: TunnelStartInput = {}, defaults: TunnelStartInput = {}) {
  const providerExplicit = input.provider !== undefined || defaults.provider !== undefined;
  const providerValue = input.provider !== undefined ? input.provider : defaults.provider;
  const provider = normalizeTunnelProvider(providerValue, { strict: providerExplicit });
  const modeExplicit = input.mode !== undefined || defaults.mode !== undefined;
  const modeValue = input.mode !== undefined ? input.mode : defaults.mode;
  const mode = normalizeTunnelMode(modeValue, {
    strict: modeExplicit,
    defaultMode: provider === TUNNEL_PROVIDER_FRPC ? TUNNEL_MODE_MANAGED_REMOTE : TUNNEL_MODE_QUICK,
  });
  const intentValue = input.intent ?? defaults.intent;
  const explicitIntent = normalizeTunnelIntent(isText(intentValue) ? intentValue : undefined);
  const intent = explicitIntent ?? modeIntentFallback(mode);
  const configPathValue = Object.prototype.hasOwnProperty.call(input, 'configPath')
    ? input.configPath
    : defaults.configPath;
  const configPath = normalizeOptionalPath(isText(configPathValue) || configPathValue === null ? configPathValue : undefined);

  const tokenValue = input.token ?? defaults.token;
  const token = isText(tokenValue)
    ? tokenValue.trim()
    : '';

  const hostnameValue = input.hostname ?? defaults.hostname;
  const hostname = isText(hostnameValue)
    ? hostnameValue.trim().toLowerCase()
    : '';

  const customDomainValue = input.customDomain ?? defaults.customDomain;
  const customDomain = isText(customDomainValue)
    ? customDomainValue.trim().toLowerCase()
    : '';

  const publicUrlValue = input.publicUrl ?? defaults.publicUrl;
  const publicUrl = isText(publicUrlValue)
    ? publicUrlValue.trim()
    : '';

  const proxyTypeValue = input.proxyType ?? defaults.proxyType;
  const proxyType = isText(proxyTypeValue)
    ? proxyTypeValue.trim().toLowerCase()
    : undefined;

  const serverAddressValue = input.serverAddress ?? defaults.serverAddress;
  const serverAddress = isText(serverAddressValue)
    ? serverAddressValue.trim()
    : '';

  const normalizeRequestPort = (value: JsonValue | undefined): number | undefined => {
    if (isText(value) && value.trim().length > 0) {
      const parsed = Number(value);
      return Number.isInteger(parsed) ? parsed : undefined;
    }
    return isNumber(value) && Number.isInteger(value) ? value : undefined;
  };
  const serverPort = normalizeRequestPort(input.serverPort ?? defaults.serverPort);
  const remotePort = normalizeRequestPort(input.remotePort ?? defaults.remotePort);

  const httpsPortValue = input.httpsPort ?? defaults.httpsPort;
  const httpsPortText = httpsPortValue === undefined || httpsPortValue === null || httpsPortValue === ''
    ? undefined
    : String(httpsPortValue).trim();
  const httpsPort = httpsPortText === undefined
    ? undefined
    : (/^\d+$/.test(httpsPortText) ? Number(httpsPortText) : Number.NaN);

  return {
    provider,
    mode,
    intent,
    configPath,
    token,
    hostname,
    customDomain,
    publicUrl,
    proxyType,
    serverAddress,
    serverPort,
    remotePort,
    httpsPort,
  };
}

export type TunnelStartRequest = ReturnType<typeof normalizeTunnelStartRequest>;

const isRequestObject = (value: unknown): value is TunnelStartInput => Boolean(value) && typeof value === 'object';

export function validateTunnelStartRequest(request: TunnelStartRequest, capabilities: TunnelCapabilities | null | undefined) {
  if (!isRequestObject(request)) {
    throw new TunnelServiceError('validation_error', 'Tunnel start request must be an object');
  }

  if (!request.provider) {
    throw new TunnelServiceError('validation_error', 'Tunnel provider is required');
  }

  if (!isSupportedTunnelMode(request.mode)) {
    throw new TunnelServiceError('mode_unsupported', `Unsupported tunnel mode: ${request.mode}`);
  }

  if (!capabilities || capabilities.provider !== request.provider) {
    throw new TunnelServiceError('provider_unsupported', `Unsupported tunnel provider: ${request.provider}`);
  }

  if (!Array.isArray(capabilities.modes)) {
    throw new TunnelServiceError('mode_unsupported', `Provider '${request.provider}' does not declare tunnel modes`);
  }

  const modeDescriptor = capabilities.modes.find((entry) => entry?.key === request.mode);
  if (!modeDescriptor) {
    throw new TunnelServiceError('mode_unsupported', `Provider '${request.provider}' does not support mode '${request.mode}'`);
  }

  if (isText(request.intent) && request.intent.length > 0) {
    if (!SUPPORTED_TUNNEL_INTENTS.has(request.intent)) {
      throw new TunnelServiceError('validation_error', `Unsupported tunnel intent: ${request.intent}`);
    }
    if (modeDescriptor.intent !== request.intent) {
      throw new TunnelServiceError(
        'validation_error',
        `Tunnel intent '${request.intent}' does not match mode '${request.mode}' (expected '${modeDescriptor.intent}')`
      );
    }
  }

  if (request.httpsPort !== undefined) {
    const allowedPorts = modeDescriptor.httpsPorts;
    if (!Array.isArray(allowedPorts)) {
      throw new TunnelServiceError('validation_error', `Provider '${request.provider}' does not take an HTTPS port`);
    }
    if (!allowedPorts.includes(request.httpsPort)) {
      throw new TunnelServiceError('validation_error', `HTTPS port must be one of ${allowedPorts.join(', ')}`);
    }
  }

  const requiredFields = Array.isArray(modeDescriptor.requires) ? modeDescriptor.requires : [];

  const requiredFieldLabels = new Map([
    ['token', 'Managed remote tunnel token'],
    ['hostname', 'Managed remote tunnel hostname'],
    ['configPath', 'Tunnel config path'],
    ['serverAddress', 'FRPS server address'],
    ['serverPort', 'FRPS server port'],
    ['remotePort', 'FRPS remote port'],
    ['customDomain', 'FRPS custom domain'],
    ['publicUrl', 'FRPC TCP public HTTPS URL'],
  ]);
  const readRequiredField = (field: string) => {
    switch (field) {
      case 'token': return request.token;
      case 'hostname': return request.hostname;
      case 'configPath': return request.configPath;
      case 'serverAddress': return request.serverAddress;
      case 'serverPort': return request.serverPort;
      case 'remotePort': return request.remotePort;
      case 'customDomain': return request.customDomain;
      case 'publicUrl': return request.publicUrl;
      case 'proxyType': return request.proxyType;
      case 'httpsPort': return request.httpsPort;
      default: return undefined;
    }
  };
  for (const field of requiredFields) {
    const value = readRequiredField(field);
    const present = isString(value)
      ? value.trim().length > 0
      : (isNumber(value) ? Number.isFinite(value) : value !== undefined && value !== null);
    if (!present) {
      const label = requiredFieldLabels.get(field) ?? field;
      throw new TunnelServiceError('validation_error', `${label} is required`);
    }
  }

  if (request.provider === TUNNEL_PROVIDER_FRPC) {
    const hasRemotePort = request.remotePort !== undefined && request.remotePort !== null;
    const hasCustomDomain = isString(request.customDomain) && request.customDomain.trim().length > 0;
    const hasHostname = isString(request.hostname) && request.hostname.trim().length > 0;
    const hasPublicUrl = isString(request.publicUrl) && request.publicUrl.trim().length > 0;
    const proxyType = isString(request.proxyType) ? request.proxyType.trim().toLowerCase() : '';

    if (proxyType && proxyType !== 'tcp' && proxyType !== 'http') {
      throw new TunnelServiceError('validation_error', `Unsupported FRPC proxy type: ${request.proxyType}`);
    }
    if (hasRemotePort && hasCustomDomain) {
      throw new TunnelServiceError('validation_error', 'FRPC remotePort and customDomain cannot be used together');
    }
    if (hasCustomDomain && hasPublicUrl) {
      throw new TunnelServiceError('validation_error', 'FRPC TCP publicUrl and HTTP customDomain cannot be used together');
    }
    if (proxyType === 'tcp' && hasCustomDomain) {
      throw new TunnelServiceError('validation_error', 'FRPC TCP proxies cannot use customDomain');
    }
    if (proxyType === 'http' && (hasRemotePort || hasPublicUrl)) {
      throw new TunnelServiceError('validation_error', 'FRPC HTTP proxies cannot use remotePort or publicUrl');
    }
    if ((proxyType === 'http' || hasCustomDomain) && !hasCustomDomain) {
      throw new TunnelServiceError('validation_error', 'FRPS custom domain is required for an HTTP proxy');
    }
    if (hasCustomDomain && !hasHostname) {
      throw new TunnelServiceError('validation_error', 'FRPC public hostname is required with customDomain');
    }
    if (!hasCustomDomain && !hasRemotePort) {
      throw new TunnelServiceError('validation_error', 'FRPS remote port or custom domain is required');
    }
    if (hasRemotePort && !hasPublicUrl) {
      throw new TunnelServiceError('validation_error', 'FRPC TCP public HTTPS URL is required with remotePort');
    }
  }
}
