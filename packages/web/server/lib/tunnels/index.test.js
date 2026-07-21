import { describe, expect, it } from 'bun:test';

import { createTunnelService } from './index.js';
import {
  TUNNEL_INTENT_EPHEMERAL_PUBLIC,
  TUNNEL_MODE_QUICK,
  TUNNEL_PROVIDER_CLOUDFLARE,
  TUNNEL_PROVIDER_FRPC,
  TUNNEL_PROVIDER_NGROK,
} from './types.js';

const createProvider = ({ provider, start, stop, resolvePublicUrl, checkAvailability }) => ({
  id: provider,
  capabilities: {
    provider,
    modes: [{ key: TUNNEL_MODE_QUICK, intent: TUNNEL_INTENT_EPHEMERAL_PUBLIC }],
  },
  checkAvailability: checkAvailability || (async () => ({ available: true })),
  start,
  stop,
  resolvePublicUrl: resolvePublicUrl || ((controller) => controller?.getPublicUrl?.() ?? null),
});

const createRegistry = (providers) => ({
  get: (providerId) => providers[providerId] ?? null,
});

describe('createTunnelService', () => {
  it('returns provider startup errors to route callers', async () => {
    let controller = null;
    const provider = createProvider({
      provider: TUNNEL_PROVIDER_NGROK,
      start: async () => {
        throw new Error('ngrok authtoken is not configured');
      },
    });
    const service = createTunnelService({
      registry: createRegistry({ [TUNNEL_PROVIDER_NGROK]: provider }),
      getController: () => controller,
      setController: (next) => { controller = next; },
      getActivePort: () => 3000,
    });

    try {
      await service.start({ provider: TUNNEL_PROVIDER_NGROK, mode: TUNNEL_MODE_QUICK });
      throw new Error('Expected service.start to fail');
    } catch (error) {
      expect(error.name).toBe('TunnelServiceError');
      expect(error.code).toBe('startup_failed');
      expect(error.message).toBe('ngrok authtoken is not configured');
    }
  });

  it('replaces an active quick tunnel when the provider changes', async () => {
    let stopped = false;
    let ngrokStarted = false;
    let controller = {
      provider: TUNNEL_PROVIDER_CLOUDFLARE,
      mode: TUNNEL_MODE_QUICK,
      stop: () => { stopped = true; },
      getPublicUrl: () => 'https://cloudflare.example',
    };
    const cloudflareProvider = createProvider({
      provider: TUNNEL_PROVIDER_CLOUDFLARE,
      start: async () => controller,
    });
    const ngrokProvider = createProvider({
      provider: TUNNEL_PROVIDER_NGROK,
      start: async () => {
        ngrokStarted = true;
        return {
          mode: TUNNEL_MODE_QUICK,
          getPublicUrl: () => 'https://demo.ngrok-free.app',
        };
      },
    });
    const service = createTunnelService({
      registry: createRegistry({
        [TUNNEL_PROVIDER_CLOUDFLARE]: cloudflareProvider,
        [TUNNEL_PROVIDER_NGROK]: ngrokProvider,
      }),
      getController: () => controller,
      setController: (next) => { controller = next; },
      getActivePort: () => 3000,
    });

    const result = await service.start({ provider: TUNNEL_PROVIDER_NGROK, mode: TUNNEL_MODE_QUICK });

    expect(stopped).toBe(true);
    expect(ngrokStarted).toBe(true);
    expect(result.provider).toBe(TUNNEL_PROVIDER_NGROK);
    expect(result.publicUrl).toBe('https://demo.ngrok-free.app');
  });

  it('restarts an FRPC controller even when its public URL and mode are unchanged', async () => {
    let starts = 0;
    let stops = 0;
    let controller = {
      provider: TUNNEL_PROVIDER_FRPC,
      mode: 'managed-remote',
      stop: () => { stops += 1; },
      getPublicUrl: () => 'https://203.0.113.10',
    };
    const provider = {
      id: TUNNEL_PROVIDER_FRPC,
      capabilities: {
        provider: TUNNEL_PROVIDER_FRPC,
        modes: [{
          key: 'managed-remote',
          intent: 'persistent-public',
          requires: ['serverAddress', 'serverPort', 'token'],
        }],
      },
      checkAvailability: async () => ({ available: true }),
      canReuse: () => false,
      stop: (active) => active.stop(),
      start: async () => {
        starts += 1;
        return {
          mode: 'managed-remote',
          getPublicUrl: () => 'https://203.0.113.10',
        };
      },
      resolvePublicUrl: (active) => active?.getPublicUrl?.() ?? null,
    };
    const service = createTunnelService({
      registry: createRegistry({ [TUNNEL_PROVIDER_FRPC]: provider }),
      getController: () => controller,
      setController: (next) => { controller = next; },
      getActivePort: () => 3000,
    });

    const result = await service.start({
      provider: TUNNEL_PROVIDER_FRPC,
      mode: 'managed-remote',
      serverAddress: '203.0.113.10',
      serverPort: 7000,
      remotePort: 18080,
      publicUrl: 'https://203.0.113.10',
      token: 'secret',
    });

    expect(stops).toBe(1);
    expect(starts).toBe(1);
    expect(result.controllerReplaced).toBe(true);
  });

  it('keeps a reusable controller and reports that no replacement occurred', async () => {
    let starts = 0;
    let stops = 0;
    let controller = {
      provider: TUNNEL_PROVIDER_CLOUDFLARE,
      mode: TUNNEL_MODE_QUICK,
      stop: () => { stops += 1; },
      getPublicUrl: () => 'https://stable.example.com',
    };
    const provider = createProvider({
      provider: TUNNEL_PROVIDER_CLOUDFLARE,
      start: async () => {
        starts += 1;
        return controller;
      },
    });
    const service = createTunnelService({
      registry: createRegistry({ [TUNNEL_PROVIDER_CLOUDFLARE]: provider }),
      getController: () => controller,
      setController: (next) => { controller = next; },
      getActivePort: () => 3000,
    });

    const result = await service.start({
      provider: TUNNEL_PROVIDER_CLOUDFLARE,
      mode: TUNNEL_MODE_QUICK,
    });

    expect(starts).toBe(0);
    expect(stops).toBe(0);
    expect(result.publicUrl).toBe('https://stable.example.com');
    expect(result.controllerReplaced).toBe(false);
  });

  it('rejects unknown explicit provider and mode values before provider startup', async () => {
    let starts = 0;
    let controller = null;
    const provider = createProvider({
      provider: TUNNEL_PROVIDER_CLOUDFLARE,
      start: async () => {
        starts += 1;
        return { getPublicUrl: () => 'https://example.com' };
      },
    });
    const service = createTunnelService({
      registry: createRegistry({ [TUNNEL_PROVIDER_CLOUDFLARE]: provider }),
      getController: () => controller,
      setController: (next) => { controller = next; },
      getActivePort: () => 3000,
    });

    await expect(service.start({ provider: 'invalid-provider' })).rejects.toMatchObject({
      code: 'provider_unsupported',
    });
    await expect(service.start({
      provider: TUNNEL_PROVIDER_CLOUDFLARE,
      mode: 'invalid-mode',
    })).rejects.toMatchObject({ code: 'mode_unsupported' });
    expect(starts).toBe(0);
  });

  it('cancels an in-progress start even before a controller is published', async () => {
    let resolveStart;
    let receivedSignal;
    let controller = null;
    let stoppedController = null;
    let resolveControllerStop;
    let controllerStopStarted;
    const stoppingController = new Promise((resolve) => { controllerStopStarted = resolve; });
    const provider = createProvider({
      provider: TUNNEL_PROVIDER_CLOUDFLARE,
      start: async (_request, context) => {
        receivedSignal = context.signal;
        return new Promise((resolve) => { resolveStart = resolve; });
      },
      stop: async (active) => {
        stoppedController = active;
        await active.stop();
      },
    });
    const service = createTunnelService({
      registry: createRegistry({ [TUNNEL_PROVIDER_CLOUDFLARE]: provider }),
      getController: () => controller,
      setController: (next) => { controller = next; },
      getActivePort: () => 3000,
    });

    const starting = service.start({
      provider: TUNNEL_PROVIDER_CLOUDFLARE,
      mode: TUNNEL_MODE_QUICK,
    });
    while (!resolveStart) {
      await Promise.resolve();
    }

    let stopSettled = false;
    const stopping = service.stop().finally(() => { stopSettled = true; });
    await Promise.resolve();
    expect(receivedSignal.aborted).toBe(true);
    expect(stopSettled).toBe(false);

    let stopCalls = 0;
    const lateController = {
      stop: async () => {
        stopCalls += 1;
        controllerStopStarted();
        return new Promise((resolve) => { resolveControllerStop = resolve; });
      },
      getPublicUrl: () => 'https://late.example.com',
    };
    resolveStart(lateController);
    await stoppingController;
    expect(stopSettled).toBe(false);
    resolveControllerStop(true);

    await expect(starting).rejects.toMatchObject({ code: 'startup_cancelled' });
    await expect(stopping).resolves.toBe(true);
    expect(stoppedController).toBe(lateController);
    expect(stopCalls).toBe(1);
    expect(controller).toBeNull();
  });

  it('does not launch a provider after stop cancels its availability check', async () => {
    let resolveAvailability;
    let availabilityStarted;
    const checkingAvailability = new Promise((resolve) => { availabilityStarted = resolve; });
    let starts = 0;
    let controller = null;
    const provider = createProvider({
      provider: TUNNEL_PROVIDER_CLOUDFLARE,
      checkAvailability: async () => {
        availabilityStarted();
        return new Promise((resolve) => { resolveAvailability = resolve; });
      },
      start: async () => {
        starts += 1;
        return { getPublicUrl: () => 'https://late.example.com' };
      },
    });
    const service = createTunnelService({
      registry: createRegistry({ [TUNNEL_PROVIDER_CLOUDFLARE]: provider }),
      getController: () => controller,
      setController: (next) => { controller = next; },
      getActivePort: () => 3000,
    });

    const starting = service.start({
      provider: TUNNEL_PROVIDER_CLOUDFLARE,
      mode: TUNNEL_MODE_QUICK,
    });
    await checkingAvailability;
    let stopSettled = false;
    const stopping = service.stop().finally(() => { stopSettled = true; });
    await Promise.resolve();
    expect(stopSettled).toBe(false);
    resolveAvailability({ available: true });

    await expect(starting).rejects.toMatchObject({ code: 'startup_cancelled' });
    await expect(stopping).resolves.toBe(true);
    expect(starts).toBe(0);
    expect(controller).toBeNull();
  });

  it('fails stop after the bounded wait while keeping a late controller unpublished', async () => {
    let resolveStart;
    let startCalled;
    const providerStarting = new Promise((resolve) => { startCalled = resolve; });
    let controller = null;
    let stopCalls = 0;
    const provider = createProvider({
      provider: TUNNEL_PROVIDER_CLOUDFLARE,
      start: async () => {
        startCalled();
        return new Promise((resolve) => { resolveStart = resolve; });
      },
      stop: async (active) => active.stop(),
    });
    const service = createTunnelService({
      registry: createRegistry({ [TUNNEL_PROVIDER_CLOUDFLARE]: provider }),
      getController: () => controller,
      setController: (next) => { controller = next; },
      getActivePort: () => 3000,
      pendingStartSettleTimeoutMs: 10,
    });
    const starting = service.start({
      provider: TUNNEL_PROVIDER_CLOUDFLARE,
      mode: TUNNEL_MODE_QUICK,
    });
    await providerStarting;

    await expect(service.stop()).rejects.toMatchObject({ code: 'stop_timeout' });

    resolveStart({
      stop: async () => { stopCalls += 1; },
      getPublicUrl: () => 'https://late.example.com',
    });
    await expect(starting).rejects.toMatchObject({ code: 'startup_cancelled' });
    expect(stopCalls).toBe(1);
    expect(controller).toBeNull();
  });

  it('bounds an active provider stop that does not settle within its contract', async () => {
    let resolveProviderStop;
    const activeController = {
      provider: TUNNEL_PROVIDER_CLOUDFLARE,
      mode: TUNNEL_MODE_QUICK,
      getPublicUrl: () => 'https://active.example.com',
    };
    let controller = activeController;
    const provider = createProvider({
      provider: TUNNEL_PROVIDER_CLOUDFLARE,
      start: async () => activeController,
      stop: async () => new Promise((resolve) => { resolveProviderStop = resolve; }),
    });
    const service = createTunnelService({
      registry: createRegistry({ [TUNNEL_PROVIDER_CLOUDFLARE]: provider }),
      getController: () => controller,
      setController: (next) => { controller = next; },
      getActivePort: () => 3000,
      pendingStartSettleTimeoutMs: 10,
    });

    await expect(service.stop()).rejects.toMatchObject({ code: 'stop_timeout' });
    expect(controller).toBe(activeController);

    resolveProviderStop(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller).toBeNull();
  });

  it('reports a pending startup cleanup failure instead of reporting stopped', async () => {
    let resolveStart;
    let startCalled;
    const providerStarting = new Promise((resolve) => { startCalled = resolve; });
    let controller = null;
    const provider = createProvider({
      provider: TUNNEL_PROVIDER_CLOUDFLARE,
      start: async () => {
        startCalled();
        return new Promise((resolve) => { resolveStart = resolve; });
      },
      stop: async () => { throw new Error('cleanup failed'); },
    });
    const service = createTunnelService({
      registry: createRegistry({ [TUNNEL_PROVIDER_CLOUDFLARE]: provider }),
      getController: () => controller,
      setController: (next) => { controller = next; },
      getActivePort: () => 3000,
    });
    const starting = service.start({
      provider: TUNNEL_PROVIDER_CLOUDFLARE,
      mode: TUNNEL_MODE_QUICK,
    });
    await providerStarting;
    const stopping = service.stop();
    resolveStart({ getPublicUrl: () => 'https://late.example.com' });

    const [startError, stopError] = await Promise.all([
      starting.catch((error) => error),
      stopping.catch((error) => error),
    ]);
    expect(startError).toBeInstanceOf(Error);
    expect(startError.message).toContain('cleanup failed');
    expect(stopError).toMatchObject({ code: 'stop_failed' });
    expect(controller).toBeNull();
  });

  it('does not stop a newer controller during ownership-scoped cleanup', async () => {
    let controller = null;
    const stopped = [];
    const provider = createProvider({
      provider: TUNNEL_PROVIDER_CLOUDFLARE,
      start: async () => ({ getPublicUrl: () => 'https://first.example.com' }),
      stop: async (active) => { stopped.push(active); },
    });
    const service = createTunnelService({
      registry: createRegistry({ [TUNNEL_PROVIDER_CLOUDFLARE]: provider }),
      getController: () => controller,
      setController: (next) => { controller = next; },
      getActivePort: () => 3000,
    });
    const result = await service.start({
      provider: TUNNEL_PROVIDER_CLOUDFLARE,
      mode: TUNNEL_MODE_QUICK,
    });
    const newerController = {
      provider: TUNNEL_PROVIDER_CLOUDFLARE,
      mode: TUNNEL_MODE_QUICK,
      getPublicUrl: () => 'https://newer.example.com',
    };
    controller = newerController;

    await expect(service.stop(result.controller)).resolves.toBe(false);
    expect(stopped).toEqual([]);
    expect(controller).toBe(newerController);
  });
});
