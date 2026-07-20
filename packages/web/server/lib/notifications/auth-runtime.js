import crypto from 'node:crypto';

export const NOTIFICATION_AUTH_KIND_UI_SESSION = 'ui-session';
export const NOTIFICATION_AUTH_KIND_CLIENT = 'client';
export const NOTIFICATION_AUTH_KIND_TUNNEL_SESSION = 'tunnel-session';

const VALID_AUTH_KINDS = new Set([
  NOTIFICATION_AUTH_KIND_UI_SESSION,
  NOTIFICATION_AUTH_KIND_CLIENT,
  NOTIFICATION_AUTH_KIND_TUNNEL_SESSION,
]);

const digestIdentity = (value) => crypto.createHash('sha256').update(value).digest('base64url');

const normalizeExpiresAt = (value) => (
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
);

export const createUiSessionNotificationAuth = (sessionToken, expiresAt = null, generation = null) => {
  if (typeof sessionToken !== 'string' || !sessionToken) return null;
  return {
    kind: NOTIFICATION_AUTH_KIND_UI_SESSION,
    identity: `notify:ui:${digestIdentity(sessionToken)}`,
    expiresAt: normalizeExpiresAt(expiresAt),
    ...(typeof generation === 'string' && generation ? { generation } : {}),
  };
};

export const createClientNotificationAuth = (clientId, expiresAt = null) => {
  if (typeof clientId !== 'string' || !clientId.trim()) return null;
  const normalizedClientId = clientId.trim();
  return {
    kind: NOTIFICATION_AUTH_KIND_CLIENT,
    identity: `notify:client:${normalizedClientId}`,
    clientId: normalizedClientId,
    expiresAt: normalizeExpiresAt(expiresAt),
  };
};

export const createTunnelSessionNotificationAuth = (sessionId, expiresAt = null) => {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  return {
    kind: NOTIFICATION_AUTH_KIND_TUNNEL_SESSION,
    identity: `notify:tunnel:${digestIdentity(sessionId)}`,
    expiresAt: normalizeExpiresAt(expiresAt),
  };
};

export const normalizeNotificationAuth = (value) => {
  if (!value || typeof value !== 'object') return null;
  const kind = value.kind;
  const identity = value.identity;
  if (!VALID_AUTH_KINDS.has(kind) || typeof identity !== 'string' || !identity.startsWith('notify:')) {
    return null;
  }

  const normalized = {
    kind,
    identity,
    expiresAt: normalizeExpiresAt(value.expiresAt),
  };
  if (kind === NOTIFICATION_AUTH_KIND_CLIENT) {
    if (typeof value.clientId !== 'string' || !value.clientId.trim()) return null;
    normalized.clientId = value.clientId.trim();
  } else if (kind === NOTIFICATION_AUTH_KIND_UI_SESSION && typeof value.generation === 'string' && value.generation) {
    normalized.generation = value.generation;
  }
  return normalized;
};

const normalizeNotificationAuthSelector = (value) => {
  if (typeof value === 'string' && value.startsWith('notify:')) {
    return { identity: value };
  }
  if (!value || typeof value !== 'object') return null;
  if (typeof value.identity === 'string' && value.identity.startsWith('notify:')) {
    return { identity: value.identity };
  }
  if (VALID_AUTH_KINDS.has(value.kind)) {
    return { kind: value.kind };
  }
  return null;
};

export const notificationAuthMatchesSelector = (authValue, selectorValue) => {
  const auth = normalizeNotificationAuth(authValue);
  const selector = normalizeNotificationAuthSelector(selectorValue);
  if (!auth || !selector) return false;
  if (selector.identity) return auth.identity === selector.identity;
  return auth.kind === selector.kind;
};

let validator = null;
const invalidatedIdentities = new Set();
const invalidationListeners = new Set();
const MAX_INVALIDATED_IDENTITIES = 4_096;

export const configureNotificationAuthValidator = (nextValidator) => {
  validator = typeof nextValidator === 'function' ? nextValidator : null;
};

export const validateNotificationAuth = async (authValue) => {
  const auth = normalizeNotificationAuth(authValue);
  if (!auth) return 'inactive';
  if (auth.expiresAt !== null && auth.expiresAt <= Date.now()) return 'inactive';
  if (invalidatedIdentities.has(auth.identity)) return 'inactive';
  if (!validator) return 'unknown';

  try {
    const result = await validator(auth);
    if (result === true) return 'active';
    if (result === false) return 'inactive';
    return 'unknown';
  } catch {
    return 'unknown';
  }
};

export const subscribeNotificationAuthInvalidation = (listener) => {
  if (typeof listener !== 'function') return () => {};
  invalidationListeners.add(listener);
  return () => invalidationListeners.delete(listener);
};

export const invalidateNotificationAuth = (selectorValue) => {
  const selector = normalizeNotificationAuthSelector(selectorValue);
  if (!selector) return;
  if (selector.identity) {
    invalidatedIdentities.add(selector.identity);
    while (invalidatedIdentities.size > MAX_INVALIDATED_IDENTITIES) {
      invalidatedIdentities.delete(invalidatedIdentities.values().next().value);
    }
  }
  for (const listener of invalidationListeners) {
    try {
      listener(selector);
    } catch {
      // One cleanup consumer must not block the remaining auth revocation work.
    }
  }
};
