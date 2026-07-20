import {
  NOTIFICATION_AUTH_KIND_TUNNEL_SESSION,
  configureNotificationAuthValidator,
  createTunnelSessionNotificationAuth,
  createUiSessionNotificationAuth,
  notificationAuthMatchesSelector,
  subscribeNotificationAuthInvalidation,
  validateNotificationAuth,
} from './auth-runtime.js';

const parsePushSubscribeBody = (body) => {
  if (!body || typeof body !== 'object') return null;
  const endpoint = body.endpoint;
  const keys = body.keys;
  const p256dh = keys?.p256dh;
  const auth = keys?.auth;

  if (typeof endpoint !== 'string' || endpoint.trim().length === 0) return null;
  if (typeof p256dh !== 'string' || p256dh.trim().length === 0) return null;
  if (typeof auth !== 'string' || auth.trim().length === 0) return null;

  return {
    endpoint: endpoint.trim(),
    keys: { p256dh: p256dh.trim(), auth: auth.trim() },
  };
};

const parsePushUnsubscribeBody = (body) => {
  if (!body || typeof body !== 'object') return null;
  const endpoint = body.endpoint;
  if (typeof endpoint !== 'string' || endpoint.trim().length === 0) return null;
  return { endpoint: endpoint.trim() };
};

export const NOTIFICATION_SSE_HEARTBEAT_INTERVAL_MS = 20_000;

export const registerNotificationRoutes = (app, dependencies) => {
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
    isUiVisible,
    getUiNotificationClients,
    writeSseEvent,
    getSessionActivitySnapshot,
    getSessionStateSnapshot,
    getSessionAttentionSnapshot,
    getSessionState,
    getSessionAttentionState,
    markSessionViewed,
    markSessionUnviewed,
    markUserMessageSent,
    setPushInitialized,
    setAutoAcceptSession,
  } = dependencies;

  const notificationStreams = new Map();

  configureNotificationAuthValidator(async (auth) => {
    if (auth.kind === NOTIFICATION_AUTH_KIND_TUNNEL_SESSION) {
      return typeof tunnelAuthController?.validateNotificationAuth === 'function'
        ? tunnelAuthController.validateNotificationAuth(auth)
        : null;
    }
    return typeof uiAuthController?.validateNotificationAuth === 'function'
      ? uiAuthController.validateNotificationAuth(auth)
      : null;
  });

  subscribeNotificationAuthInvalidation((selector) => {
    for (const stream of notificationStreams.values()) {
      if (notificationAuthMatchesSelector(stream.auth, selector)) stream.revoke();
    }
    if (typeof removePushSubscription === 'function') {
      void Promise.resolve(removePushSubscription(selector)).catch(() => {});
    }
    if (typeof removeApnsToken === 'function') {
      void Promise.resolve(removeApnsToken(selector)).catch(() => {});
    }
  });

  const resolveNotificationAuth = async (req, res) => {
    const relayMarker = req?.headers?.['x-openchamber-relay-connection'];
    const isPrivateRelay = Array.isArray(relayMarker)
      ? relayMarker.some((entry) => typeof entry === 'string' && entry.length > 0)
      : typeof relayMarker === 'string' && relayMarker.length > 0;
    if (isPrivateRelay) {
      return typeof uiAuthController?.resolveNotificationAuth === 'function'
        ? uiAuthController.resolveNotificationAuth(req, res, {
            allowUrlToken: false,
            allowSessionCreation: false,
            clientOnly: true,
          })
        : null;
    }

    const requestScope = typeof tunnelAuthController?.classifyRequestScope === 'function'
      ? tunnelAuthController.classifyRequestScope(req)
      : 'local';
    if (
      (requestScope === 'tunnel' || requestScope === 'unknown-public')
      && typeof tunnelAuthController?.getTunnelSessionFromRequest === 'function'
    ) {
      const tunnelSession = tunnelAuthController.getTunnelSessionFromRequest(req);
      if (typeof tunnelSession?.sessionId === 'string' && tunnelSession.sessionId) {
        return createTunnelSessionNotificationAuth(tunnelSession.sessionId, tunnelSession.expiresAt);
      }
    }

    if (typeof uiAuthController?.resolveNotificationAuth === 'function') {
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
    if (typeof ensureGlobalWatcherStarted !== 'function') {
      return;
    }
    try {
      await ensureGlobalWatcherStarted();
    } catch (error) {
      console.warn('[OpenCodeWatcher] lazy start failed:', error?.message ?? error);
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

    const origin = typeof req.body?.origin === 'string' ? req.body.origin.trim() : '';
    if (origin.startsWith('http://') || origin.startsWith('https://')) {
      try {
        const settings = await readSettingsFromDiskMigrated();
        if (typeof settings?.publicOrigin !== 'string' || settings.publicOrigin.trim().length === 0) {
          await writeSettingsToDisk({
            ...settings,
            publicOrigin: origin,
          });
          setPushInitialized(false);
        }
      } catch {
      }
    }

    const platform = typeof req.body?.platform === 'string' ? req.body.platform : undefined;
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

  // Native iOS APNs device token registration (mirrors /api/push/subscribe). The token
  // is a hex APNs device token from @capacitor/push-notifications, scoped to the
  // same opaque auth identity as web-push subscriptions.
  app.post('/api/push/apns-token', async (req, res) => {
    const notificationAuth = await resolveNotificationAuth(req, res);
    if (!notificationAuth) {
      return res.status(401).json({ error: 'UI session missing' });
    }
    await ensureSessionWatcher();

    const deviceToken = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    if (!deviceToken) {
      return res.status(400).json({ error: 'Invalid body' });
    }

    const platform = req.body?.platform === 'android' ? 'android' : 'ios';
    if (typeof addOrUpdateApnsToken === 'function') {
      await addOrUpdateApnsToken(notificationAuth, deviceToken, req.headers['user-agent'], platform);
    }
    return res.json({ ok: true });
  });

  app.delete('/api/push/apns-token', async (req, res) => {
    const notificationAuth = await resolveNotificationAuth(req, res);
    if (!notificationAuth) {
      return res.status(401).json({ error: 'UI session missing' });
    }

    const deviceToken = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    if (!deviceToken) {
      return res.status(400).json({ error: 'Invalid body' });
    }

    if (typeof removeApnsToken === 'function') {
      await removeApnsToken(notificationAuth, deviceToken);
    }
    return res.json({ ok: true });
  });

  app.post('/api/push/visibility', async (req, res) => {
    const notificationAuth = await resolveNotificationAuth(req, res);
    if (!notificationAuth) {
      return res.status(401).json({ error: 'UI session missing' });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const platform = typeof body.platform === 'string' ? body.platform : undefined;
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
    const initialAuthStatus = await validateNotificationAuth(notificationAuth);
    if (initialAuthStatus !== 'active') {
      return res.status(401).json({ error: 'UI session unavailable' });
    }
    await ensureSessionWatcher();

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const clients = getUiNotificationClients();
    clients.add(res);

    let closed = false;
    let heartbeatTimer = null;
    let expiryTimer = null;
    let validatingHeartbeat = false;

    const removeListener = (target, event, listener) => {
      if (typeof target?.off === 'function') target.off(event, listener);
      else if (typeof target?.removeListener === 'function') target.removeListener(event, listener);
    };

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
      removeListener(req, 'close', cleanup);
      removeListener(res, 'close', cleanup);
      removeListener(res, 'error', cleanup);
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
      attentionSessions: getSessionAttentionSnapshot(),
      serverTime: Date.now(),
    });
  });

  app.get('/api/sessions/status', async (_req, res) => {
    await ensureSessionWatcher();
    const snapshot = getSessionStateSnapshot();
    res.json({
      sessions: snapshot,
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

  app.get('/api/sessions/attention', async (_req, res) => {
    await ensureSessionWatcher();
    const snapshot = getSessionAttentionSnapshot();
    res.json({
      sessions: snapshot,
      serverTime: Date.now(),
    });
  });

  app.get('/api/sessions/:id/attention', async (req, res) => {
    await ensureSessionWatcher();
    const sessionId = req.params.id;
    const state = getSessionAttentionState(sessionId);

    if (!state) {
      return res.status(404).json({
        error: 'Session not found or no attention state available',
        sessionId,
      });
    }

    return res.json({
      sessionId,
      ...state,
    });
  });

  app.post('/api/sessions/:id/view', (req, res) => {
    const sessionId = req.params.id;
    const clientId = req.headers['x-client-id'] || req.ip || 'anonymous';

    markSessionViewed(sessionId, clientId);
    // The user is engaging with the app, so the native push badge no longer
    // applies — reset it here too (not only on the visibility beacon), since
    // opening the app reliably marks the opened session viewed.
    if (typeof clearPendingPushBadge === 'function') clearPendingPushBadge();

    return res.json({
      success: true,
      sessionId,
      viewed: true,
    });
  });

  app.post('/api/sessions/:id/unview', (req, res) => {
    const sessionId = req.params.id;
    const clientId = req.headers['x-client-id'] || req.ip || 'anonymous';

    markSessionUnviewed(sessionId, clientId);

    return res.json({
      success: true,
      sessionId,
      viewed: false,
    });
  });

  app.post('/api/sessions/:id/message-sent', (req, res) => {
    const sessionId = req.params.id;

    markUserMessageSent(sessionId);
    // Sending a message means the user is active in the app; reset the native
    // push badge so it counts only notifications since this engagement.
    if (typeof clearPendingPushBadge === 'function') clearPendingPushBadge();

    return res.json({
      success: true,
      sessionId,
      messageSent: true,
    });
  });

  // Mirror client-side Permission Auto-Accept state to the server so it can
  // suppress permission notifications at the source (the 500ms debounce race
  // otherwise leaks notifications for auto-accepted permissions).
  app.post('/api/notifications/auto-accept', (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    const enabled = body.enabled === true;
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId required' });
    }
    if (typeof setAutoAcceptSession === 'function') {
      setAutoAcceptSession(sessionId, enabled);
    }
    return res.json({ success: true, sessionId, enabled });
  });
};
