import { createFrpcBinaryManager } from '../frpc-binary-manager.js';
import {
  loadFrpcDefaultTrustedCa,
  normalizeFrpcEndpoint,
  normalizeFrpcLocalPort,
  normalizeFrpcServerAddress,
  normalizeFrpcServerPort,
  normalizeFrpcToken,
  startFrpcClient,
} from '../frpc-client.js';
import type { FrpcClientController } from '../frpc-client.js';
import type {
  TunnelController,
  TunnelDoctorCheck,
  TunnelDoctorRequest,
  TunnelProvider,
  TunnelProviderMetadata,
  TunnelStartContext,
} from '../contracts.js';
import {
  TUNNEL_INTENT_PERSISTENT_PUBLIC,
  TUNNEL_MODE_MANAGED_REMOTE,
  TUNNEL_PROVIDER_FRPC,
  TunnelServiceError,
} from '../types.js';
import type { TunnelCapabilities, TunnelStartRequest } from '../types.js';
import { isString } from '../../shared/object-guards.js';

export const FRPC_TUNNEL_PROVIDER = TUNNEL_PROVIDER_FRPC;

export const frpcTunnelProviderCapabilities: TunnelCapabilities = {
  provider: FRPC_TUNNEL_PROVIDER,
  defaults: {
    mode: TUNNEL_MODE_MANAGED_REMOTE,
    optionDefaults: {},
  },
  modes: [
    {
      key: TUNNEL_MODE_MANAGED_REMOTE,
      label: 'Managed FRP Tunnel',
      intent: TUNNEL_INTENT_PERSISTENT_PUBLIC,
      requires: ['serverAddress', 'serverPort', 'token'],
      supports: ['customDomain', 'publicUrl', 'sessionTTL'],
      proxyTypes: ['tcp', 'http'],
      stability: 'beta',
    },
  ],
};

export interface CreateFrpcTunnelProviderOptions {
  binaryManager?: ReturnType<typeof createFrpcBinaryManager>;
  startClient?: typeof startFrpcClient;
  loadTrustedCa?: typeof loadFrpcDefaultTrustedCa;
}

const isFrpcController = (controller: TunnelController | null): controller is FrpcClientController =>
  Boolean(controller && 'getServerAddress' in controller);

export function createFrpcTunnelProvider({
  binaryManager = createFrpcBinaryManager(),
  startClient = startFrpcClient,
  loadTrustedCa = loadFrpcDefaultTrustedCa,
}: CreateFrpcTunnelProviderOptions = {}): TunnelProvider & {
  prepare: ReturnType<typeof createFrpcBinaryManager>['prepare'];
} {
  let activeController: FrpcClientController | null = null;
  let startQueue: Promise<unknown> = Promise.resolve();
  let lifecycleGeneration = 0;

  const prepare: ReturnType<typeof createFrpcBinaryManager>['prepare'] = (options) => binaryManager.prepare(options);

  const checkAvailability = async () => {
    const inspection = await binaryManager.inspect();
    if (!inspection.supported) {
      return {
        available: false,
        managed: true,
        dependency: 'frpc',
        prepared: false,
        path: null,
        version: inspection.version,
        target: inspection.target,
        message: inspection.error ?? 'Managed FRPC is not supported on this platform',
      };
    }
    return {
      available: true,
      managed: true,
      dependency: 'frpc',
      prepared: inspection.prepared,
      path: inspection.path,
      version: inspection.version,
      target: inspection.target,
      message: inspection.prepared
        ? `Managed FRPC ${inspection.version} is ready`
        : `Managed FRPC ${inspection.version} will be prepared on start`,
    };
  };

  const diagnose = async (request: Partial<TunnelDoctorRequest> = {}) => {
    const availability = await checkAvailability();
    const checks: TunnelDoctorCheck[] = [{
      id: 'startup_readiness',
      label: 'Provider startup readiness',
      status: availability.available ? 'pass' : 'fail',
      detail: availability.available
        ? 'Managed FRPC is available.'
        : (availability.message || 'Managed FRPC is unavailable.'),
    }];
    const addValidationCheck = (id: string, label: string, validate: () => void, successDetail: string) => {
      try {
        validate();
        checks.push({ id, label, status: 'pass', detail: successDetail });
      } catch (error) {
        checks.push({
          id,
          label,
          status: 'fail',
          detail: error instanceof Error ? error.message : `Invalid ${label.toLowerCase()}`,
        });
      }
    };

    addValidationCheck(
      'requirement_serverAddress',
      'FRPS server address',
      () => normalizeFrpcServerAddress(request.serverAddress),
      'FRPS server address is configured.'
    );
    addValidationCheck(
      'requirement_serverPort',
      'FRPS server port',
      () => normalizeFrpcServerPort(request.serverPort),
      'FRPS server port is configured.'
    );
    try {
      loadTrustedCa();
      checks.push({
        id: 'requirement_certificateTrust',
        label: 'FRPS certificate trust',
        status: 'pass',
        detail: 'Host CA certificates are available for FRPS verification.',
      });
    } catch (error) {
      checks.push({
        id: 'requirement_certificateTrust',
        label: 'FRPS certificate trust',
        status: 'fail',
        detail: error instanceof Error ? error.message : 'Invalid FRPS certificate trust',
      });
    }
    addValidationCheck(
      'requirement_token',
      'FRPC token',
      () => normalizeFrpcToken(request.token),
      'FRPC token is configured.'
    );
    addValidationCheck(
      'requirement_endpoint',
      'FRPC proxy endpoint',
      () => normalizeFrpcEndpoint(request),
      isString(request.customDomain) && request.customDomain.trim()
        ? 'FRPS HTTP custom domain and public hostname are configured.'
        : 'FRPS TCP remote port and public HTTPS URL are configured.'
    );

    const failures = checks.filter((entry) => entry.status === 'fail').length;
    const blockers = checks
      .filter((entry) => entry.status === 'fail' && entry.id !== 'startup_readiness')
      .map((entry) => entry.detail || entry.label || entry.id);

    return {
      providerChecks: [{
        id: 'dependency',
        label: 'Managed FRPC binary',
        status: availability.available ? 'pass' : 'fail',
        detail: availability.message || null,
      }],
      modes: [{
        mode: TUNNEL_MODE_MANAGED_REMOTE,
        checks,
        summary: { ready: failures === 0, failures, warnings: 0 },
        ready: failures === 0,
        blockers,
      }],
    };
  };

  const assertStartCurrent = (generation: number, signal: AbortSignal | undefined) => {
    if (generation !== lifecycleGeneration || signal?.aborted) {
      throw new TunnelServiceError('startup_cancelled', 'FRPC start was superseded, cancelled, or stopped');
    }
  };

  const startInternal = async (
    request: TunnelStartRequest,
    context: Partial<TunnelStartContext>,
    generation: number,
  ): Promise<FrpcClientController> => {
    if (request?.mode !== TUNNEL_MODE_MANAGED_REMOTE) {
      throw new TunnelServiceError(
        'mode_unsupported',
        `FRPC only supports '${TUNNEL_MODE_MANAGED_REMOTE}' mode`
      );
    }
    let serverAddress: string;
    let serverPort: number;
    let endpoint: ReturnType<typeof normalizeFrpcEndpoint>;
    let token: string;
    let localPort: number;
    try {
      serverAddress = normalizeFrpcServerAddress(request.serverAddress);
      serverPort = normalizeFrpcServerPort(request.serverPort);
      loadTrustedCa();
      endpoint = normalizeFrpcEndpoint(request);
      token = normalizeFrpcToken(request.token);
      localPort = normalizeFrpcLocalPort(context.activePort);
    } catch (error) {
      throw new TunnelServiceError(
        'validation_error',
        error instanceof Error ? error.message : 'Invalid FRPC start request'
      );
    }

    assertStartCurrent(generation, context.signal);
    const prepared = await prepare();
    assertStartCurrent(generation, context.signal);
    await activeController?.stop?.();
    activeController = null;

    let controller: FrpcClientController | null = null;
    controller = await startClient({
      binaryPath: prepared.path,
      serverAddress,
      serverPort,
      token,
      localPort,
      proxyType: endpoint.proxyType,
      ...(endpoint.proxyType === 'tcp'
        ? { remotePort: endpoint.remotePort, publicUrl: endpoint.publicUrl }
        : { customDomain: endpoint.customDomain, hostname: endpoint.hostname }),
      onExit: () => {
        if (activeController === controller) {
          activeController = null;
        }
      },
    });
    if (generation !== lifecycleGeneration || context.signal?.aborted) {
      await controller.stop?.();
      throw new TunnelServiceError('startup_cancelled', 'FRPC start was superseded, cancelled, or stopped');
    }
    controller.mode = TUNNEL_MODE_MANAGED_REMOTE;
    if (controller.isRunning?.() !== false) {
      activeController = controller;
    }
    return controller;
  };

  return {
    id: FRPC_TUNNEL_PROVIDER,
    capabilities: frpcTunnelProviderCapabilities,
    prepare,
    checkAvailability,
    diagnose,
    start: (request: TunnelStartRequest, context: Partial<TunnelStartContext> = {}) => {
      lifecycleGeneration += 1;
      const generation = lifecycleGeneration;
      const cancelStart = () => {
        if (lifecycleGeneration === generation) {
          lifecycleGeneration += 1;
        }
      };
      if (context.signal?.aborted) {
        cancelStart();
      } else {
        context.signal?.addEventListener?.('abort', cancelStart, { once: true });
      }
      const operation = startQueue
        .then(() => startInternal(request, context, generation))
        .finally(() => context.signal?.removeEventListener?.('abort', cancelStart));
      startQueue = operation.catch(() => undefined);
      return operation;
    },
    stop: async (controller: TunnelController | null = activeController) => {
      lifecycleGeneration += 1;
      if (!controller) {
        return false;
      }
      const stopped = await controller.stop?.() ?? false;
      if (activeController === controller) {
        activeController = null;
      }
      return stopped;
    },
    resolvePublicUrl: (controller: TunnelController | null = activeController) => controller?.getPublicUrl?.() ?? null,
    canReuse: () => false,
    getMetadata: (controller: TunnelController | null = activeController): TunnelProviderMetadata | null => {
      if (!controller) {
        return null;
      }
      if (!isFrpcController(controller)) {
        return {
          configPath: controller.getEffectiveConfigPath?.() ?? null,
          resolvedHostname: controller.getResolvedHostname?.() ?? null,
        };
      }
      return {
        serverAddress: controller.getServerAddress?.() ?? null,
        serverPort: controller.getServerPort?.() ?? null,
        proxyType: controller.getProxyType?.() ?? null,
        remotePort: controller.getRemotePort?.() ?? null,
        customDomain: controller.getCustomDomain?.() ?? null,
        hostname: controller.getHostname?.() ?? null,
        publicUrl: controller.getConfiguredPublicUrl?.() ?? null,
      };
    },
  };
}
