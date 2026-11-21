import type { IncomingMessage } from 'node:http';
import { isOpaqueOriginRequest, isPasswordlessSocketOriginAllowed } from '../security/request-security.js';
import type { RequestOriginChecker, SecurityRequest } from '../security/request-security.js';
import type {
  NotificationAuth,
  NotificationAuthInvalidationListener,
  NotificationAuthSelector,
} from '../notifications/auth-runtime.js';
import type { createUiAuth } from './ui-auth.js';
import { isString, isCallable } from '../shared/object-guards.js';

const MAX_TIMEOUT_MS = 2_147_483_647;

export type ChannelAuthRequest = Pick<IncomingMessage, 'headers' | 'method' | 'url'> & SecurityRequest;

export type ChannelUiAuthController = Partial<Pick<
  ReturnType<typeof createUiAuth>,
  'enabled' | 'ensureSessionToken' | 'resolveUrlAuth' | 'resolveChannelAuth'
>> | null | undefined;

export interface ChannelTunnelAuthController {
  classifyRequestScope?: (req: ChannelAuthRequest) => string;
}

export interface AuthorizeWebSocketUpgradeInput {
  req: ChannelAuthRequest;
  uiAuthController?: ChannelUiAuthController;
  tunnelAuthController?: ChannelTunnelAuthController | null | undefined;
  isRequestOriginAllowed: RequestOriginChecker;
}

export type WebSocketUpgradeAuthResult =
  | { ok: true; auth: NotificationAuth | null }
  | { ok: false; statusCode: number; reason: string };

export interface AuthChannelLifecycleOptions {
  subscribeInvalidation?: ((listener: NotificationAuthInvalidationListener) => (() => void) | void) | undefined;
  matchesSelector?: ((auth: NotificationAuth, selector: NotificationAuthSelector) => boolean) | undefined;
  now?: () => number;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}

interface TrackedChannelEntry {
  auth: NotificationAuth;
  close: () => void;
  expiryTimer: ReturnType<typeof setTimeout> | null;
}

const hasPrivateRelayMarker = (req: ChannelAuthRequest | null | undefined): boolean => {
  const value = req?.headers?.['x-openchamber-relay-connection'];
  if (Array.isArray(value)) return value.some((entry) => isString(entry) && entry.length > 0);
  return isString(value) && value.length > 0;
};

export const authorizeWebSocketUpgrade = async ({
  req,
  uiAuthController,
  tunnelAuthController,
  isRequestOriginAllowed,
}: AuthorizeWebSocketUpgradeInput): Promise<WebSocketUpgradeAuthResult> => {
  const privateRelay = hasPrivateRelayMarker(req);
  const requestScope = isCallable(tunnelAuthController?.classifyRequestScope)
    ? tunnelAuthController.classifyRequestScope(req)
    : 'local';
  const isExternal = privateRelay
    || requestScope === 'tunnel'
    || requestScope === 'unknown-public';

  if (isExternal) {
    const auth = isCallable(uiAuthController?.resolveUrlAuth)
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

  if (isOpaqueOriginRequest(req)) return { ok: false, statusCode: 403, reason: 'Invalid origin' };

  if (!uiAuthController?.enabled) {
    const allowed = await isPasswordlessSocketOriginAllowed(req, isRequestOriginAllowed);
    return allowed ? { ok: true, auth: null } : { ok: false, statusCode: 403, reason: 'Invalid origin' };
  }

  const sessionToken = await uiAuthController.ensureSessionToken?.(req, null);
  if (!sessionToken) return { ok: false, statusCode: 401, reason: 'UI authentication required' };
  if (!await isRequestOriginAllowed(req)) {
    return { ok: false, statusCode: 403, reason: 'Invalid origin' };
  }
  const auth = isCallable(uiAuthController.resolveChannelAuth)
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
}: AuthChannelLifecycleOptions = {}) => {
  const channels = new Map<symbol, TrackedChannelEntry>();
  let disposed = false;

  const remove = (key: symbol) => {
    const entry = channels.get(key);
    if (!entry) return;
    channels.delete(key);
    if (entry.expiryTimer) clearTimeoutImpl(entry.expiryTimer);
    entry.expiryTimer = null;
  };

  const close = (key: symbol) => {
    const entry = channels.get(key);
    if (!entry) return;
    remove(key);
    try {
      entry.close();
    } catch {
      void 0;
    }
  };

  const scheduleExpiry = (key: symbol) => {
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

  const unsubscribe = isCallable(subscribeInvalidation)
    ? subscribeInvalidation((selector) => {
        if (!isCallable(matchesSelector)) return;
        for (const [key, entry] of Array.from(channels)) {
          if (matchesSelector(entry.auth, selector)) close(key);
        }
      })
    : () => {};

  const track = (auth: NotificationAuth | null | undefined, closeChannel: () => void): (() => void) => {
    if (disposed || !auth || !isCallable(closeChannel)) return () => {};
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
