import os from 'node:os';
import { isString } from './lib/shared/object-guards.js';
import { isNetworkExposedBindHost, readAdvertisedLanUrl } from './lib/security/bind-host.js';
import { relayBlockedByEnterprise } from './lib/relay/service.js';
import {
  normalizeOptionalPath,
  normalizeTunnelProvider,
  normalizeTunnelStartRequest,
  TUNNEL_MODE_QUICK,
  TUNNEL_PROVIDER_CLOUDFLARE,
  TUNNEL_PROVIDER_FRPC,
  TunnelServiceError,
} from './lib/tunnels/types.js';
import type { createTunnelProviderRegistry } from './lib/tunnels/registry.js';
import type { createSettingsNormalizationRuntime } from './lib/settings/settings-normalization-runtime.js';
import type { Request } from './lib/shared/http-contracts.js';
import type { WebUiServerOptions } from './runtime-options.js';

interface PairingTransportOptions {
  port: number;
  effectiveBindHost: string;
  getActivePort: () => number;
}

export function createPairingTransportResolver({ port, effectiveBindHost, getActivePort }: PairingTransportOptions) {
  const requestReachedLanAddress = (req: Request) => {
    const raw = isString(req?.socket?.localAddress) ? req.socket.localAddress : '';
    const address = raw.startsWith('::ffff:') ? raw.slice(7) : raw;
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(address)) return null;
    if (address.startsWith('127.')) return null;
    return address;
  };
  const advertisedLanUrl = readAdvertisedLanUrl();
  const resolvePairingTransports = (req: Request) => {
    const activePort = getActivePort() || port;
    const local = `http://127.0.0.1:${activePort}`;
    if (advertisedLanUrl) {
      return { local, lan: advertisedLanUrl, relayAvailable: !relayBlockedByEnterprise() };
    }
    let lanHost: string | null = null;
    if (isNetworkExposedBindHost(effectiveBindHost)) {
      lanHost = requestReachedLanAddress(req);
      try {
        if (!lanHost) {
          for (const list of Object.values(os.networkInterfaces())) {
            for (const entry of (list || [])) {
              if (entry.family === 'IPv4' && !entry.internal) { lanHost = entry.address; break; }
            }
            if (lanHost) break;
          }
        }
      } catch {
        lanHost = null;
      }
    } else {
      const h = String(effectiveBindHost || '').toLowerCase();
      if (h && h !== '127.0.0.1' && h !== 'localhost' && h !== '::1') lanHost = effectiveBindHost;
    }
    const lan = lanHost ? `http://${lanHost.includes(':') ? `[${lanHost}]` : lanHost}:${activePort}` : null;
    return { local, lan, relayAvailable: !relayBlockedByEnterprise() };
  };
  const resolveDirectLanUrls = (req: Request) => {
    if (advertisedLanUrl) return [advertisedLanUrl];
    const activePort = getActivePort() || port;
    const urls: string[] = [];
    const push = (host: string | null | undefined) => {
      if (!isString(host) || !host) return;
      const url = `http://${host.includes(':') ? `[${host}]` : host}:${activePort}`;
      if (!urls.includes(url)) urls.push(url);
    };
    if (isNetworkExposedBindHost(effectiveBindHost)) {
      push(requestReachedLanAddress(req));
      try {
        for (const list of Object.values(os.networkInterfaces())) {
          for (const entry of (list || [])) {
            if (entry.family === 'IPv4' && !entry.internal) push(entry.address);
          }
        }
      } catch {
        return urls;
      }
    } else {
      const h = String(effectiveBindHost || '').toLowerCase();
      if (h && h !== '127.0.0.1' && h !== 'localhost' && h !== '::1') push(effectiveBindHost);
    }
    return urls;
  };
  return { resolvePairingTransports, resolveDirectLanUrls };
}

export function resolveStartupTunnelRequest(
  options: WebUiServerOptions,
  tunnelProviderRegistry: ReturnType<typeof createTunnelProviderRegistry>,
  normalizeManagedRemoteTunnelHostname: ReturnType<typeof createSettingsNormalizationRuntime>['normalizeManagedRemoteTunnelHostname'],
) {
  const tryCfTunnel = options.tryCfTunnel === true;
  if (options.tunnelTrustedCaFile !== undefined) {
    throw new Error('tunnelTrustedCaFile is no longer supported. Install the CA into the host runtime trust store instead.');
  }
  const shouldUseCanonicalTunnelConfig = isString(options.tunnelMode)
    || isString(options.tunnelProvider)
    || options.tunnelConfigPath === null
    || isString(options.tunnelConfigPath)
    || isString(options.tunnelToken)
    || isString(options.tunnelHostname)
    || isString(options.tunnelPublicUrl)
    || isString(options.tunnelCustomDomain)
    || isString(options.tunnelServerAddress)
    || Number.isInteger(options.tunnelServerPort)
    || Number.isInteger(options.tunnelRemotePort);
  const startupTunnelProvider = shouldUseCanonicalTunnelConfig
    ? normalizeTunnelProvider(options.tunnelProvider, {
        strict: options.tunnelProvider !== undefined,
      })
    : null;
  const startupTunnelRequest = shouldUseCanonicalTunnelConfig
    ? normalizeTunnelStartRequest({
        provider: startupTunnelProvider,
        mode: options.tunnelMode,
        configPath: normalizeOptionalPath(options.tunnelConfigPath),
        token: isString(options.tunnelToken) ? options.tunnelToken.trim() : '',
        hostname: startupTunnelProvider === TUNNEL_PROVIDER_FRPC
          ? options.tunnelHostname
          : normalizeManagedRemoteTunnelHostname(options.tunnelHostname),
        publicUrl: options.tunnelPublicUrl,
        customDomain: options.tunnelCustomDomain,
        serverAddress: options.tunnelServerAddress,
        serverPort: options.tunnelServerPort,
        remotePort: options.tunnelRemotePort,
      })
    : (tryCfTunnel
      ? {
          provider: TUNNEL_PROVIDER_CLOUDFLARE,
          mode: TUNNEL_MODE_QUICK,
          configPath: undefined,
          token: '',
          hostname: undefined,
          publicUrl: undefined,
          customDomain: undefined,
          proxyType: undefined,
          serverAddress: undefined,
          serverPort: undefined,
          remotePort: undefined,
        }
      : null);
  if (startupTunnelRequest) {
    const startupCapabilities = tunnelProviderRegistry.get(startupTunnelRequest.provider)?.capabilities;
    if (!startupCapabilities) {
      throw new TunnelServiceError(
        'provider_unsupported',
        `Unsupported tunnel provider: ${startupTunnelRequest.provider}`
      );
    }
    if (!startupCapabilities.modes?.some((entry) => entry?.key === startupTunnelRequest.mode)) {
      throw new TunnelServiceError(
        'mode_unsupported',
        `Provider '${startupTunnelRequest.provider}' does not support mode '${startupTunnelRequest.mode}'`
      );
    }
  }
  return startupTunnelRequest;
}
