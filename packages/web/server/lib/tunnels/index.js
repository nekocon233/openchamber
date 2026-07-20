import {
  TUNNEL_MODE_QUICK,
  TUNNEL_PROVIDER_CLOUDFLARE,
  TunnelServiceError,
  normalizeTunnelStartRequest,
  validateTunnelStartRequest,
} from './types.js';
import { getTunnelDependencyInstallInfo } from './install-help.js';
import {
  FRPC_DEFAULT_DOWNLOAD_TIMEOUT_MS,
  FRPC_DEFAULT_LOCK_TIMEOUT_MS,
} from './frpc-binary-manager.js';
import {
  FRPC_DEFAULT_STARTUP_TIMEOUT_MS,
  FRPC_DEFAULT_STOP_FORCE_TIMEOUT_MS,
  FRPC_DEFAULT_STOP_GRACE_TIMEOUT_MS,
} from './frpc-client.js';

export const TUNNEL_PENDING_START_SETTLE_TIMEOUT_MS = FRPC_DEFAULT_LOCK_TIMEOUT_MS
  + FRPC_DEFAULT_DOWNLOAD_TIMEOUT_MS
  + FRPC_DEFAULT_STARTUP_TIMEOUT_MS
  + FRPC_DEFAULT_STOP_GRACE_TIMEOUT_MS
  + FRPC_DEFAULT_STOP_FORCE_TIMEOUT_MS
  + 40000;

export function createTunnelService({
  registry,
  getController,
  setController,
  getActivePort,
  onQuickTunnelWarning,
  pendingStartSettleTimeoutMs = TUNNEL_PENDING_START_SETTLE_TIMEOUT_MS,
}) {
  if (!registry) {
    throw new Error('Tunnel service requires a provider registry');
  }

  const resolveActiveMode = () => {
    const controller = getController();
    if (!controller || typeof controller.mode !== 'string') {
      return null;
    }
    return controller.mode;
  };

  const resolveActiveProvider = () => {
    const controller = getController();
    if (!controller || typeof controller.provider !== 'string') {
      return null;
    }
    return controller.provider;
  };

  // Serialize starts and retain cancellation handles for both the active and
  // queued operations so an explicit stop cannot be followed by a late start.
  let startLock = Promise.resolve();
  const pendingStarts = new Set();
  const startSettleTimeoutMs = Number.isFinite(pendingStartSettleTimeoutMs) && pendingStartSettleTimeoutMs > 0
    ? Math.trunc(pendingStartSettleTimeoutMs)
    : TUNNEL_PENDING_START_SETTLE_TIMEOUT_MS;

  const stopController = async (expectedController) => {
    const controller = getController();
    if (!controller || (expectedController && controller !== expectedController)) {
      return false;
    }

    const providerId = typeof controller.provider === 'string' ? controller.provider : '';
    const provider = providerId ? registry.get(providerId) : null;
    if (provider?.stop) {
      await provider.stop(controller);
    } else {
      await controller.stop?.();
    }
    if (getController() === controller) {
      setController(null);
    }
    return true;
  };

  const stop = async (expectedController) => {
    if (expectedController !== undefined) {
      return stopController(expectedController);
    }

    const affectedStarts = [...pendingStarts];
    for (const pendingStart of affectedStarts) {
      pendingStart.abortController.abort();
    }

    const activeController = getController();
    if (!activeController && affectedStarts.length === 0) {
      return false;
    }

    const controllerStopOutcome = activeController
      ? stopController(activeController).then(
        (stopped) => ({ stopped, error: null }),
        (error) => ({ stopped: false, error })
      )
      : Promise.resolve({ stopped: false, error: null });
    const pendingSettlements = Promise.all(
      affectedStarts.map((pendingStart) => pendingStart.settled)
    );

    let timeout;
    let stopOutcome;
    try {
      stopOutcome = await Promise.race([
        Promise.all([controllerStopOutcome, pendingSettlements]),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new TunnelServiceError(
            'stop_timeout',
            `Timed out after ${startSettleTimeoutMs}ms waiting for tunnel stop and pending startup cleanup`
          )), startSettleTimeoutMs);
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }

    const [controllerResult, settlements] = stopOutcome;
    const failedSettlement = settlements.find(({ error }) => (
      error && !(error instanceof TunnelServiceError && error.code === 'startup_cancelled')
    ));
    if (failedSettlement) {
      throw new TunnelServiceError(
        'stop_failed',
        'A pending tunnel start could not be cleaned up safely'
      );
    }
    if (controllerResult.error) {
      throw controllerResult.error;
    }

    return controllerResult.stopped || affectedStarts.length > 0;
  };

  const checkAvailability = async (providerId) => {
    const provider = registry.get(providerId);
    if (!provider) {
      throw new TunnelServiceError('provider_unsupported', `Unsupported tunnel provider: ${providerId}`);
    }
    const result = await provider.checkAvailability();
    return result;
  };

  const start = async (rawRequest, options = {}) => {
    const startAbortController = new AbortController();
    let resolveSettled;
    const pendingStart = {
      abortController: startAbortController,
      settled: new Promise((resolve) => { resolveSettled = resolve; }),
    };
    let settlementError = null;
    const abortStart = () => startAbortController.abort();
    if (options.signal?.aborted) {
      abortStart();
    } else {
      options.signal?.addEventListener?.('abort', abortStart, { once: true });
    }
    pendingStarts.add(pendingStart);

    let releaseLock;
    const lockPromise = new Promise((resolve) => { releaseLock = resolve; });
    const previousLock = startLock;
    startLock = lockPromise;

    await previousLock;

    let controllerReplaced = false;
    let startedController = null;
    try {
      if (startAbortController.signal.aborted) {
        throw new TunnelServiceError('startup_cancelled', 'Tunnel start was cancelled');
      }
      const request = normalizeTunnelStartRequest(rawRequest);
      const provider = registry.get(request.provider);

      if (!provider) {
        throw new TunnelServiceError('provider_unsupported', `Unsupported tunnel provider: ${request.provider}`);
      }

      validateTunnelStartRequest(request, provider.capabilities);

      const activeController = getController();
      let publicUrl = provider.resolvePublicUrl(activeController);
      const activeMode = resolveActiveMode();
      const activeProvider = resolveActiveProvider();
      const reusable = Boolean(
        activeController
        && publicUrl
        && activeMode === request.mode
        && activeProvider === request.provider
        && provider.canReuse?.(activeController, request) !== false
      );

      if (activeController && !reusable) {
        await stopController(activeController);
        controllerReplaced = true;
        publicUrl = null;
      }

      if (!publicUrl) {
        if (startAbortController.signal.aborted) {
          throw new TunnelServiceError('startup_cancelled', 'Tunnel start was cancelled');
        }
        const availability = await provider.checkAvailability();
        if (startAbortController.signal.aborted) {
          throw new TunnelServiceError('startup_cancelled', 'Tunnel start was cancelled');
        }
        if (!availability?.available) {
          const missingDependencyMessage = typeof availability?.message === 'string' && availability.message.trim().length > 0
            ? availability.message
            : (request.provider === TUNNEL_PROVIDER_CLOUDFLARE
              ? getTunnelDependencyInstallInfo(TUNNEL_PROVIDER_CLOUDFLARE).message
              : `Required dependency for provider '${request.provider}' is missing`);
          throw new TunnelServiceError('missing_dependency', missingDependencyMessage);
        }

        const activePort = Number.isFinite(getActivePort?.()) ? getActivePort() : null;
        const originUrl = activePort !== null ? `http://127.0.0.1:${activePort}` : undefined;

        let controller;
        try {
          controller = await provider.start(request, {
            activePort,
            originUrl,
            ...options,
            signal: startAbortController.signal,
          });
        } catch (error) {
          if (startAbortController.signal.aborted) {
            throw new TunnelServiceError('startup_cancelled', 'Tunnel start was cancelled');
          }
          if (error instanceof TunnelServiceError) {
            throw error;
          }
          const message = error instanceof Error && error.message.trim().length > 0
            ? error.message
            : 'Failed to start tunnel';
          throw new TunnelServiceError('startup_failed', message);
        }
        if (startAbortController.signal.aborted) {
          if (provider.stop) {
            await provider.stop(controller);
          } else {
            await controller.stop?.();
          }
          throw new TunnelServiceError('startup_cancelled', 'Tunnel start was cancelled');
        }
        controller.provider = request.provider;
        setController(controller);
        startedController = controller;

        publicUrl = provider.resolvePublicUrl(controller);
        if (!publicUrl) {
          await stopController(controller);
          throw new TunnelServiceError('startup_failed', 'Tunnel started but no public URL was assigned');
        }

        if (request.mode === TUNNEL_MODE_QUICK) {
          onQuickTunnelWarning?.();
        }
      }

      if (startAbortController.signal.aborted) {
        if (startedController) {
          await stopController(startedController);
        }
        throw new TunnelServiceError('startup_cancelled', 'Tunnel start was cancelled');
      }

      return {
        publicUrl,
        request,
        activeMode: request.mode,
        provider: request.provider,
        providerMetadata: provider.getMetadata?.(getController()) ?? null,
        controllerReplaced,
        controller: getController(),
        controllerStarted: Boolean(startedController),
      };
    } catch (error) {
      let finalError = error;
      if (controllerReplaced && error instanceof TunnelServiceError) {
        finalError = new TunnelServiceError(error.code, error.message, {
          ...(error.details && typeof error.details === 'object' ? error.details : {}),
          controllerReplaced: true,
        });
      } else if (controllerReplaced) {
        finalError = new TunnelServiceError(
          'startup_failed',
          error instanceof Error && error.message.trim().length > 0 ? error.message : 'Failed to start tunnel',
          { controllerReplaced: true }
        );
      }
      settlementError = finalError;
      throw finalError;
    } finally {
      options.signal?.removeEventListener?.('abort', abortStart);
      pendingStarts.delete(pendingStart);
      releaseLock();
      resolveSettled({ error: settlementError });
    }
  };

  const getPublicUrl = () => {
    const controller = getController();
    if (!controller) {
      return null;
    }
    const provider = registry.get(controller.provider);
    if (!provider) {
      return controller.getPublicUrl?.() ?? null;
    }
    return provider.resolvePublicUrl(controller);
  };

  const getProviderMetadata = () => {
    const controller = getController();
    if (!controller) {
      return null;
    }
    const provider = registry.get(controller.provider);
    return provider?.getMetadata?.(controller) ?? null;
  };

  const isActiveController = (controller) => {
    if (!controller || getController() !== controller) {
      return false;
    }
    const provider = registry.get(controller.provider);
    const publicUrl = provider
      ? provider.resolvePublicUrl(controller)
      : controller.getPublicUrl?.();
    return typeof publicUrl === 'string' && publicUrl.length > 0;
  };

  return {
    start,
    stop,
    checkAvailability,
    getPublicUrl,
    getProviderMetadata,
    isActiveController,
    resolveActiveMode,
    resolveActiveProvider,
  };
}
