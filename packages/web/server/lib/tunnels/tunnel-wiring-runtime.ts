import { printTunnelWarning } from '../cloudflare-tunnel.js';
import { createTunnelService } from './index.js';
import { createTunnelRoutesRuntime } from './routes.js';
import type { TunnelRoutesDependencies } from './routes.js';
import type { Application } from '../shared/http-contracts.js';

export type TunnelWiringDependencies = Omit<TunnelRoutesDependencies, 'tunnelService' | 'hasUiPassword' | 'getActivePort'> & {
  setActiveTunnelController: (value: ReturnType<TunnelRoutesDependencies['getActiveTunnelController']>) => void;
};

export const createTunnelWiringRuntime = (dependencies: TunnelWiringDependencies) => {
  const {
    crypto,
    URL,
    tunnelProviderRegistry,
    tunnelAuthController,
    readSettingsFromDiskMigrated,
    readManagedRemoteTunnelConfigFromDisk,
    readFrpcTunnelConfigFromDisk,
    normalizeTunnelProvider,
    normalizeTunnelMode,
    normalizeOptionalPath,
    normalizeManagedRemoteTunnelHostname,
    normalizeFrpcCustomDomain,
    normalizeFrpcPublicHostname,
    normalizeFrpcPublicUrl,
    normalizeTunnelBootstrapTtlMs,
    normalizeTunnelSessionTtlMs,
    isSupportedTunnelMode,
    upsertManagedRemoteTunnelToken,
    resolveManagedRemoteTunnelToken,
    upsertFrpcTunnelConfig,
    resolveFrpcTunnelToken,
    TUNNEL_MODE_QUICK,
    TUNNEL_MODE_MANAGED_LOCAL,
    TUNNEL_MODE_MANAGED_REMOTE,
    TUNNEL_PROVIDER_CLOUDFLARE,
    TUNNEL_PROVIDER_FRPC,
    TunnelServiceError,
    getActiveTunnelController,
    setActiveTunnelController,
    getRuntimeManagedRemoteTunnelHostname,
    setRuntimeManagedRemoteTunnelHostname,
    getRuntimeManagedRemoteTunnelToken,
    setRuntimeManagedRemoteTunnelToken,
  } = dependencies;

  const initialize = (app: Application, initialPort: number, hasUiPassword: boolean) => {
    let activePort = initialPort;

    const tunnelService = createTunnelService({
      registry: tunnelProviderRegistry,
      getController: getActiveTunnelController,
      setController: setActiveTunnelController,
      getActivePort: () => activePort,
      onQuickTunnelWarning: () => {
        printTunnelWarning();
      },
    });

    const tunnelRoutesRuntime = createTunnelRoutesRuntime({
      crypto,
      URL,
      tunnelService,
      tunnelProviderRegistry,
      tunnelAuthController,
      hasUiPassword,
      readSettingsFromDiskMigrated,
      readManagedRemoteTunnelConfigFromDisk,
      readFrpcTunnelConfigFromDisk,
      normalizeTunnelProvider,
      normalizeTunnelMode,
      normalizeOptionalPath,
      normalizeManagedRemoteTunnelHostname,
      normalizeFrpcCustomDomain,
      normalizeFrpcPublicHostname,
      normalizeFrpcPublicUrl,
      normalizeTunnelBootstrapTtlMs,
      normalizeTunnelSessionTtlMs,
      isSupportedTunnelMode,
      upsertManagedRemoteTunnelToken,
      resolveManagedRemoteTunnelToken,
      upsertFrpcTunnelConfig,
      resolveFrpcTunnelToken,
      TUNNEL_MODE_QUICK,
      TUNNEL_MODE_MANAGED_LOCAL,
      TUNNEL_MODE_MANAGED_REMOTE,
      TUNNEL_PROVIDER_CLOUDFLARE,
      TUNNEL_PROVIDER_FRPC,
      TunnelServiceError,
      getActivePort: () => activePort,
      getRuntimeManagedRemoteTunnelHostname,
      setRuntimeManagedRemoteTunnelHostname,
      getRuntimeManagedRemoteTunnelToken,
      setRuntimeManagedRemoteTunnelToken,
      getActiveTunnelController,
    });

    tunnelRoutesRuntime.registerRoutes(app);

    return {
      tunnelService,
      startTunnelWithNormalizedRequest: (...args: Parameters<typeof tunnelRoutesRuntime.startTunnelWithNormalizedRequest>) => tunnelRoutesRuntime.startTunnelWithNormalizedRequest(...args),
      getActivePort: () => activePort,
      setActivePort: (value: number) => {
        activePort = value;
      },
    };
  };

  return {
    initialize,
  };
};
