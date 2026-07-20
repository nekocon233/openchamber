import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPushRuntime } from './push-runtime.js';
import {
  configureNotificationAuthValidator,
  createClientNotificationAuth,
  createUiSessionNotificationAuth,
} from './auth-runtime.js';

const createRuntimeHarness = (initialStore = { version: 2, registrationsByIdentity: {} }) => {
  let content = JSON.stringify(initialStore);
  const fsPromises = {
    mkdir: vi.fn(async () => {}),
    readFile: vi.fn(async () => content),
    writeFile: vi.fn(async (_path, value) => {
      content = String(value);
    }),
  };
  const webPush = {
    generateVAPIDKeys: vi.fn(() => ({ publicKey: 'public', privateKey: 'private' })),
    sendNotification: vi.fn(async () => {}),
    setVapidDetails: vi.fn(),
  };
  const runtime = createPushRuntime({
    fsPromises,
    path: { dirname: () => '/tmp' },
    webPush,
    PUSH_SUBSCRIPTIONS_FILE_PATH: '/tmp/push-subscriptions.json',
    readSettingsFromDiskMigrated: vi.fn(async () => ({})),
    writeSettingsToDisk: vi.fn(async () => {}),
  });
  return { runtime, webPush, fsPromises, getContent: () => content };
};

const createRuntime = () => createRuntimeHarness().runtime;

beforeEach(() => {
  configureNotificationAuthValidator(async () => true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('push runtime visibility tracking', () => {
  it('keeps visible UI state when another client reports hidden', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const runtime = createRuntime();

    const visibleClient = createClientNotificationAuth('visible-client');
    const hiddenClient = createClientNotificationAuth('hidden-client');
    runtime.updateUiVisibility(visibleClient, true);
    runtime.updateUiVisibility(hiddenClient, false);

    expect(runtime.isAnyUiVisible()).toBe(true);
    expect(runtime.isUiVisible(visibleClient)).toBe(true);
    expect(runtime.isUiVisible(hiddenClient)).toBe(false);

    vi.advanceTimersByTime(30_001);

    expect(runtime.isAnyUiVisible()).toBe(false);
    expect(runtime.isUiVisible(visibleClient)).toBe(false);
  });

  it('treats only mobile platforms as non-interactive for isAnyInteractiveClientVisible', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const runtime = createRuntime();

    // Only the phone (foreground) is connected → no interactive client to absorb the notification.
    runtime.updateUiVisibility(createClientNotificationAuth('phone'), true, 'ios');
    expect(runtime.isAnyUiVisible()).toBe(true);
    expect(runtime.isAnyInteractiveClientVisible()).toBe(false);

    // A visible desktop counts as interactive → suppress mobile push.
    runtime.updateUiVisibility(createClientNotificationAuth('desktop'), true, 'desktop');
    expect(runtime.isAnyInteractiveClientVisible()).toBe(true);

    // Desktop hidden again → back to mobile-only, push should flow to the phone.
    runtime.updateUiVisibility(createClientNotificationAuth('desktop'), false, 'desktop');
    expect(runtime.isAnyInteractiveClientVisible()).toBe(false);

    // A client that never reported a platform is treated as interactive (conservative).
    runtime.updateUiVisibility(createClientNotificationAuth('legacy'), true);
    expect(runtime.isAnyInteractiveClientVisible()).toBe(true);
  });

  it('remembers the last platform when a heartbeat omits it', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const runtime = createRuntime();
    const phone = createClientNotificationAuth('phone');
    runtime.updateUiVisibility(phone, true, 'android');
    runtime.updateUiVisibility(phone, true); // heartbeat without platform
    expect(runtime.isAnyInteractiveClientVisible()).toBe(false);
  });
});

describe('push runtime auth association', () => {
  it('persists only an opaque identity instead of the UI session credential', async () => {
    const { runtime, getContent } = createRuntimeHarness();
    const rawSession = 'header.payload.signature-secret';
    const auth = createUiSessionNotificationAuth(rawSession, Date.now() + 60_000);

    await runtime.addOrUpdatePushSubscription(auth, {
      endpoint: 'https://push.example/subscription',
      p256dh: 'p256dh',
      auth: 'push-auth',
    });

    const persisted = getContent();
    expect(persisted).not.toContain(rawSession);
    expect(persisted).toContain(auth.identity);
    expect(JSON.parse(persisted).version).toBe(2);
  });

  it('does not deliver and removes a registration after its auth expires', async () => {
    const { runtime, webPush, getContent } = createRuntimeHarness();
    const auth = createUiSessionNotificationAuth('expired-session', Date.now() - 1);
    await runtime.addOrUpdatePushSubscription(auth, {
      endpoint: 'https://push.example/expired',
      p256dh: 'p256dh',
      auth: 'push-auth',
    });

    await runtime.sendPushToAllUiSessions({ title: 'Ready' });

    expect(webPush.sendNotification).not.toHaveBeenCalled();
    expect(JSON.parse(getContent()).registrationsByIdentity).toEqual({});
  });

  it('sanitizes legacy credential-keyed records without delivering them', async () => {
    const rawSession = 'legacy.jwt.session-secret';
    const { runtime, webPush, getContent } = createRuntimeHarness({
      version: 1,
      subscriptionsBySession: {
        [rawSession]: [{ endpoint: 'https://push.example/legacy', p256dh: 'p', auth: 'a' }],
      },
    });

    await runtime.sendPushToAllUiSessions({ title: 'Ready' });

    expect(webPush.sendNotification).not.toHaveBeenCalled();
    expect(getContent()).not.toContain(rawSession);
    expect(JSON.parse(getContent())).toEqual({ version: 2, registrationsByIdentity: {} });
  });

  it('fails closed and preserves an unknown future schema version', async () => {
    const futureStore = {
      version: 3,
      registrationsByIdentity: {
        future: { unsupported: true },
      },
    };
    const { runtime, webPush, fsPromises, getContent } = createRuntimeHarness(futureStore);
    const original = getContent();

    await expect(runtime.sendPushToAllUiSessions({ title: 'Ready' })).rejects.toThrow(
      'Unsupported push subscriptions schema version',
    );

    expect(webPush.sendNotification).not.toHaveBeenCalled();
    expect(fsPromises.writeFile).not.toHaveBeenCalled();
    expect(getContent()).toBe(original);
  });

  it('keeps records but skips delivery when authoritative auth validation is unavailable', async () => {
    const { runtime, webPush, getContent } = createRuntimeHarness();
    const auth = createClientNotificationAuth('validation-error');
    await runtime.addOrUpdatePushSubscription(auth, {
      endpoint: 'https://push.example/unknown',
      p256dh: 'p256dh',
      auth: 'push-auth',
    });
    configureNotificationAuthValidator(async () => {
      throw new Error('auth store unavailable');
    });

    await runtime.sendPushToAllUiSessions({ title: 'Ready' });

    expect(webPush.sendNotification).not.toHaveBeenCalled();
    expect(JSON.parse(getContent()).registrationsByIdentity[auth.identity]).toBeTruthy();
  });
});
