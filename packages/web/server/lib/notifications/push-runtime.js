import {
  normalizeNotificationAuth,
  notificationAuthMatchesSelector,
  validateNotificationAuth,
} from './auth-runtime.js';

const PUSH_SUBSCRIPTIONS_VERSION = 2;
const UNSUPPORTED_PUSH_SUBSCRIPTIONS_VERSION = 'UNSUPPORTED_PUSH_SUBSCRIPTIONS_VERSION';
const UI_VISIBILITY_TTL_MS = 30_000;

const isLoopbackHttpOrigin = (value) => {
  if (typeof value !== 'string') {
    return false;
  }

  return value.startsWith('http://localhost')
    || value.startsWith('http://127.0.0.1')
    || value.startsWith('http://[::1]');
};

export const createPushRuntime = (deps) => {
  const {
    fsPromises,
    path,
    webPush,
    PUSH_SUBSCRIPTIONS_FILE_PATH,
    readSettingsFromDiskMigrated,
    writeSettingsToDisk,
  } = deps;

  let persistPushSubscriptionsLock = Promise.resolve();
  let legacySanitizationPromise = null;
  let pushInitialized = false;

  const emptyStore = () => ({
    version: PUSH_SUBSCRIPTIONS_VERSION,
    registrationsByIdentity: {},
  });

  const uiVisibilityByIdentity = new Map();
  const pruneUiVisibility = (now = Date.now()) => {
    for (const [identity, state] of uiVisibilityByIdentity) {
      if (!state || now - state.updatedAt > UI_VISIBILITY_TTL_MS) {
        uiVisibilityByIdentity.delete(identity);
      }
    }
  };

  const readPushSubscriptionsFromDisk = async () => {
    try {
      const raw = await fsPromises.readFile(PUSH_SUBSCRIPTIONS_FILE_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') {
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
        const error = new Error('Unsupported push subscriptions schema version');
        error.code = UNSUPPORTED_PUSH_SUBSCRIPTIONS_VERSION;
        throw error;
      }

      const registrationsByIdentity =
        parsed.registrationsByIdentity && typeof parsed.registrationsByIdentity === 'object'
          ? parsed.registrationsByIdentity
          : {};

      return { version: PUSH_SUBSCRIPTIONS_VERSION, registrationsByIdentity };
    } catch (error) {
      if (error?.code === UNSUPPORTED_PUSH_SUBSCRIPTIONS_VERSION) throw error;
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        return emptyStore();
      }
      console.warn('Failed to read push subscriptions file:', error);
      return emptyStore();
    }
  };

  const writePushSubscriptionsToDisk = async (data) => {
    await fsPromises.mkdir(path.dirname(PUSH_SUBSCRIPTIONS_FILE_PATH), { recursive: true });
    await fsPromises.writeFile(PUSH_SUBSCRIPTIONS_FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
  };

  const persistPushSubscriptionUpdate = async (mutate) => {
    const operation = persistPushSubscriptionsLock.catch(() => {}).then(async () => {
      await fsPromises.mkdir(path.dirname(PUSH_SUBSCRIPTIONS_FILE_PATH), { recursive: true });
      const current = await readPushSubscriptionsFromDisk();
      const next = mutate({
        version: PUSH_SUBSCRIPTIONS_VERSION,
        registrationsByIdentity: current.registrationsByIdentity || {},
      });
      await writePushSubscriptionsToDisk(next);
      return next;
    });
    persistPushSubscriptionsLock = operation.catch(() => {});
    return operation;
  };

  const getOrCreateVapidKeys = async () => {
    const settings = await readSettingsFromDiskMigrated();
    const existing = settings?.vapidKeys;
    if (existing && typeof existing.publicKey === 'string' && typeof existing.privateKey === 'string') {
      return { publicKey: existing.publicKey, privateKey: existing.privateKey };
    }

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

  const normalizePushSubscriptions = (record) => {
    if (!Array.isArray(record)) return [];
    return record
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const endpoint = entry.endpoint;
        const p256dh = entry.p256dh;
        const auth = entry.auth;
        if (typeof endpoint !== 'string' || typeof p256dh !== 'string' || typeof auth !== 'string') {
          return null;
        }
        return {
          endpoint,
          p256dh,
          auth,
          createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : null,
          lastSeenAt: typeof entry.lastSeenAt === 'number' ? entry.lastSeenAt : null,
          userAgent: typeof entry.userAgent === 'string' ? entry.userAgent : undefined,
          platform: typeof entry.platform === 'string' ? entry.platform : undefined,
        };
      })
      .filter(Boolean);
  };

  const normalizeRegistration = (record) => {
    if (!record || typeof record !== 'object') return null;
    const auth = normalizeNotificationAuth(record.auth);
    if (!auth) return null;
    return {
      auth,
      subscriptions: normalizePushSubscriptions(record.subscriptions),
    };
  };

  const addOrUpdatePushSubscription = async (authValue, subscription, userAgent, platform) => {
    const auth = normalizeNotificationAuth(authValue);
    if (!auth) return;

    await ensurePushInitialized();

    const now = Date.now();

    await persistPushSubscriptionUpdate((current) => {
      const registrationsByIdentity = { ...(current.registrationsByIdentity || {}) };
      const registration = normalizeRegistration(registrationsByIdentity[auth.identity]);
      const existing = registration?.subscriptions || [];

      const filtered = existing.filter((entry) => entry && typeof entry.endpoint === 'string' && entry.endpoint !== subscription.endpoint);

      const previous = existing.find((entry) => entry && entry.endpoint === subscription.endpoint);
      filtered.unshift({
        endpoint: subscription.endpoint,
        p256dh: subscription.p256dh,
        auth: subscription.auth,
        createdAt: now,
        lastSeenAt: now,
        userAgent: typeof userAgent === 'string' && userAgent.length > 0 ? userAgent : undefined,
        // Platform lets the sender route mobile PWA push through the same presence gate as APNs.
        platform:
          typeof platform === 'string' && platform
            ? platform
            : typeof previous?.platform === 'string'
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

  const removePushSubscription = async (authOrSelector, endpoint) => {
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

  const removePushSubscriptionFromAllSessions = async (endpoint) => {
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

  const sendPushToSubscription = async (sub, payload) => {
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
      await webPush.sendNotification(pushSubscription, body);
    } catch (error) {
      const statusCode = typeof error?.statusCode === 'number' ? error.statusCode : null;
      if (statusCode === 410 || statusCode === 404) {
        await removePushSubscriptionFromAllSessions(sub.endpoint);
        return;
      }
      console.warn('[Push] Failed to send notification:', error);
    }
  };

  const sendPushToAllUiSessions = async (payload, options = {}) => {
    const requireNoSse = options.requireNoSse === true;
    const store = await readPushSubscriptionsFromDisk();
    const registrations = store.registrationsByIdentity || {};
    const subscriptionsByEndpoint = new Map();
    const inactiveAuth = [];

    await Promise.all(Object.values(registrations).map(async (rawRegistration) => {
      const registration = normalizeRegistration(rawRegistration);
      if (!registration || registration.subscriptions.length === 0) return;
      const authStatus = await validateNotificationAuth(registration.auth);
      if (authStatus === 'inactive') {
        inactiveAuth.push(registration.auth);
        return;
      }
      if (authStatus !== 'active') return;

      for (const sub of registration.subscriptions) {
        if (!subscriptionsByEndpoint.has(sub.endpoint)) {
          subscriptionsByEndpoint.set(sub.endpoint, sub);
        }
      }
    }));

    await Promise.all(inactiveAuth.map((auth) => removePushSubscription(auth).catch(() => {})));

    await Promise.all(Array.from(subscriptionsByEndpoint.values()).map(async (sub) => {
      if (requireNoSse) {
        // Mobile PWA subscriptions follow the same presence model as native push: suppress only
        // when an interactive (desktop/web) client is visible. The phone PWA's own foreground is
        // handled in the service worker (focused-client check), so it won't double-notify.
        // Non-mobile (desktop/web) subscriptions keep the existing any-visible gate.
        const suppressed = isMobilePlatform(sub.platform) ? isAnyInteractiveClientVisible() : isAnyUiVisible();
        if (suppressed) return;
      }
      await sendPushToSubscription(sub, payload);
    }));
  };

  // A client is "mobile" if it reports a native mobile platform. Anything else (web, desktop,
  // vscode, or an older client that doesn't report a platform) is treated as interactive — i.e.
  // a surface where the user would actually see the in-app notification.
  const MOBILE_PLATFORMS = new Set(['ios', 'android']);
  const isMobilePlatform = (platform) => typeof platform === 'string' && MOBILE_PLATFORMS.has(platform);

  const updateUiVisibility = (authValue, visible, platform) => {
    const auth = normalizeNotificationAuth(authValue);
    if (!auth) return;
    const now = Date.now();
    const nextVisible = Boolean(visible);
    const existing = uiVisibilityByIdentity.get(auth.identity);
    // Keep the last known platform if this beacon didn't carry one (e.g. a heartbeat).
    const nextPlatform = typeof platform === 'string' && platform ? platform : existing?.platform;
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

  // True when at least one NON-mobile client (desktop/web/vscode) is currently visible. Used to
  // suppress native push to the phone: an active desktop already shows the notification, so the
  // phone doesn't need it. Deliberately based on the desktop's visibility (reliable), never the
  // phone's own (a backgrounded WKWebView can't report "hidden" before iOS suspends it).
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

  const isUiVisible = (authValue) => {
    const auth = normalizeNotificationAuth(authValue);
    if (!auth) return false;
    const now = Date.now();
    pruneUiVisibility(now);
    const state = uiVisibilityByIdentity.get(auth.identity);
    return state?.visible === true && now - state.updatedAt <= UI_VISIBILITY_TTL_MS;
  };

  const resolveVapidSubject = async () => {
    const configured = process.env.OPENCHAMBER_VAPID_SUBJECT;
    if (typeof configured === 'string' && configured.trim().length > 0) {
      return configured.trim();
    }

    const originEnv = process.env.OPENCHAMBER_PUBLIC_ORIGIN;
    if (typeof originEnv === 'string' && originEnv.trim().length > 0) {
      const trimmed = originEnv.trim();
      if (isLoopbackHttpOrigin(trimmed)) {
        return 'mailto:openchamber@localhost';
      }
      return trimmed;
    }

    try {
      const settings = await readSettingsFromDiskMigrated();
      const stored = settings?.publicOrigin;
      if (typeof stored === 'string' && stored.trim().length > 0) {
        const trimmed = stored.trim();
        if (isLoopbackHttpOrigin(trimmed)) {
          return 'mailto:openchamber@localhost';
        }
        return trimmed;
      }
    } catch {
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

    webPush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
    pushInitialized = true;
  };

  const setPushInitialized = (value) => {
    pushInitialized = value === true;
  };

  return {
    getOrCreateVapidKeys,
    addOrUpdatePushSubscription,
    removePushSubscription,
    sendPushToAllUiSessions,
    updateUiVisibility,
    isAnyUiVisible,
    isAnyInteractiveClientVisible,
    isUiVisible,
    ensurePushInitialized,
    setPushInitialized,
  };
};
