import { WebSocket, WebSocketServer } from 'ws';
import { GUEST_SERVICE_SOCKET_FRAME_MAX, GUEST_SERVICE_SOCKET_BUFFER_MAX, isGuestApproved, requestedGuestCapabilities, isServiceSocketRequest } from '@openchamber/sdk';
import { authorizeWebSocketUpgrade } from '../ui-auth/channel-auth.js';
import { isOpaqueOriginRequest } from '../security/request-security.js';
import { enterpriseBlockedCapabilities } from './enterprise.js';
import { ensureGuestServiceReady, holdGuestService, subscribeGuestServiceStop } from './service.js';

const SERVICE_WS_PATH = /^\/api\/guests\/([a-z][a-z0-9-]*)\/service\/ws$/;

export const createGuestServiceSocketRuntime = ({ server, uiAuthController, tunnelAuthController, isRequestOriginAllowed, rejectWebSocketUpgrade, trackAuthChannel = () => () => {}, persistPath, findGuest, readyService = ensureGuestServiceReady, holdService = holdGuestService }) => {
  const connections = new Set();
  const protocols = new WeakMap();
  let stopped = false;
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: GUEST_SERVICE_SOCKET_FRAME_MAX, perMessageDeflate: false,
    handleProtocols: (_offered, req) => protocols.get(req) || false });

  const end = (connection, code = 1001, reason = 'Service socket closed') => {
    const wireCode = code === 1005 ? 1000 : ((code >= 1000 && code <= 1014 && ![1004, 1006].includes(code)) || (code >= 3000 && code <= 4999)) ? code : 1011;
    if (connection.ended) return;
    connection.ended = true;
    connections.delete(connection);
    connection.untrack?.();
    connection.release?.();
    for (const ws of [connection.viewer, connection.upstream]) {
      if (!ws) continue;
      try {
        if (ws.readyState === 0) ws.terminate();
        else if (ws.readyState === 1) ws.close(wireCode, reason);
      } catch { ws.terminate(); }
      // A peer that never completes close must not keep a host shutdown alive.
      const timer = setTimeout(() => ws.terminate(), 1000);
      timer.unref?.();
      ws.once('close', () => clearTimeout(timer));
    }
    if (!connection.rejected && !connection.viewer && !connection.socket.destroyed) rejectWebSocketUpgrade(connection.socket, 503, 'Service is unavailable');
  };

  const forward = (connection, source, target) => {
    source.on('message', (data, binary) => {
      if (connection.ended || target.readyState !== 1) return;
      const size = data.byteLength ?? data.length;
      if (size > GUEST_SERVICE_SOCKET_FRAME_MAX || target.bufferedAmount + size > GUEST_SERVICE_SOCKET_BUFFER_MAX) {
        end(connection, 1009, 'Service socket buffer exceeded'); return;
      }
      // Node supports read backpressure. Bun's ws shim has bounded buffers but
      // cannot pause; its overflow above ends this channel explicitly.
      if (!process.versions.bun) source.pause();
      target.send(data, { binary }, (error) => {
        if (error) end(connection, 1011, 'Service socket send failed');
        else if (!connection.ended && !process.versions.bun) source.resume();
      });
    });
    source.on('error', () => end(connection, 1011, 'Service socket failed'));
    source.on('close', (code, reason) => end(connection, code, Buffer.from(reason ?? '').toString('utf8')));
  };

  const upgrade = (req, socket, head) => {
    let url;
    try { url = new URL(req.url || '/', 'http://localhost'); } catch { return; }
    const match = SERVICE_WS_PATH.exec(url.pathname);
    if (!match) return;
    const guestId = match[1];
    const connection = { guestId, socket, viewer: null, upstream: null, release: null, untrack: null, ended: false };
    connections.add(connection);
    socket.once('close', () => { if (!connection.viewer) end(connection); });
    const refuse = (status, reason) => {
      connection.rejected = true;
      if (!socket.destroyed) rejectWebSocketUpgrade(socket, status, reason);
      end(connection);
    };
    void (async () => {
      try {
        if (stopped) { refuse(503, 'Host is shutting down'); return; }
        if (isOpaqueOriginRequest(req)) { refuse(403, 'Invalid origin'); return; }
        const auth = await authorizeWebSocketUpgrade({ req, uiAuthController, tunnelAuthController, isRequestOriginAllowed });
        if (connection.ended) return;
        if (!auth.ok) { refuse(auth.statusCode, auth.reason); return; }
        connection.untrack = trackAuthChannel(auth.auth, () => end(connection, 1008, 'Authentication expired'));
        let query;
        try { query = url.searchParams.has('query') ? JSON.parse(url.searchParams.get('query')) : undefined; } catch { refuse(400, 'Invalid service query'); return; }
        const offered = req.headers['sec-websocket-protocol'];
        const request = { path: url.searchParams.get('path') ?? '', query,
          protocols: typeof offered === 'string' ? offered.split(',').map((value) => value.trim()) : undefined };
        if (query !== undefined && (!query || Array.isArray(query) || typeof query !== 'object')) { refuse(400, 'Invalid service query'); return; }
        if (!isServiceSocketRequest(request)) { refuse(400, 'Invalid service path'); return; }
        const guest = await findGuest(guestId);
        if (connection.ended) return;
        if (guest?.enterpriseBlocked || (guest && enterpriseBlockedCapabilities(guest, { source: guest.source, gitUrl: guest.gitOrigin?.url }).includes('service'))) {
          refuse(403, 'enterprise_mode'); return;
        }
        if (!guest || guest.enabled === false || !guest.service || !guest.capabilityGrants?.includes('service')
          || !isGuestApproved({ requested: requestedGuestCapabilities(guest), granted: guest.capabilityGrants })) {
          refuse(403, 'Extension service is unavailable'); return;
        }
        connection.release = holdService(guestId);
        const lease = await readyService({ guestId, guestName: guest.name, packageRoot: guest.packageRoot, service: guest.service, granted: guest.capabilityGrants, persistPath });
        if (connection.ended) return;
        if (stopped || !lease.isCurrent()) { end(connection); return; }
        const target = new URL(request.path, `ws://127.0.0.1:${lease.runtime.port}`);
        if (target.hostname !== '127.0.0.1' || target.port !== String(lease.runtime.port)) { refuse(400, 'Invalid service path'); return; }
        for (const [key, value] of Object.entries(query ?? {})) target.searchParams.set(key, value);
        const upstream = new WebSocket(target, request.protocols, { headers: { Authorization: `Bearer ${lease.runtime.token}` },
          maxPayload: GUEST_SERVICE_SOCKET_FRAME_MAX, perMessageDeflate: false, followRedirects: false, handshakeTimeout: 15_000 });
        connection.upstream = upstream;
        upstream.on('error', () => end(connection, 1011, 'Service connection failed'));
        upstream.on('close', (code, reason) => end(connection, code, Buffer.from(reason ?? '').toString('utf8')));
        upstream.once('open', () => {
          if (connection.ended) return;
          if (stopped || !lease.isCurrent()) { end(connection); return; }
          protocols.set(req, upstream.protocol);
          wsServer.handleUpgrade(req, socket, head, (viewer) => {
            connection.viewer = viewer;
            forward(connection, viewer, upstream);
            forward(connection, upstream, viewer);
          });
        });
      } catch { refuse(502, 'Service connection failed'); }
    })();
  };
  const unsubscribe = subscribeGuestServiceStop((guestId) => {
    for (const connection of [...connections]) if (connection.guestId === guestId) end(connection, 1008, 'Extension is unavailable');
  });
  server.on('upgrade', upgrade);
  return {
    endForGuest(guestId) { for (const connection of [...connections]) if (connection.guestId === guestId) end(connection, 1008, 'Extension is unavailable'); },
    stop() {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      server.off('upgrade', upgrade);
      for (const connection of [...connections]) end(connection, 1001, 'Host is shutting down');
      wsServer.close();
    },
  };
};
