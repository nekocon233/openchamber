import { deliverableDevices } from './registered-devices.js';
import {
  type NotificationAuth,
  type NotificationRegistrationFilter,
  normalizeNotificationAuth,
  notificationAuthMatchesSelector,
  parseNotificationRegistrationAuth,
} from './auth-runtime.js';
import { pairedSessionKey } from './session-key.js';
import { hasStatusCode, isJsonObject, isMissingFile, isNumber, isString } from './inputs.js';
import type { JsonValue, PushSettings } from './contracts.js';

interface PushStore {
  version: number;
  registrationsByIdentity: Record<string, JsonValue | PushRegistration | undefined>;
}

interface PushRegistration {
  auth: NotificationAuth;
  subscriptions: PushSubscription[];
}

interface PushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
  createdAt: number | null;
  lastSeenAt: number | null;
  userAgent: string | undefined;
  platform: string | undefined;
}

interface PushDependencies {
  fsPromises: Pick<typeof import('node:fs/promises'), 'readFile' | 'mkdir' | 'writeFile'>;
  path: Pick<typeof import('node:path'), 'dirname'>;
  loadWebPush: () => Promise<{
    generateVAPIDKeys: () => { publicKey: string; privateKey: string };
    setVapidDetails: (subject: string, publicKey: string, privateKey: string) => void;
    sendNotification: (subscription: { endpoint: string; keys: { p256dh: string; auth: string } }, body: string) => Promise<{
      statusCode: number;
      body: string;
      headers: import('node:http').IncomingHttpHeaders;
    }>;
  }>;
  PUSH_SUBSCRIPTIONS_FILE_PATH: string;
  readSettingsFromDiskMigrated: () => Promise<PushSettings>;
  writeSettingsToDisk: (settings: PushSettings) => Promise<void>;
  getInvalidSessionKeys?: () => Promise<Set<string>>;
}

const PUSH_SUBSCRIPTIONS_VERSION = 2;
const UNSUPPORTED_PUSH_SUBSCRIPTIONS_VERSION = 'UNSUPPORTED_PUSH_SUBSCRIPTIONS_VERSION';
const UI_VISIBILITY_TTL_MS = 30_000;

const isLoopbackHttpOrigin = (value: string) => {
  return value.startsWith('http://localhost')
    || value.startsWith('http://127.0.0.1')
    || value.startsWith('http://[::1]');
};

export const createPushRuntime = (deps: PushDependencies) => {
  const {
    fsPromises,
    path,
    loadWebPush,
    PUSH_SUBSCRIPTIONS_FILE_PATH,
    readSettingsFromDiskMigrated,
    writeSettingsToDisk,
    getInvalidSessionKeys = async () => new Set<string>(),
  } = deps;

  let persistPushSubscriptionsLock: Promise<void | PushStore> = Promise.resolve();
  let legacySanitizationPromise: Promise<void> | null = null;
  let pushInitialized = false;

  const emptyStore = (): PushStore => ({
    version: PUSH_SUBSCRIPTIONS_VERSION,
    registrationsByIdentity: {},
  });

  const uiVisibilityByIdentity = new Map<string, { auth: NotificationAuth; visible: boolean; updatedAt: number; platform: string | undefined }>();
  const pruneUiVisibility = (now = Date.now()) => {
    for (const [identity, state] of uiVisibilityByIdentity) {
      if (!state || now - state.updatedAt > UI_VISIBILITY_TTL_MS) {
        uiVisibilityByIdentity.delete(identity);
      }
    }
  };

  const readPushSubscriptionsFromDisk = async (): Promise<PushStore> => {
    try {
      const raw = await fsPromises.readFile(PUSH_SUBSCRIPTIONS_FILE_PATH, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!isJsonObject(parsed)) {
        return emptyStore();
      }
      if (parsed.version === 1) {
        if (!legacySanitizationPromise) {
          legacySanitizationPromise = (async () => {
            const sanitized = emptyStore();
            await fsPromises.mkdir(path.dirname(PUSH_SUBSCRIPTIONS_FILE_PATH), { recursive: true });
            await fsPromises.writeFile(PUSH_SUBSCRIPTIONS_FILE_PATH, JSON.stringify(sanitized, null, 2), 'utf8');
          })().finally(() => {
            legacySanitizationPromise = null;
          });
        }
        await legacySanitizationPromise;
        return emptyStore();
      }
      if (parsed.version !== PUSH_SUBSCRIPTIONS_VERSION) {
        throw Object.assign(new Error('Unsupported push subscriptions schema version'), { code: UNSUPPORTED_PUSH_SUBSCRIPTIONS_VERSION });
      }

      const registrationsByIdentity =
        isJsonObject(parsed.registrationsByIdentity) && !Array.isArray(parsed.registrationsByIdentity)
          ? parsed.registrationsByIdentity
          : {};

      return { version: PUSH_SUBSCRIPTIONS_VERSION, registrationsByIdentity };
    } catch (error) {
      if (isJsonObject(error) && error.code === UNSUPPORTED_PUSH_SUBSCRIPTIONS_VERSION) throw error;
      if (isMissingFile(error)) {
        return emptyStore();
      }
      console.warn('Failed to read push subscriptions file:', error);
      return emptyStore();
    }
  };

  const writePushSubscriptionsToDisk = async (data: PushStore) => {
    await fsPromises.mkdir(path.dirname(PUSH_SUBSCRIPTIONS_FILE_PATH), { recursive: true });
    await fsPromises.writeFile(PUSH_SUBSCRIPTIONS_FILE_PATH, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  };

  const persistPushSubscriptionUpdate = async (mutate: (store: PushStore) => PushStore) => {
    const result = persistPushSubscriptionsLock.then(async () => {
      await fsPromises.mkdir(path.dirname(PUSH_SUBSCRIPTIONS_FILE_PATH), { recursive: true });
      const current = await readPushSubscriptionsFromDisk();
      const next = mutate({
        version: PUSH_SUBSCRIPTIONS_VERSION,
        registrationsByIdentity: current.registrationsByIdentity || {},
      });
      await writePushSubscriptionsToDisk(next);
      return next;
    });
    persistPushSubscriptionsLock = result.catch(() => {});
    return result;
  };

  const getOrCreateVapidKeys = async () => {
    const settings = await readSettingsFromDiskMigrated();
    const existing = settings?.vapidKeys;
    if (isJsonObject(existing) && isString(existing.publicKey) && isString(existing.privateKey)) {
      return { publicKey: existing.publicKey, privateKey: existing.privateKey };
    }

    const webPush = await loadWebPush();
    const generated = webPush.generateVAPIDKeys();
    const next = {
      ...settings,
      vapidKeys: {
        publicKey: generated.publicKey,
        privateKey: generated.privateKey,
      },
    };

    await writeSettingsToDisk(next);
    return { publicKey: generated.publicKey, privateKey: generated.privateKey };
  };

  const normalizePushSubscriptions = (record: JsonValue | undefined): PushSubscription[] => {
    if (!Array.isArray(record)) return [];
    return record
      .map((entry) => {
        if (!isJsonObject(entry)) return null;
        const endpoint = entry.endpoint;
        const p256dh = entry.p256dh;
        const auth = entry.auth;
        if (!isString(endpoint) || !isString(p256dh) || !isString(auth)) {
          return null;
        }
        return {
          endpoint,
          p256dh,
          auth,
          createdAt: isNumber(entry.createdAt) ? entry.createdAt : null,
          lastSeenAt: isNumber(entry.lastSeenAt) ? entry.lastSeenAt : null,
          userAgent: isString(entry.userAgent) ? entry.userAgent : undefined,
          platform: isString(entry.platform) ? entry.platform : undefined,
        };
      })
      .filter((entry) => entry !== null);
  };

  const normalizeRegistration = (record: PushStore['registrationsByIdentity'][string]): PushRegistration | null => {
    if (!isJsonObject(record)) return null;
    const auth = normalizeNotificationAuth(record.auth);
    if (!auth) return null;
    return {
      auth,
      subscriptions: normalizePushSubscriptions(record.subscriptions),
    };
  };

  const addOrUpdatePushSubscription = async (authValue: Parameters<typeof parseNotificationRegistrationAuth>[0], subscription: Pick<PushSubscription, 'endpoint' | 'p256dh' | 'auth'>, userAgent?: string, platform?: string) => {
    const auth = parseNotificationRegistrationAuth(authValue);
    if (!auth) return;

    await ensurePushInitialized();

    const now = Date.now();

    await persistPushSubscriptionUpdate((current) => {
      const registrationsByIdentity = { ...(current.registrationsByIdentity || {}) };
      const registration = normalizeRegistration(registrationsByIdentity[auth.identity]);
      const existing = registration?.subscriptions || [];

      const filtered = existing.filter((entry) => isJsonObject(entry) && isString(entry.endpoint) && entry.endpoint !== subscription.endpoint);

      const previous = existing.find((entry) => isJsonObject(entry) && entry.endpoint === subscription.endpoint);
      filtered.unshift({
        endpoint: subscription.endpoint,
        p256dh: subscription.p256dh,
        auth: subscription.auth,
        createdAt: now,
        lastSeenAt: now,
        userAgent: userAgent && userAgent.length > 0 ? userAgent : undefined,
        platform:
          platform
            ? platform
            : isJsonObject(previous) && isString(previous.platform)
              ? previous.platform
              : undefined,
      });

      registrationsByIdentity[auth.identity] = {
        auth,
        subscriptions: filtered.slice(0, 10),
      };

      return { version: PUSH_SUBSCRIPTIONS_VERSION, registrationsByIdentity };
    });
  };

  const removePushSubscription = async (authOrSelector: NotificationRegistrationFilter, endpoint?: string) => {
    if (!authOrSelector) return;

    if (!endpoint) {
      for (const [identity, state] of uiVisibilityByIdentity) {
        if (notificationAuthMatchesSelector(state?.auth, authOrSelector)) {
          uiVisibilityByIdentity.delete(identity);
        }
      }
    }

    await persistPushSubscriptionUpdate((current) => {
      const registrationsByIdentity = { ...(current.registrationsByIdentity || {}) };
      for (const [identity, rawRegistration] of Object.entries(registrationsByIdentity)) {
        const registration = normalizeRegistration(rawRegistration);
        if (!registration || !notificationAuthMatchesSelector(registration.auth, authOrSelector)) continue;
        if (!endpoint) {
          delete registrationsByIdentity[identity];
          uiVisibilityByIdentity.delete(identity);
          continue;
        }
        const filtered = registration.subscriptions.filter((entry) => entry.endpoint !== endpoint);
        if (filtered.length === 0) delete registrationsByIdentity[identity];
        else registrationsByIdentity[identity] = { auth: registration.auth, subscriptions: filtered };
      }
      return { version: PUSH_SUBSCRIPTIONS_VERSION, registrationsByIdentity };
    });
  };

  const removePushSubscriptionFromAllSessions = async (endpoint: string) => {
    if (!endpoint) return;

    await persistPushSubscriptionUpdate((current) => {
      const registrationsByIdentity = { ...(current.registrationsByIdentity || {}) };
      for (const [identity, rawRegistration] of Object.entries(registrationsByIdentity)) {
        const registration = normalizeRegistration(rawRegistration);
        if (!registration) {
          delete registrationsByIdentity[identity];
          continue;
        }
        const filtered = registration.subscriptions.filter((entry) => entry.endpoint !== endpoint);
        if (filtered.length === 0) {
          delete registrationsByIdentity[identity];
        } else {
          registrationsByIdentity[identity] = { auth: registration.auth, subscriptions: filtered };
        }
      }
      return { version: PUSH_SUBSCRIPTIONS_VERSION, registrationsByIdentity };
    });
  };

  const removePushDevicesOfSessions = async (sessionKeys: string[], keep: Set<string>) => {
    const removed = new Set(sessionKeys);
    await persistPushSubscriptionUpdate((current) => {
      const registrationsByIdentity = { ...current.registrationsByIdentity };
      const devices = new Set<string>();
      for (const raw of Object.values(registrationsByIdentity)) {
        const registration = normalizeRegistration(raw);
        const key = registration && pairedSessionKey(registration.auth);
        if (!registration || !key || !removed.has(key)) continue;
        for (const device of registration.subscriptions) devices.add(device.endpoint);
      }
      for (const [identity, raw] of Object.entries(registrationsByIdentity)) {
        const registration = normalizeRegistration(raw);
        if (!registration) continue;
        const key = pairedSessionKey(registration.auth);
        if (key && keep.has(key)) continue;
        const remaining = registration.subscriptions.filter((device) => !devices.has(device.endpoint));
        if (remaining.length === registration.subscriptions.length) continue;
        if (remaining.length === 0) delete registrationsByIdentity[identity];
        else registrationsByIdentity[identity] = { auth: registration.auth, subscriptions: remaining };
      }
      return { ...current, registrationsByIdentity };
    });
  };

  const sendPushToSubscription = async <Payload>(sub: PushSubscription, payload: Payload) => {
    await ensurePushInitialized();
    const body = JSON.stringify(payload);

    const pushSubscription = {
      endpoint: sub.endpoint,
      keys: {
        p256dh: sub.p256dh,
        auth: sub.auth,
      },
    };

    try {
      const webPush = await loadWebPush();
      await webPush.sendNotification(pushSubscription, body);
    } catch (error) {
      const statusCode = hasStatusCode(error) ? error.statusCode : null;
      if (statusCode === 410 || statusCode === 404) {
        await removePushSubscriptionFromAllSessions(sub.endpoint);
        return;
      }
      console.warn('[Push] Failed to send notification:', error);
    }
  };

  const sendPushToAllUiSessions = async <Payload>(payload: Payload, options: { requireNoSse?: boolean } = {}) => {
    const requireNoSse = options.requireNoSse === true;
    const store = await readPushSubscriptionsFromDisk();
    const invalidSessionKeys = await getInvalidSessionKeys();
    const registrations = Object.values(store.registrationsByIdentity).flatMap((raw) => {
      const registration = normalizeRegistration(raw);
      return registration ? [{ auth: registration.auth, devices: registration.subscriptions }] : [];
    });
    const devices = await deliverableDevices(registrations, invalidSessionKeys, (device) => device.endpoint, removePushSubscription);
    await Promise.all(devices.map(async (sub) => {
      if (requireNoSse) {
        const suppressed = isMobilePlatform(sub.platform) ? isAnyInteractiveClientVisible() : isAnyUiVisible();
        if (suppressed) return;
      }
      await sendPushToSubscription(sub, payload);
    }));
  };

  const MOBILE_PLATFORMS = new Set(['ios', 'android']);
  const isMobilePlatform = (platform: string | undefined) => platform !== undefined && MOBILE_PLATFORMS.has(platform);

  const updateUiVisibility = (authValue: NotificationAuth | null, visible: boolean, platform?: string) => {
    const auth = normalizeNotificationAuth(authValue);
    if (!auth) return;
    const now = Date.now();
    const nextVisible = Boolean(visible);
    const existing = uiVisibilityByIdentity.get(auth.identity);
    const nextPlatform = isString(platform) && platform ? platform : existing?.platform;
    uiVisibilityByIdentity.set(auth.identity, {
      auth,
      visible: nextVisible,
      updatedAt: now,
      platform: nextPlatform,
    });
  };

  const isAnyUiVisible = () => {
    const now = Date.now();
    pruneUiVisibility(now);
    for (const state of uiVisibilityByIdentity.values()) {
      if (state.visible === true && now - state.updatedAt <= UI_VISIBILITY_TTL_MS) {
        return true;
      }
    }
    return false;
  };

  const isAnyInteractiveClientVisible = () => {
    const now = Date.now();
    pruneUiVisibility(now);
    for (const state of uiVisibilityByIdentity.values()) {
      if (
        state.visible === true &&
        now - state.updatedAt <= UI_VISIBILITY_TTL_MS &&
        !isMobilePlatform(state.platform)
      ) {
        return true;
      }
    }
    return false;
  };

  const isUiVisible = (authValue: NotificationAuth | null) => {
    const auth = normalizeNotificationAuth(authValue);
    if (!auth) return false;
    const now = Date.now();
    pruneUiVisibility(now);
    const state = uiVisibilityByIdentity.get(auth.identity);
    return state?.visible === true && now - state.updatedAt <= UI_VISIBILITY_TTL_MS;
  };

  const resolveVapidSubject = async () => {
    const configured = process.env.OPENCHAMBER_VAPID_SUBJECT;
    if (isString(configured) && configured.trim().length > 0) {
      return configured.trim();
    }

    const originEnv = process.env.OPENCHAMBER_PUBLIC_ORIGIN;
    if (isString(originEnv) && originEnv.trim().length > 0) {
      const trimmed = originEnv.trim();
      if (isLoopbackHttpOrigin(trimmed)) {
        return 'mailto:openchamber@localhost';
      }
      return trimmed;
    }

    try {
      const settings = await readSettingsFromDiskMigrated();
      const stored = settings?.publicOrigin;
      if (isString(stored) && stored.trim().length > 0) {
        const trimmed = stored.trim();
        if (isLoopbackHttpOrigin(trimmed)) {
          return 'mailto:openchamber@localhost';
        }
        return trimmed;
      }
    } catch {
      return 'mailto:openchamber@localhost';
    }

    return 'mailto:openchamber@localhost';
  };

  const ensurePushInitialized = async () => {
    if (pushInitialized) return;
    const keys = await getOrCreateVapidKeys();
    const subject = await resolveVapidSubject();

    if (subject === 'mailto:openchamber@localhost') {
      console.warn('[Push] No public origin configured for VAPID; set OPENCHAMBER_VAPID_SUBJECT or enable push once from a real origin.');
    }

    const webPush = await loadWebPush();
    webPush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
    pushInitialized = true;
  };

  const setPushInitialized = (value: boolean) => {
    pushInitialized = value === true;
  };

  return {
    getOrCreateVapidKeys,
    addOrUpdatePushSubscription,
    removePushSubscription,
    removePushDevicesOfSessions,
    sendPushToAllUiSessions,
    updateUiVisibility,
    isAnyUiVisible,
    isAnyInteractiveClientVisible,
    isUiVisible,
    ensurePushInitialized,
    setPushInitialized,
  };
};
