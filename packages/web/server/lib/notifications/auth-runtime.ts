import crypto from 'node:crypto';
import { z } from 'zod';
import { isNumber, isString, isCallable } from '../shared/object-guards.js';

export const NOTIFICATION_AUTH_KIND_UI_SESSION = 'ui-session' as const;
export const NOTIFICATION_AUTH_KIND_CLIENT = 'client' as const;
export const NOTIFICATION_AUTH_KIND_TUNNEL_SESSION = 'tunnel-session' as const;

export type NotificationAuthKind =
  | typeof NOTIFICATION_AUTH_KIND_UI_SESSION
  | typeof NOTIFICATION_AUTH_KIND_CLIENT
  | typeof NOTIFICATION_AUTH_KIND_TUNNEL_SESSION;

export interface UiSessionNotificationAuth {
  kind: typeof NOTIFICATION_AUTH_KIND_UI_SESSION;
  identity: string;
  expiresAt: number | null;
  generation?: string;
}

export interface ClientNotificationAuth {
  kind: typeof NOTIFICATION_AUTH_KIND_CLIENT;
  identity: string;
  clientId: string;
  expiresAt: number | null;
}

export interface TunnelSessionNotificationAuth {
  kind: typeof NOTIFICATION_AUTH_KIND_TUNNEL_SESSION;
  identity: string;
  expiresAt: number | null;
}

export type NotificationAuth =
  | UiSessionNotificationAuth
  | ClientNotificationAuth
  | TunnelSessionNotificationAuth;

export type NotificationAuthSelector =
  | { identity: string; kind?: undefined }
  | { kind: NotificationAuthKind; identity?: undefined };

export type NotificationRegistrationFilter = NotificationAuth | NotificationAuthSelector | string | null;

export type NotificationAuthStatus = 'active' | 'inactive' | 'unknown';
export type NotificationAuthValidator = (auth: NotificationAuth) => boolean | null | Promise<boolean | null>;
type RegistrationCleanup = 'identity' | 'paired-devices';
export type NotificationAuthInvalidationListener = (selector: NotificationAuthSelector, registrations: RegistrationCleanup) => void;

const VALID_AUTH_KINDS: ReadonlySet<string> = new Set([
  NOTIFICATION_AUTH_KIND_UI_SESSION,
  NOTIFICATION_AUTH_KIND_CLIENT,
  NOTIFICATION_AUTH_KIND_TUNNEL_SESSION,
]);

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object');

const isNotificationAuthKind = (value: unknown): value is NotificationAuthKind =>
  typeof value === 'string' && VALID_AUTH_KINDS.has(value);

const digestIdentity = (value: string) => crypto.createHash('sha256').update(value).digest('base64url');

const normalizeExpiresAt = (value: number | null | undefined): number | null => (
  isNumber(value) && Number.isFinite(value) && value > 0 ? value : null
);

export const createUiSessionNotificationAuth = (
  sessionToken: string | null | undefined,
  expiresAt: number | null = null,
  generation: string | null = null,
): UiSessionNotificationAuth | null => {
  if (!isString(sessionToken) || !sessionToken) return null;
  const auth: UiSessionNotificationAuth = {
    kind: NOTIFICATION_AUTH_KIND_UI_SESSION,
    identity: `notify:ui:${digestIdentity(sessionToken)}`,
    expiresAt: normalizeExpiresAt(expiresAt),
  };
  if (isString(generation) && generation) auth.generation = generation;
  return auth;
};

export const createClientNotificationAuth = (
  clientId: string | null | undefined,
  expiresAt: number | null = null,
): ClientNotificationAuth | null => {
  if (!isString(clientId) || !clientId.trim()) return null;
  const normalizedClientId = clientId.trim();
  return {
    kind: NOTIFICATION_AUTH_KIND_CLIENT,
    identity: `notify:client:${normalizedClientId}`,
    clientId: normalizedClientId,
    expiresAt: normalizeExpiresAt(expiresAt),
  };
};

export const createTunnelSessionNotificationAuth = (
  sessionId: string | null | undefined,
  expiresAt: number | null = null,
): TunnelSessionNotificationAuth | null => {
  if (!isString(sessionId) || !sessionId) return null;
  return {
    kind: NOTIFICATION_AUTH_KIND_TUNNEL_SESSION,
    identity: `notify:tunnel:${digestIdentity(sessionId)}`,
    expiresAt: normalizeExpiresAt(expiresAt),
  };
};

export const normalizeNotificationAuth = z.unknown().transform((value): NotificationAuth | null => {
  if (!isObjectRecord(value)) return null;
  const { kind, identity } = value;
  if (!isNotificationAuthKind(kind) || !isString(identity) || !identity.startsWith('notify:')) {
    return null;
  }

  const expiresAt = isNumber(value.expiresAt) ? normalizeExpiresAt(value.expiresAt) : null;
  if (kind === NOTIFICATION_AUTH_KIND_CLIENT) {
    if (!isString(value.clientId) || !value.clientId.trim()) return null;
    return {
      kind,
      identity,
      clientId: value.clientId.trim(),
      expiresAt,
    };
  }
  if (kind === NOTIFICATION_AUTH_KIND_UI_SESSION) {
    const auth: UiSessionNotificationAuth = { kind, identity, expiresAt };
    if (isString(value.generation) && value.generation) auth.generation = value.generation;
    return auth;
  }
  return {
    kind,
    identity,
    expiresAt,
  };
}).parse;

export const parseNotificationRegistrationAuth = z.unknown().transform((value) => (
  normalizeNotificationAuth(value) ?? (isString(value) ? createUiSessionNotificationAuth(value) : null)
)).parse;

const normalizeNotificationAuthSelector = z.unknown().transform((value): NotificationAuthSelector | null => {
  if (isString(value) && value.startsWith('notify:')) {
    return { identity: value };
  }
  if (!isObjectRecord(value)) return null;
  if (isString(value.identity) && value.identity.startsWith('notify:')) {
    return { identity: value.identity };
  }
  if (isNotificationAuthKind(value.kind)) {
    return { kind: value.kind };
  }
  return null;
}).parse;

export const notificationAuthMatchesSelector = (
  authValue: NotificationAuth | null | undefined,
  selectorValue: NotificationRegistrationFilter,
): boolean => {
  const auth = normalizeNotificationAuth(authValue);
  const selector = normalizeNotificationAuthSelector(selectorValue);
  if (!auth || !selector) return false;
  if (selector.identity !== undefined) return auth.identity === selector.identity;
  return auth.kind === selector.kind;
};

let validator: NotificationAuthValidator | null = null;
const invalidatedIdentities = new Set<string>();
const invalidationListeners = new Set<NotificationAuthInvalidationListener>();
const MAX_INVALIDATED_IDENTITIES = 4_096;

export const configureNotificationAuthValidator = (
  nextValidator: NotificationAuthValidator | null | undefined,
): void => {
  validator = isCallable(nextValidator) ? nextValidator : null;
};

export const validateNotificationAuth = async (authValue: NotificationAuth | null | undefined): Promise<NotificationAuthStatus> => {
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

export const subscribeNotificationAuthInvalidation = (
  listener: NotificationAuthInvalidationListener | null | undefined,
): (() => void) => {
  if (!isCallable(listener)) return () => {};
  invalidationListeners.add(listener);
  return () => {
    invalidationListeners.delete(listener);
  };
};

export const invalidateNotificationAuth = (
  selectorValue: NotificationRegistrationFilter,
  registrations: RegistrationCleanup = 'identity',
): void => {
  const selector = normalizeNotificationAuthSelector(selectorValue);
  if (!selector) return;
  if (selector.identity !== undefined) {
    invalidatedIdentities.add(selector.identity);
    while (invalidatedIdentities.size > MAX_INVALIDATED_IDENTITIES) {
      const oldest = invalidatedIdentities.values().next().value;
      if (oldest === undefined) break;
      invalidatedIdentities.delete(oldest);
    }
  }
  for (const listener of invalidationListeners) {
    try {
      listener(selector, registrations);
    } catch {
      continue;
    }
  }
};
