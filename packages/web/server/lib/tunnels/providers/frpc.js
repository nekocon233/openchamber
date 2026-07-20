import { createFrpcBinaryManager } from '../frpc-binary-manager.js';
import {
  normalizeFrpcEndpoint,
  loadFrpcTrustedCaFile,
  normalizeFrpcLocalPort,
  normalizeFrpcServerAddress,
  normalizeFrpcServerPort,
  normalizeFrpcTrustedCaFile,
  normalizeFrpcToken,
  startFrpcClient,
} from '../frpc-client.js';
import {
  TUNNEL_INTENT_PERSISTENT_PUBLIC,
  TUNNEL_MODE_MANAGED_REMOTE,
  TUNNEL_PROVIDER_FRPC,
  TunnelServiceError,
} from '../types.js';

export const FRPC_TUNNEL_PROVIDER = TUNNEL_PROVIDER_FRPC;

export const frpcTunnelProviderCapabilities = {
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
      requires: ['serverAddress', 'serverPort', 'trustedCaFile', 'token'],
      supports: ['customDomain', 'publicUrl', 'sessionTTL'],
      proxyTypes: ['tcp', 'http'],
      stability: 'beta',
    },
  ],
};

export function createFrpcTunnelProvider({
  binaryManager = createFrpcBinaryManager(),
  startClient = startFrpcClient,
} = {}) {
  let activeController = null;
  let startQueue = Promise.resolve();
  let lifecycleGeneration = 0;

  const prepare = (options) => binaryManager.prepare(options);

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
        message: inspection.error,
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

  const diagnose = async (request = {}) => {
    const availability = await checkAvailability();
    const checks = [{
      id: 'startup_readiness',
      label: 'Provider startup readiness',
      status: availability.available ? 'pass' : 'fail',
      detail: availability.available
        ? 'Managed FRPC is available.'
        : (availability.message || 'Managed FRPC is unavailable.'),
    }];
    const addValidationCheck = (id, label, validate, successDetail) => {
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
    addValidationCheck(
      'requirement_trustedCaFile',
      'FRPS trusted CA file',
      () => loadFrpcTrustedCaFile(request.trustedCaFile),
      'FRPS trusted CA file is readable and within the production size limit.'
    );
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
      typeof request.customDomain === 'string' && request.customDomain.trim()
        ? 'FRPC HTTP-vhost endpoint is configured.'
        : 'FRPC TCP endpoint is configured.'
    );

    const failures = checks.filter((entry) => entry.status === 'fail').length;
    const blockers = checks
      .filter((entry) => entry.status === 'fail' && entry.id !== 'startup_readiness')
      .map((entry) => entry.detail);
    return {
      providerChecks: [{
        id: 'dependency',
        label: 'Managed FRPC',
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

  const assertStartCurrent = (generation, signal) => {
    if (generation !== lifecycleGeneration || signal?.aborted) {
      throw new TunnelServiceError('startup_cancelled', 'FRPC start was superseded, cancelled, or stopped');
    }
  };

  const startInternal = async (request, context, generation) => {
    if (request?.mode !== TUNNEL_MODE_MANAGED_REMOTE) {
      throw new TunnelServiceError(
        'mode_unsupported',
        `FRPC only supports '${TUNNEL_MODE_MANAGED_REMOTE}' mode`
      );
    }
    let serverAddress;
    let serverPort;
    let trustedCaFile;
    let endpoint;
    let token;
    let localPort;
    try {
      serverAddress = normalizeFrpcServerAddress(request.serverAddress);
      serverPort = normalizeFrpcServerPort(request.serverPort);
      trustedCaFile = normalizeFrpcTrustedCaFile(request.trustedCaFile);
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

    let controller;
    controller = await startClient({
      binaryPath: prepared.path,
      serverAddress,
      serverPort,
      trustedCaFile,
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
    start: (request, context = {}) => {
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
    stop: async (controller = activeController) => {
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
    resolvePublicUrl: (controller = activeController) => controller?.getPublicUrl?.() ?? null,
    canReuse: () => false,
    getMetadata: (controller = activeController) => controller ? {
      serverAddress: controller.getServerAddress?.() ?? null,
      serverPort: controller.getServerPort?.() ?? null,
      trustedCaFile: controller.getTrustedCaFile?.() ?? null,
      proxyType: controller.getProxyType?.() ?? null,
      remotePort: controller.getRemotePort?.() ?? null,
      customDomain: controller.getCustomDomain?.() ?? null,
      hostname: controller.getHostname?.() ?? null,
      publicUrl: controller.getConfiguredPublicUrl?.() ?? null,
    } : null,
  };
}
