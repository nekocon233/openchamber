import { describe, expect, test } from 'bun:test';
import { createWindowRuntimeIdentityController } from './window-runtime-identity.mjs';

const createWindow = (url, runtimeConfig = {}) => ({
  __ocRuntimeConfig: runtimeConfig,
  __ocRuntimeKey: null,
  destroyed: false,
  isDestroyed() {
    return this.destroyed;
  },
  webContents: {
    getURL: () => url,
  },
});

const createController = (localWindows) => createWindowRuntimeIdentityController({
  isLocalSender: (webContents) => localWindows.has(webContents),
  runtimeKeyFromConfig: (config) => config?.runtimeKey ?? null,
  runtimeKeyFromUrl: (url, config) => {
    const origin = url ? new URL(url).origin : '';
    return config?.committedOrigin === origin && config?.runtimeKey
      ? config.runtimeKey
      : origin ? `url:${origin}` : null;
  },
});

describe('authoritative Electron window runtime identity', () => {
  test('does not let a remote renderer inherit or claim local identity', () => {
    const localWindows = new Set();
    const browserWindow = createWindow('https://remote.example/app');
    browserWindow.__ocRuntimeKey = 'local';
    const controller = createController(localWindows);

    expect(controller.get(browserWindow)).toBe('url:https://remote.example');
    expect(browserWindow.__ocRuntimeKey).toBe('local');
  });

  test('uses main-owned identity for a legitimate local renderer', () => {
    const localWindows = new Set();
    const browserWindow = createWindow('openchamber-ui://app/index.html', { runtimeKey: 'local' });
    localWindows.add(browserWindow.webContents);
    const controller = createController(localWindows);

    expect(controller.reset(browserWindow)).toBe('local');
    expect(controller.set(browserWindow, 'host:remote')).toBe(true);
    expect(controller.get(browserWindow)).toBe('host:remote');
  });

  test('uses configured host identity only for its committed remote origin', () => {
    const localWindows = new Set();
    const controller = createController(localWindows);
    const matchingWindow = createWindow('https://remote.example/app', {
      committedOrigin: 'https://remote.example',
      runtimeKey: 'host:remote',
    });
    const navigatedWindow = createWindow('https://untrusted.example/app', {
      committedOrigin: 'https://remote.example',
      runtimeKey: 'host:remote',
    });

    expect(controller.get(matchingWindow)).toBe('host:remote');
    expect(controller.get(navigatedWindow)).toBe('url:https://untrusted.example');
  });

  test('resets a local renderer to its main-owned configuration on reload', () => {
    const localWindows = new Set();
    const browserWindow = createWindow('openchamber-ui://app/index.html', { runtimeKey: 'local' });
    localWindows.add(browserWindow.webContents);
    const controller = createController(localWindows);

    controller.set(browserWindow, 'host:remote');
    expect(controller.reset(browserWindow)).toBe('local');
    expect(controller.get(browserWindow)).toBe('local');
  });
});
