import os from 'os';
import path from 'path';

export const TUNNEL_PROVIDER_CLOUDFLARE = 'cloudflare';
export const TUNNEL_PROVIDER_FRPC = 'frpc';
export const TUNNEL_PROVIDER_NGROK = 'ngrok';

export const TUNNEL_MODE_QUICK = 'quick';
export const TUNNEL_MODE_MANAGED_REMOTE = 'managed-remote';
export const TUNNEL_MODE_MANAGED_LOCAL = 'managed-local';

export const TUNNEL_INTENT_EPHEMERAL_PUBLIC = 'ephemeral-public';
export const TUNNEL_INTENT_PERSISTENT_PUBLIC = 'persistent-public';
const TUNNEL_INTENT_PRIVATE_NETWORK = 'private-network';

const SUPPORTED_TUNNEL_INTENTS = new Set([
  TUNNEL_INTENT_EPHEMERAL_PUBLIC,
  TUNNEL_INTENT_PERSISTENT_PUBLIC,
  TUNNEL_INTENT_PRIVATE_NETWORK,
]);

const SUPPORTED_TUNNEL_MODES = new Set([
  TUNNEL_MODE_QUICK,
  TUNNEL_MODE_MANAGED_REMOTE,
  TUNNEL_MODE_MANAGED_LOCAL,
]);

export class TunnelServiceError extends Error {
  constructor(code, message, details = null) {
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
]);

const getPathApiForPlatform = (platform) => (platform === 'win32' ? path.win32 : path);

export function isPathWithinDirectory(candidatePath, directoryPath, platform = process.platform) {
  if (typeof candidatePath !== 'string' || typeof directoryPath !== 'string') {
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

export function resolveTunnelConfigPath(value, home = os.homedir(), platform = process.platform) {
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

export function normalizeTunnelProvider(value, { strict = false } = {}) {
  const provider = typeof value === 'string' ? value.trim().toLowerCase() : '';
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

export function normalizeTunnelMode(value, {
  strict = false,
  defaultMode = TUNNEL_MODE_QUICK,
} = {}) {
  const mode = typeof value === 'string' ? value.trim().toLowerCase() : '';
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

function normalizeTunnelIntent(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const intent = value.trim().toLowerCase();
  if (!intent || !SUPPORTED_TUNNEL_INTENTS.has(intent)) {
    return undefined;
  }
  return intent;
}

function modeIntentFallback(mode) {
  if (mode === TUNNEL_MODE_QUICK) {
    return TUNNEL_INTENT_EPHEMERAL_PUBLIC;
  }
  if (mode === TUNNEL_MODE_MANAGED_REMOTE || mode === TUNNEL_MODE_MANAGED_LOCAL) {
    return TUNNEL_INTENT_PERSISTENT_PUBLIC;
  }
  return undefined;
}

export function normalizeOptionalPath(value) {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return resolveTunnelConfigPath(trimmed);
}

export function isSupportedTunnelMode(mode) {
  return SUPPORTED_TUNNEL_MODES.has(mode);
}

export function normalizeTunnelStartRequest(input = {}, defaults = {}) {
  const providerExplicit = input.provider !== undefined || defaults.provider !== undefined;
  const providerValue = input.provider !== undefined ? input.provider : defaults.provider;
  const provider = normalizeTunnelProvider(providerValue, { strict: providerExplicit });
  const modeExplicit = input.mode !== undefined || defaults.mode !== undefined;
  const modeValue = input.mode !== undefined ? input.mode : defaults.mode;
  const mode = normalizeTunnelMode(modeValue, {
    strict: modeExplicit,
    defaultMode: provider === TUNNEL_PROVIDER_FRPC ? TUNNEL_MODE_MANAGED_REMOTE : TUNNEL_MODE_QUICK,
  });
  const explicitIntent = normalizeTunnelIntent(input.intent ?? defaults.intent);
  const intent = explicitIntent ?? modeIntentFallback(mode);
  const configPathValue = Object.prototype.hasOwnProperty.call(input, 'configPath')
    ? input.configPath
    : defaults.configPath;
  const configPath = normalizeOptionalPath(configPathValue);

  const token = typeof (input.token ?? defaults.token) === 'string'
    ? (input.token ?? defaults.token).trim()
    : '';

  const hostname = typeof (input.hostname ?? defaults.hostname) === 'string'
    ? (input.hostname ?? defaults.hostname).trim().toLowerCase()
    : '';

  const customDomain = typeof (input.customDomain ?? defaults.customDomain) === 'string'
    ? (input.customDomain ?? defaults.customDomain).trim().toLowerCase()
    : '';

  const publicUrl = typeof (input.publicUrl ?? defaults.publicUrl) === 'string'
    ? (input.publicUrl ?? defaults.publicUrl).trim()
    : '';

  const proxyType = typeof (input.proxyType ?? defaults.proxyType) === 'string'
    ? (input.proxyType ?? defaults.proxyType).trim().toLowerCase()
    : undefined;

  const serverAddress = typeof (input.serverAddress ?? defaults.serverAddress) === 'string'
    ? (input.serverAddress ?? defaults.serverAddress).trim()
    : '';
  const normalizeRequestPort = (value) => {
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value);
      return Number.isInteger(parsed) ? parsed : undefined;
    }
    return Number.isInteger(value) ? value : undefined;
  };
  const serverPort = normalizeRequestPort(input.serverPort ?? defaults.serverPort);
  const remotePort = normalizeRequestPort(input.remotePort ?? defaults.remotePort);
  const trustedCaFile = typeof (input.trustedCaFile ?? defaults.trustedCaFile) === 'string'
    ? (input.trustedCaFile ?? defaults.trustedCaFile).trim()
    : '';

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
    trustedCaFile,
  };
}

export function validateTunnelStartRequest(request, capabilities) {
  if (!request || typeof request !== 'object') {
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

  if (typeof request.intent === 'string' && request.intent.length > 0) {
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

  const requiredFields = Array.isArray(modeDescriptor.requires) ? modeDescriptor.requires : [];

  const requiredFieldLabels = {
    token: 'Managed remote tunnel token',
    hostname: 'Managed remote tunnel hostname',
    configPath: 'Tunnel config path',
    serverAddress: 'FRPS server address',
    serverPort: 'FRPS server port',
    remotePort: 'FRPS remote port',
    customDomain: 'FRPS custom domain',
    publicUrl: 'FRPC TCP public HTTPS URL',
    trustedCaFile: 'FRPS trusted CA file',
  };
  for (const field of requiredFields) {
    const value = request[field];
    const present = typeof value === 'string'
      ? value.trim().length > 0
      : (typeof value === 'number' ? Number.isFinite(value) : value !== undefined && value !== null);
    if (!present) {
      const label = requiredFieldLabels[field] || field;
      throw new TunnelServiceError('validation_error', `${label} is required`);
    }
  }

  if (request.provider === TUNNEL_PROVIDER_FRPC) {
    const hasRemotePort = request.remotePort !== undefined && request.remotePort !== null;
    const hasCustomDomain = typeof request.customDomain === 'string' && request.customDomain.trim().length > 0;
    const hasHostname = typeof request.hostname === 'string' && request.hostname.trim().length > 0;
    const hasPublicUrl = typeof request.publicUrl === 'string' && request.publicUrl.trim().length > 0;
    const proxyType = typeof request.proxyType === 'string' ? request.proxyType.trim().toLowerCase() : '';

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
