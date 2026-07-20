const MAX_TIMEOUT_MS = 2_147_483_647;

const hasPrivateRelayMarker = (req) => {
  const value = req?.headers?.['x-openchamber-relay-connection'];
  if (Array.isArray(value)) return value.some((entry) => typeof entry === 'string' && entry.length > 0);
  return typeof value === 'string' && value.length > 0;
};

export const authorizeWebSocketUpgrade = async ({
  req,
  uiAuthController,
  tunnelAuthController,
  isRequestOriginAllowed,
}) => {
  const privateRelay = hasPrivateRelayMarker(req);
  const requestScope = typeof tunnelAuthController?.classifyRequestScope === 'function'
    ? tunnelAuthController.classifyRequestScope(req)
    : 'local';
  const isExternal = privateRelay
    || requestScope === 'tunnel'
    || requestScope === 'unknown-public';

  if (isExternal) {
    const auth = typeof uiAuthController?.resolveUrlAuth === 'function'
      ? await uiAuthController.resolveUrlAuth(req)
      : null;
    if (!auth) return { ok: false, statusCode: 401, reason: 'URL authentication required' };
    if (privateRelay && auth.kind !== 'client') {
      return { ok: false, statusCode: 401, reason: 'Client URL authentication required' };
    }
    if (!await isRequestOriginAllowed(req)) {
      return { ok: false, statusCode: 403, reason: 'Invalid origin' };
    }
    return { ok: true, auth };
  }

  if (!uiAuthController?.enabled) return { ok: true, auth: null };

  const sessionToken = await uiAuthController.ensureSessionToken?.(req, null);
  if (!sessionToken) return { ok: false, statusCode: 401, reason: 'UI authentication required' };
  if (!await isRequestOriginAllowed(req)) {
    return { ok: false, statusCode: 403, reason: 'Invalid origin' };
  }
  const auth = typeof uiAuthController.resolveChannelAuth === 'function'
    ? await uiAuthController.resolveChannelAuth(req, null, { allowSessionCreation: false })
    : null;
  return { ok: true, auth };
};

export const createAuthChannelLifecycle = ({
  subscribeInvalidation,
  matchesSelector,
  now = () => Date.now(),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) => {
  const channels = new Map();
  let disposed = false;

  const remove = (key) => {
    const entry = channels.get(key);
    if (!entry) return;
    channels.delete(key);
    if (entry.expiryTimer) clearTimeoutImpl(entry.expiryTimer);
    entry.expiryTimer = null;
  };

  const close = (key) => {
    const entry = channels.get(key);
    if (!entry) return;
    remove(key);
    try {
      entry.close();
    } catch {
      // One channel must not block revocation of the remaining channels.
    }
  };

  const scheduleExpiry = (key) => {
    const entry = channels.get(key);
    if (!entry || entry.auth.expiresAt === null || entry.auth.expiresAt === undefined) return;
    const remaining = entry.auth.expiresAt - now();
    if (remaining <= 0) {
      close(key);
      return;
    }
    entry.expiryTimer = setTimeoutImpl(
      () => scheduleExpiry(key),
      Math.min(remaining, MAX_TIMEOUT_MS),
    );
    entry.expiryTimer?.unref?.();
  };

  const unsubscribe = typeof subscribeInvalidation === 'function'
    ? subscribeInvalidation((selector) => {
        if (typeof matchesSelector !== 'function') return;
        for (const [key, entry] of Array.from(channels)) {
          if (matchesSelector(entry.auth, selector)) close(key);
        }
      })
    : () => {};

  const track = (auth, closeChannel) => {
    if (disposed || !auth || typeof closeChannel !== 'function') return () => {};
    const key = Symbol('auth-channel');
    channels.set(key, { auth, close: closeChannel, expiryTimer: null });
    scheduleExpiry(key);
    return () => remove(key);
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    unsubscribe?.();
    for (const key of Array.from(channels.keys())) close(key);
  };

  return {
    track,
    dispose,
    get size() {
      return channels.size;
    },
  };
};
