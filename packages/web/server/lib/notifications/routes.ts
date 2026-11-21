import {
  NOTIFICATION_AUTH_KIND_TUNNEL_SESSION,
  type NotificationAuth,
  configureNotificationAuthValidator,
  createTunnelSessionNotificationAuth,
  createUiSessionNotificationAuth,
  notificationAuthMatchesSelector,
  subscribeNotificationAuthInvalidation,
  validateNotificationAuth,
} from './auth-runtime.js';

import { z } from 'zod';
import { hasErrorMessage, isJsonObject, isString } from './inputs.js';
import type { PushSettings, SseWriter } from './contracts.js';
import type { createPushRuntime } from './push-runtime.js';
import type { createSessionRuntime } from '../opencode/session-runtime.js';
import { pairedSessionKey } from './session-key.js';
import type { createApnsRuntime } from './apns-runtime.js';
import type { createUiAuth } from '../ui-auth/ui-auth.js';
import type { createTunnelAuth } from '../tunnels/tunnel-auth.js';
import type { Request, Response } from '../shared/http-contracts.js';
import { isCallable } from '../shared/object-guards.js';

type NotificationRequest = Request<unknown, { id: string }>;
type NotificationResponse = Response & { flush?: () => void };
type NotificationRouteHandler = (req: NotificationRequest, res: NotificationResponse) => void | Response | Promise<void | Response>;
type ApnsRuntime = ReturnType<typeof createApnsRuntime>;
type SessionRuntime = ReturnType<typeof createSessionRuntime>;
type PushRuntime = ReturnType<typeof createPushRuntime>;

interface NotificationRouteDependencies extends Pick<PushRuntime,
  'ensurePushInitialized' | 'getOrCreateVapidKeys' | 'addOrUpdatePushSubscription' | 'removePushSubscription' |
  'updateUiVisibility' | 'isUiVisible' | 'setPushInitialized'>, Pick<SessionRuntime,
  'getSessionActivitySnapshot' | 'getSessionStateSnapshot' | 'getSessionState'> {
  uiAuthController?: Partial<Pick<ReturnType<typeof createUiAuth>, 'ensureSessionToken' | 'resolveNotificationAuth' | 'validateNotificationAuth' | 'enabled'>>;
  tunnelAuthController?: Partial<Pick<ReturnType<typeof createTunnelAuth>, 'classifyRequestScope' | 'getTunnelSessionFromRequest' | 'validateNotificationAuth'>>;
  ensureGlobalWatcherStarted?: () => Promise<void>;
  getUiSessionTokenFromRequest: (req: NotificationRequest) => string | null;
  readSettingsFromDiskMigrated: () => Promise<PushSettings>;
  writeSettingsToDisk: (settings: PushSettings) => Promise<void>;
  addOrUpdateApnsToken?: ApnsRuntime['addOrUpdateApnsToken'];
  removeApnsToken?: ApnsRuntime['removeApnsToken'];
  clearPendingPushBadge?: () => void;
  clearSessionPushNotifications?: (sessionId: string, options?: { spaceId?: string | null }) => Promise<void>;
  getUiNotificationClients: () => Set<NotificationResponse>;
  writeSseEvent: (res: SseWriter, payload: { type: string; properties: Record<string, never> }) => void;
  getPendingBlockingRequestsSnapshot?: SessionRuntime['getPendingBlockingRequestsSnapshot'];
  getSessionContextSnapshot?: SessionRuntime['getSessionContextSnapshot'];
  setAutoAcceptSession?: (sessionId: string, enabled: boolean) => void;
  isLocalOnlyPushRequest: (req: NotificationRequest, uiToken: string) => Promise<boolean>;
}

const parsePushSubscribeBody = z.unknown().transform((body) => {
  if (!isJsonObject(body)) return null;
  const endpoint = body.endpoint;
  const keys = body.keys;
  const p256dh = isJsonObject(keys) ? keys.p256dh : undefined;
  const auth = isJsonObject(keys) ? keys.auth : undefined;

  if (!isString(endpoint) || endpoint.trim().length === 0) return null;
  if (!isString(p256dh) || p256dh.trim().length === 0) return null;
  if (!isString(auth) || auth.trim().length === 0) return null;

  return {
    endpoint: endpoint.trim(),
    keys: { p256dh: p256dh.trim(), auth: auth.trim() },
  };
}).parse;

const parsePushUnsubscribeBody = z.unknown().transform((body) => {
  if (!isJsonObject(body)) return null;
  const endpoint = body.endpoint;
  if (!isString(endpoint) || endpoint.trim().length === 0) return null;
  return { endpoint: endpoint.trim() };
}).parse;

export const NOTIFICATION_SSE_HEARTBEAT_INTERVAL_MS = 20_000;

export const registerNotificationRoutes = (app: {
  get: (route: string, handler: NotificationRouteHandler) => void;
  post: (route: string, handler: NotificationRouteHandler) => void;
  delete: (route: string, handler: NotificationRouteHandler) => void;
}, dependencies: NotificationRouteDependencies) => {
  const {
    uiAuthController,
    tunnelAuthController,
    ensurePushInitialized,
    ensureGlobalWatcherStarted,
    getOrCreateVapidKeys,
    getUiSessionTokenFromRequest,
    readSettingsFromDiskMigrated,
    writeSettingsToDisk,
    addOrUpdatePushSubscription,
    removePushSubscription,
    addOrUpdateApnsToken,
    removeApnsToken,
    updateUiVisibility,
    clearPendingPushBadge,
    clearSessionPushNotifications,
    isUiVisible,
    getUiNotificationClients,
    writeSseEvent,
    getSessionActivitySnapshot,
    getSessionStateSnapshot,
    getPendingBlockingRequestsSnapshot,
    getSessionContextSnapshot,
    getSessionState,
    setPushInitialized,
    setAutoAcceptSession,
    isLocalOnlyPushRequest,
  } = dependencies;

  const notificationStreams = new Map<NotificationResponse, { auth: NotificationAuth; revoke: () => void }>();

  configureNotificationAuthValidator(async (auth) => {
    if (auth.kind === NOTIFICATION_AUTH_KIND_TUNNEL_SESSION) {
      return isCallable(tunnelAuthController?.validateNotificationAuth)
        ? tunnelAuthController.validateNotificationAuth(auth)
        : null;
    }
    return isCallable(uiAuthController?.validateNotificationAuth)
      ? uiAuthController.validateNotificationAuth(auth)
      : null;
  });

  subscribeNotificationAuthInvalidation((selector, registrations) => {
    for (const stream of notificationStreams.values()) {
      if (notificationAuthMatchesSelector(stream.auth, selector)) stream.revoke();
    }
    if (registrations === 'paired-devices') return;
    if (isCallable(removePushSubscription)) {
      void Promise.resolve(removePushSubscription(selector)).catch(() => {});
    }
    if (isCallable(removeApnsToken)) {
      void Promise.resolve(removeApnsToken(selector)).catch(() => {});
    }
  });

  const resolveNotificationAuth = async (req: NotificationRequest, res: NotificationResponse) => {
    const relayMarker = req?.headers?.['x-openchamber-relay-connection'];
    const isPrivateRelay = Array.isArray(relayMarker)
      ? relayMarker.some((entry) => isString(entry) && entry.length > 0)
      : isString(relayMarker) && relayMarker.length > 0;
    if (isPrivateRelay) {
      return isCallable(uiAuthController?.resolveNotificationAuth)
        ? uiAuthController.resolveNotificationAuth(req, res, {
            allowUrlToken: false,
            allowSessionCreation: false,
            clientOnly: true,
          })
        : null;
    }

    const requestScope = isCallable(tunnelAuthController?.classifyRequestScope)
      ? tunnelAuthController.classifyRequestScope(req)
      : 'local';
    if (
      (requestScope === 'tunnel' || requestScope === 'unknown-public')
      && isCallable(tunnelAuthController?.getTunnelSessionFromRequest)
    ) {
      const tunnelSession = tunnelAuthController.getTunnelSessionFromRequest(req);
      if (isString(tunnelSession?.sessionId) && tunnelSession.sessionId) {
        return createTunnelSessionNotificationAuth(tunnelSession.sessionId, tunnelSession.expiresAt);
      }
    }

    if (isCallable(uiAuthController?.resolveNotificationAuth)) {
      return uiAuthController.resolveNotificationAuth(req, res, {
        allowUrlToken: true,
        allowSessionCreation: requestScope === 'local',
        clientOnly: requestScope !== 'local' && uiAuthController.enabled === false,
      });
    }

    if (requestScope !== 'local') return null;
    const uiSessionToken = uiAuthController?.ensureSessionToken
      ? await uiAuthController.ensureSessionToken(req, res)
      : getUiSessionTokenFromRequest(req);
    return createUiSessionNotificationAuth(uiSessionToken);
  };

  const ensureSessionWatcher = async () => {
    if (!ensureGlobalWatcherStarted) {
      return;
    }
    try {
      await ensureGlobalWatcherStarted();
    } catch (error) {
      console.warn('[OpenCodeWatcher] lazy start failed:', hasErrorMessage(error) ? error.message ?? error : error);
    }
  };

  const rememberPublicOrigin = async (origin: string) => {
    try {
      const settings = await readSettingsFromDiskMigrated();
      if (!isString(settings?.publicOrigin) || settings.publicOrigin.trim().length === 0) {
        await writeSettingsToDisk({ ...settings, publicOrigin: origin });
        setPushInitialized(false);
      }
    } catch {
      return;
    }
  };

  app.get('/api/push/vapid-public-key', async (_req, res) => {
    try {
      await ensurePushInitialized();
      const keys = await getOrCreateVapidKeys();
      res.json({ publicKey: keys.publicKey });
    } catch (error) {
      console.warn('[Push] Failed to load VAPID key:', error);
      res.status(500).json({ error: 'Failed to load push key' });
    }
  });

  app.post('/api/push/subscribe', async (req, res) => {
    const notificationAuth = await resolveNotificationAuth(req, res);
    if (!notificationAuth) {
      return res.status(401).json({ error: 'UI session missing' });
    }
    await ensurePushInitialized();
    await ensureSessionWatcher();

    const parsed = parsePushSubscribeBody(req.body);
    if (!parsed) {
      return res.status(400).json({ error: 'Invalid body' });
    }

    const { endpoint, keys } = parsed;

    const body = isJsonObject(req.body) ? req.body : {};
    const origin = isString(body.origin) ? body.origin.trim() : '';
    if (origin.startsWith('http://') || origin.startsWith('https://')) {
      await rememberPublicOrigin(origin);
    }

    const platform = isString(body.platform) ? body.platform : undefined;
    await addOrUpdatePushSubscription(
      notificationAuth,
      {
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
      },
      req.headers['user-agent'],
      platform
    );

    return res.json({ ok: true });
  });

  app.delete('/api/push/subscribe', async (req, res) => {
    const notificationAuth = await resolveNotificationAuth(req, res);
    if (!notificationAuth) {
      return res.status(401).json({ error: 'UI session missing' });
    }

    const parsed = parsePushUnsubscribeBody(req.body);
    if (!parsed) {
      return res.status(400).json({ error: 'Invalid body' });
    }

    await removePushSubscription(notificationAuth, parsed.endpoint);
    return res.json({ ok: true });
  });

  app.post('/api/push/apns-token', async (req, res) => {
    const notificationAuth = await resolveNotificationAuth(req, res);
    if (!notificationAuth) {
      return res.status(401).json({ error: 'UI session missing' });
    }
    await ensureSessionWatcher();

    const body = isJsonObject(req.body) ? req.body : {};
    const deviceToken = isString(body.token) ? body.token.trim() : '';
    if (!deviceToken) {
      return res.status(400).json({ error: 'Invalid body' });
    }

    if (await isLocalOnlyPushRequest(req, pairedSessionKey(notificationAuth) ?? '')) {
      return res.json({ ok: true, localOnly: true });
    }

    const platform = body.platform === 'android' ? 'android' : 'ios';
    const environment = body.environment === 'sandbox' ? 'sandbox' : 'production';
    if (addOrUpdateApnsToken) {
      await addOrUpdateApnsToken(notificationAuth, deviceToken, req.headers['user-agent'], platform, environment, body.pushKey);
    }
    return res.json({ ok: true });
  });

  app.get('/api/push/delivery', async (req, res) => {
    const notificationAuth = await resolveNotificationAuth(req, res);
    if (!notificationAuth) {
      return res.status(401).json({ error: 'UI session missing' });
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ localOnly: await isLocalOnlyPushRequest(req, pairedSessionKey(notificationAuth) ?? '') });
  });

  app.delete('/api/push/apns-token', async (req, res) => {
    const notificationAuth = await resolveNotificationAuth(req, res);
    if (!notificationAuth) {
      return res.status(401).json({ error: 'UI session missing' });
    }

    const body = isJsonObject(req.body) ? req.body : {};
    const deviceToken = isString(body.token) ? body.token.trim() : '';
    if (!deviceToken) {
      return res.status(400).json({ error: 'Invalid body' });
    }

    if (removeApnsToken) {
      await removeApnsToken(notificationAuth, deviceToken);
    }
    return res.json({ ok: true });
  });

  app.post('/api/push/visibility', async (req, res) => {
    const notificationAuth = await resolveNotificationAuth(req, res);
    if (!notificationAuth) {
      return res.status(401).json({ error: 'UI session missing' });
    }

    const body = isJsonObject(req.body) ? req.body : {};
    const platform = isString(body.platform) ? body.platform : undefined;
    updateUiVisibility(notificationAuth, body.visible === true, platform);
    return res.json({ ok: true });
  });

  app.get('/api/push/visibility', async (req, res) => {
    const notificationAuth = await resolveNotificationAuth(req, res);
    if (!notificationAuth) {
      return res.status(401).json({ error: 'UI session missing' });
    }

    return res.json({
      ok: true,
      visible: isUiVisible(notificationAuth),
    });
  });

  app.get('/api/notifications/stream', async (req, res) => {
    const notificationAuth = await resolveNotificationAuth(req, res);
    if (!notificationAuth) {
      return res.status(401).json({ error: 'UI session missing' });
    }
    if (req.destroyed || res.destroyed || res.writableEnded) return;
    const clients = getUiNotificationClients();
    let closed = false;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let expiryTimer: ReturnType<typeof setTimeout> | null = null;
    let validatingHeartbeat = false;

    const cleanup = () => {
      if (closed) {
        return;
      }
      closed = true;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (expiryTimer) {
        clearTimeout(expiryTimer);
        expiryTimer = null;
      }
      clients.delete(res);
      notificationStreams.delete(res);
      req.off('close', cleanup);
      res.off('close', cleanup);
      res.off('error', cleanup);
    };

    const revoke = () => {
      if (closed) return;
      cleanup();
      if (!res.writableEnded && !res.destroyed) {
        try {
          res.end?.();
        } catch {
          res.destroy?.();
        }
      }
    };

    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
    notificationStreams.set(res, { auth: notificationAuth, revoke });

    const authorized = async () => {
      const status = await validateNotificationAuth(notificationAuth);
      if (closed || req.destroyed || res.writableEnded || res.destroyed) {
        cleanup();
        return false;
      }
      if (status === 'active') return true;
      cleanup();
      res.status(401).json({ error: 'UI session unavailable' });
      return false;
    };
    if (ensureGlobalWatcherStarted) {
      if (!await authorized()) return;
      await ensureSessionWatcher();
    }
    if (!await authorized() || closed || req.destroyed || res.writableEnded || res.destroyed) return;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    clients.add(res);

    const flushSse = () => {
      res.flush?.();
    };

    const scheduleExpiry = () => {
      if (notificationAuth.expiresAt === null || closed) return;
      const remaining = notificationAuth.expiresAt - Date.now();
      if (remaining <= 0) {
        revoke();
        return;
      }
      expiryTimer = setTimeout(scheduleExpiry, Math.min(remaining, 2_147_483_647));
      expiryTimer.unref?.();
    };
    scheduleExpiry();

    heartbeatTimer = setInterval(async () => {
      if (closed || res.writableEnded || res.destroyed) {
        cleanup();
        return;
      }
      if (validatingHeartbeat) return;
      validatingHeartbeat = true;
      try {
        const authStatus = await validateNotificationAuth(notificationAuth);
        if (authStatus !== 'active') {
          revoke();
          return;
        }
        if (closed || res.writableEnded || res.destroyed) return;
        res.write(':heartbeat\n\n');
        flushSse();
      } catch {
        revoke();
      } finally {
        validatingHeartbeat = false;
      }
    }, NOTIFICATION_SSE_HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref?.();

    try {
      writeSseEvent(res, {
        type: 'openchamber:notification-stream-ready',
        properties: {},
      });
      flushSse();
    } catch {
      cleanup();
    }
  });

  app.get('/api/session-activity', (_req, res) => {
    void ensureSessionWatcher();
    res.json(getSessionActivitySnapshot());
  });

  app.get('/api/sessions/snapshot', async (_req, res) => {
    await ensureSessionWatcher();
    res.json({
      statusSessions: getSessionStateSnapshot(),
      serverTime: Date.now(),
    });
  });

  app.get('/api/sessions/status', async (_req, res) => {
    await ensureSessionWatcher();
    const snapshot = getSessionStateSnapshot();
    res.json({
      sessions: snapshot,
      pending: getPendingBlockingRequestsSnapshot ? getPendingBlockingRequestsSnapshot() : {},
      context: getSessionContextSnapshot ? getSessionContextSnapshot() : {},
      serverTime: Date.now(),
    });
  });

  app.get('/api/sessions/:id/status', async (req, res) => {
    await ensureSessionWatcher();
    const sessionId = req.params.id;
    const state = getSessionState(sessionId);

    if (!state) {
      return res.status(404).json({
        error: 'Session not found or no state available',
        sessionId,
      });
    }

    return res.json({
      sessionId,
      ...state,
    });
  });

  const clearReadSessionNotifications = (req: NotificationRequest) => {
    const space = req.query.spaceId;
    if (space !== undefined && (!isString(space) || !/^[0-9a-f]{12}$/.test(space))) return;
    void clearSessionPushNotifications?.(req.params.id, { spaceId: space ?? null });
  };

  app.post('/api/sessions/:id/view', (req, res) => {
    const sessionId = req.params.id;
    if (clearPendingPushBadge) clearPendingPushBadge();
    clearReadSessionNotifications(req);

    return res.json({
      success: true,
      sessionId,
      viewed: true,
    });
  });

  app.post('/api/sessions/:id/message-sent', (req, res) => {
    const sessionId = req.params.id;
    if (clearPendingPushBadge) clearPendingPushBadge();
    clearReadSessionNotifications(req);

    return res.json({
      success: true,
      sessionId,
      messageSent: true,
    });
  });

  app.post('/api/notifications/auto-accept', (req, res) => {
    const body = isJsonObject(req.body) ? req.body : {};
    const sessionId = isString(body.sessionId) ? body.sessionId.trim() : '';
    const enabled = body.enabled === true;
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId required' });
    }
    if (setAutoAcceptSession) {
      setAutoAcceptSession(sessionId, enabled);
    }
    return res.json({ success: true, sessionId, enabled });
  });
};
