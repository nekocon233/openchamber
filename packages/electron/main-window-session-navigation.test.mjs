import { describe, expect, test } from 'bun:test';
import { createMainWindowSessionNavigation } from './main-window-session-navigation.mjs';

const createWindow = () => ({
  destroyed: false,
  isDestroyed() {
    return this.destroyed;
  },
});

describe('main-window session navigation', () => {
  test('waits for the current main renderer before delivering navigation', () => {
    const mainWindow = createWindow();
    const additionalWindow = createWindow();
    const emitted = [];
    const navigation = createMainWindowSessionNavigation({
      getMainWindow: () => mainWindow,
      getWindowRuntimeKey: () => 'runtime-a',
      emitToWindow: (browserWindow, event, detail) => emitted.push({ browserWindow, event, detail }),
    });

    expect(navigation.queue(' session-a ', ' C:\\repo\\a ')).toBe(true);
    expect(navigation.flush(mainWindow)).toBe(false);
    expect(navigation.markReady(additionalWindow)).toBe(false);
    expect(emitted).toEqual([]);

    expect(navigation.markReady(mainWindow)).toBe(true);
    expect(emitted).toEqual([{
      browserWindow: mainWindow,
      event: 'openchamber:open-session',
      detail: { sessionId: 'session-a', directory: 'C:\\repo\\a' },
    }]);
  });

  test('keeps the latest target while a recreated renderer is loading', () => {
    const mainWindow = createWindow();
    const emitted = [];
    const navigation = createMainWindowSessionNavigation({
      getMainWindow: () => mainWindow,
      getWindowRuntimeKey: () => 'runtime-a',
      emitToWindow: (_browserWindow, _event, detail) => emitted.push(detail),
    });

    navigation.markReady(mainWindow);
    navigation.markLoading(mainWindow);
    navigation.queue('session-a', '/repo/a');
    navigation.queue('session-b', '/repo/b');

    expect(navigation.flush(mainWindow)).toBe(false);
    expect(navigation.markReady(mainWindow)).toBe(true);
    expect(emitted).toEqual([{ sessionId: 'session-b', directory: '/repo/b' }]);
  });

  test('does not deliver to a destroyed main window', () => {
    let mainWindow = createWindow();
    const emitted = [];
    const navigation = createMainWindowSessionNavigation({
      getMainWindow: () => mainWindow,
      getWindowRuntimeKey: () => 'runtime-a',
      emitToWindow: (...args) => emitted.push(args),
    });

    navigation.queue('session-a', '/repo/a');
    mainWindow.destroyed = true;

    expect(navigation.markReady(mainWindow)).toBe(false);
    expect(emitted).toEqual([]);

    mainWindow = createWindow();
    expect(navigation.markReady(mainWindow)).toBe(true);
    expect(emitted).toEqual([[
      mainWindow,
      'openchamber:open-session',
      { sessionId: 'session-a', directory: '/repo/a' },
    ]]);
  });

  test('rejects a notification target when runtime switches between display and click', () => {
    const mainWindow = createWindow();
    const emitted = [];
    const navigation = createMainWindowSessionNavigation({
      getMainWindow: () => mainWindow,
      getWindowRuntimeKey: () => 'runtime-b',
      emitToWindow: (_browserWindow, _event, detail) => emitted.push(detail),
    });

    navigation.markReady(mainWindow);
    navigation.queue('session-a', '/local/repo', 'runtime-a');

    expect(navigation.flush(mainWindow)).toBe(false);
    expect(emitted).toEqual([]);
  });

  test('rejects a queued click when runtime switches before readiness', () => {
    const mainWindow = createWindow();
    let authoritativeRuntimeKey = 'runtime-a';
    const emitted = [];
    const navigation = createMainWindowSessionNavigation({
      getMainWindow: () => mainWindow,
      getWindowRuntimeKey: () => authoritativeRuntimeKey,
      emitToWindow: (_browserWindow, _event, detail) => emitted.push(detail),
    });

    navigation.queue('session-a', '/local/repo', 'runtime-a');
    authoritativeRuntimeKey = 'runtime-b';

    expect(navigation.markReady(mainWindow)).toBe(false);
    expect(emitted).toEqual([]);

    authoritativeRuntimeKey = 'runtime-a';
    navigation.markReady(mainWindow);
    expect(emitted).toEqual([]);
  });

  test('ignores a remote renderer claim of local runtime identity', () => {
    const mainWindow = createWindow();
    const emitted = [];
    const navigation = createMainWindowSessionNavigation({
      getMainWindow: () => mainWindow,
      getWindowRuntimeKey: () => 'host:remote',
      emitToWindow: (_browserWindow, _event, detail) => emitted.push(detail),
    });

    navigation.queue('session-local', '/local/private', 'local');

    expect(navigation.markReady(mainWindow, 'local')).toBe(false);
    expect(emitted).toEqual([]);
  });

  test('delivers queued clicks for legitimate local and remote readiness', () => {
    const mainWindow = createWindow();
    let authoritativeRuntimeKey = 'local';
    const emitted = [];
    const navigation = createMainWindowSessionNavigation({
      getMainWindow: () => mainWindow,
      getWindowRuntimeKey: () => authoritativeRuntimeKey,
      emitToWindow: (_browserWindow, _event, detail) => emitted.push(detail),
    });

    navigation.markLoading(mainWindow);
    navigation.queue('session-local', '/repo/local', 'local');
    expect(navigation.markReady(mainWindow)).toBe(true);

    navigation.markLoading(mainWindow);
    authoritativeRuntimeKey = 'host:remote';
    navigation.queue('session-remote', '/repo/remote', 'host:remote');
    expect(navigation.markReady(mainWindow)).toBe(true);

    expect(emitted).toEqual([
      { sessionId: 'session-local', directory: '/repo/local', runtimeKey: 'local' },
      { sessionId: 'session-remote', directory: '/repo/remote', runtimeKey: 'host:remote' },
    ]);
  });
});
