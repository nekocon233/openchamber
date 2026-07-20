import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGracefulShutdownRuntime } from './shutdown-runtime.js';

const createRuntime = (server, overrides = {}) => createGracefulShutdownRuntime({
  process: { exit: vi.fn() },
  shutdownTimeoutMs: 1000,
  getExitOnShutdown: () => false,
  getIsShuttingDown: () => false,
  setIsShuttingDown: vi.fn(),
  syncToHmrState: vi.fn(),
  openCodeWatcherRuntime: { stop: vi.fn() },
  sessionRuntime: { dispose: vi.fn() },
  scheduledTasksRuntime: { stop: vi.fn() },
  getHealthCheckInterval: () => null,
  clearHealthCheckInterval: vi.fn(),
  getTerminalRuntime: () => null,
  setTerminalRuntime: vi.fn(),
  getMessageStreamRuntime: () => null,
  setMessageStreamRuntime: vi.fn(),
  shouldSkipOpenCodeStop: () => true,
  getOpenCodePort: () => null,
  getOpenCodeProcess: () => null,
  setOpenCodeProcess: vi.fn(),
  killProcessOnPort: vi.fn(),
  waitForPortRelease: vi.fn(async () => true),
  getServer: () => server,
  getUiAuthController: () => null,
  setUiAuthController: vi.fn(),
  getActiveTunnelController: () => null,
  setActiveTunnelController: vi.fn(),
  tunnelAuthController: { clearActiveTunnel: vi.fn() },
  ...overrides,
});

describe('graceful shutdown runtime', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('clears the server close timeout when the server closes first', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const server = {
      close: vi.fn((callback) => {
        callback();
      }),
    };

    const runtime = createRuntime(server);
    await runtime.gracefulShutdown({ exitProcess: false });

    await vi.advanceTimersByTimeAsync(1000);

    expect(warnSpy).not.toHaveBeenCalledWith('Server close timeout reached, forcing shutdown');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not clear tunnel state before asynchronous process termination', async () => {
    let resolveStop;
    const stop = vi.fn(() => new Promise((resolve) => { resolveStop = resolve; }));
    const setActiveTunnelController = vi.fn();
    const clearActiveTunnel = vi.fn();
    const runtime = createRuntime(null, {
      getActiveTunnelController: () => ({ stop }),
      setActiveTunnelController,
      tunnelAuthController: { clearActiveTunnel },
    });

    const shuttingDown = runtime.gracefulShutdown({ exitProcess: false });
    await Promise.resolve();
    expect(stop).toHaveBeenCalledOnce();
    expect(setActiveTunnelController).not.toHaveBeenCalled();
    expect(clearActiveTunnel).not.toHaveBeenCalled();

    resolveStop(true);
    await shuttingDown;
    expect(setActiveTunnelController).toHaveBeenCalledWith(null);
    expect(clearActiveTunnel).toHaveBeenCalledOnce();
  });

  it('preserves tunnel state on termination failure while still allowing process exit', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stop = vi.fn(async () => { throw new Error('still running'); });
    const setActiveTunnelController = vi.fn();
    const clearActiveTunnel = vi.fn();
    const processRuntime = { exit: vi.fn() };
    const runtime = createRuntime(null, {
      process: processRuntime,
      getActiveTunnelController: () => ({ stop }),
      setActiveTunnelController,
      tunnelAuthController: { clearActiveTunnel },
    });

    await runtime.gracefulShutdown({ exitProcess: true });

    expect(stop).toHaveBeenCalledOnce();
    expect(setActiveTunnelController).not.toHaveBeenCalled();
    expect(clearActiveTunnel).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith('Failed to confirm active tunnel termination during shutdown');
    expect(processRuntime.exit).toHaveBeenCalledWith(0);
  });
});
