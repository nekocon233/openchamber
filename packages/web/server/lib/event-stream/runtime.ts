import { WebSocketServer } from 'ws';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebSocket } from '../shared/websocket-contracts.js';
import type { RequestOriginChecker, createRequestSecurityRuntime } from '../security/request-security.js';
import type { NotificationAuth } from '../notifications/auth-runtime.js';
import type { BridgeOptions, EventRouting, StreamSocket, UpstreamConnection } from './contracts.js';
import type { GlobalMessageStreamHub } from './global-hub.js';
import type { ChannelTunnelAuthController, ChannelUiAuthController } from '../ui-auth/channel-auth.js';

import { parseRequestPathname } from '../terminal/terminal-ws-protocol.js';
import { authorizeWebSocketUpgrade } from '../ui-auth/channel-auth.js';
import {
  MESSAGE_STREAM_DIRECTORY_WS_PATH,
  MESSAGE_STREAM_GLOBAL_WS_PATH,
  MESSAGE_STREAM_WS_HEARTBEAT_INTERVAL_MS,
  serializeMessageStreamWsEvent,
  sendSerializedMessageStreamWsFrame,
} from './protocol.js';
import { createGlobalMessageStreamHub } from './global-hub.js';
import { createGlobalMessageStreamWsBridge } from './global-ws-bridge.js';
import { acceptDirectoryMessageStreamWsConnection } from './directory-ws-bridge.js';
import {
  DEFAULT_UPSTREAM_RECONNECT_DELAY_MS,
  DEFAULT_UPSTREAM_STALL_TIMEOUT_MS,
} from './upstream-reader.js';

type AuthenticatedUpgradeRequest = IncomingMessage & {
  openchamberAuthIdentity?: NotificationAuth | null;
};

export interface GlobalUiEventBroadcasterOptions<SseClient> {
  sseClients: Set<SseClient>;
  wsClients: Set<StreamSocket>;
  writeSseEvent: <Payload>(res: SseClient, payload: Payload, serializedPayload: string | undefined) => void;
}

export interface MessageStreamWsRuntimeOptions extends UpstreamConnection, Omit<BridgeOptions, 'heartbeatIntervalMs'> {
  server: Pick<Server, 'on' | 'off'>;
  uiAuthController?: ChannelUiAuthController;
  tunnelAuthController?: ChannelTunnelAuthController | null | undefined;
  isRequestOriginAllowed: RequestOriginChecker;
  rejectWebSocketUpgrade: ReturnType<typeof createRequestSecurityRuntime>['rejectWebSocketUpgrade'];
  trackAuthChannel?: ((auth: NotificationAuth | null | undefined, close: () => void) => (() => void) | void) | null | undefined;
  heartbeatIntervalMs?: number;
  globalEventHub?: GlobalMessageStreamHub | null;
}

const isRequestUrl = (value: unknown): value is string => typeof value === 'string';

export function createGlobalUiEventBroadcaster<SseClient>({
  sseClients,
  wsClients,
  writeSseEvent,
}: GlobalUiEventBroadcasterOptions<SseClient>) {
  return <Payload>(payload: Payload, options: EventRouting = {}) => {
    const hasSseClients = sseClients.size > 0;
    const hasWsClients = wsClients.size > 0;
    if (!hasSseClients && !hasWsClients) {
      return;
    }

    if (hasSseClients) {
      const serializedPayload = JSON.stringify(payload);
      for (const res of sseClients) {
        try {
          writeSseEvent(res, payload, serializedPayload);
        } catch {
          void 0;
        }
      }
    }

    if (hasWsClients) {
      const serializedFrame = serializeMessageStreamWsEvent(payload, {
        directory: options.directory && options.directory.length > 0 ? options.directory : 'global',
        eventId: options.eventId && options.eventId.length > 0 ? options.eventId : undefined,
      });
      for (const socket of Array.from(wsClients)) {
        const sent = sendSerializedMessageStreamWsFrame(socket, serializedFrame);
        if (!sent) {
          wsClients.delete(socket);
        }
      }
    }
  };
}

export function createMessageStreamWsRuntime({
  server,
  uiAuthController,
  tunnelAuthController,
  isRequestOriginAllowed,
  rejectWebSocketUpgrade,
  trackAuthChannel,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  processForwardedEventPayload,
  wsClients,
  triggerHealthCheck,
  heartbeatIntervalMs = MESSAGE_STREAM_WS_HEARTBEAT_INTERVAL_MS,
  upstreamStallTimeoutMs = DEFAULT_UPSTREAM_STALL_TIMEOUT_MS,
  upstreamReconnectDelayMs = DEFAULT_UPSTREAM_RECONNECT_DELAY_MS,
  fetchImpl = fetch,
  globalEventHub = null,
}: MessageStreamWsRuntimeOptions) {
  const wsServer = new WebSocketServer({
    noServer: true,
  });

  const directorySockets = new Set<WebSocket>();

  const ownsGlobalHub = !globalEventHub;
  const globalHub = globalEventHub ?? createGlobalMessageStreamHub({
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    fetchImpl,
    upstreamStallTimeoutMs,
    upstreamReconnectDelayMs,
  });

  const globalBridge = createGlobalMessageStreamWsBridge({
    globalHub,
    ownsGlobalHub,
    wsClients,
    processForwardedEventPayload,
    triggerHealthCheck,
    heartbeatIntervalMs,
  });

  wsServer.on('connection', (socket, req: AuthenticatedUpgradeRequest) => {
    const untrackAuth = trackAuthChannel?.(req?.openchamberAuthIdentity, () => {
      socket.close(1008, 'Authentication expired or revoked');
    });
    if (untrackAuth) {
      socket.once('close', untrackAuth);
    }

    const rawUrl = isRequestUrl(req?.url) ? req.url : MESSAGE_STREAM_GLOBAL_WS_PATH;
    const pathname = parseRequestPathname(rawUrl);
    const requestUrl = new URL(rawUrl, 'http://127.0.0.1');
    const isGlobalStream = pathname === MESSAGE_STREAM_GLOBAL_WS_PATH;
    const requestedLastEventId = requestUrl.searchParams.get('lastEventId')?.trim() || '';
    const requestedDirectory = requestUrl.searchParams.get('directory')?.trim() || '';

    if (isGlobalStream) {
      globalBridge.accept(socket, {
        requestedLastEventId,
      });
      return;
    }

    directorySockets.add(socket);
    socket.on('close', () => {
      directorySockets.delete(socket);
    });

    acceptDirectoryMessageStreamWsConnection({
      socket,
      requestedLastEventId,
      requestedDirectory,
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      processForwardedEventPayload,
      wsClients,
      triggerHealthCheck,
      heartbeatIntervalMs,
      upstreamStallTimeoutMs,
      upstreamReconnectDelayMs,
      fetchImpl,
      isHiddenPayload: globalHub.isHiddenPayload,
    });
  });

  const upgradeHandler = (req: AuthenticatedUpgradeRequest, socket: Duplex, head: Buffer) => {
    const pathname = parseRequestPathname(req.url);
    if (pathname !== MESSAGE_STREAM_GLOBAL_WS_PATH && pathname !== MESSAGE_STREAM_DIRECTORY_WS_PATH) {
      return;
    }

    const handleUpgrade = async () => {
      try {
        const authorization = await authorizeWebSocketUpgrade({
          req,
          uiAuthController,
          tunnelAuthController,
          isRequestOriginAllowed,
        });
        if (!authorization.ok) {
          rejectWebSocketUpgrade(socket, authorization.statusCode, authorization.reason);
          return;
        }
        req.openchamberAuthIdentity = authorization.auth;

        wsServer.handleUpgrade(req, socket, head, (ws) => {
          wsServer.emit('connection', ws, req);
        });
      } catch {
        rejectWebSocketUpgrade(socket, 500, 'Upgrade failed');
      }
    };

    void handleUpgrade();
  };

  server.on('upgrade', upgradeHandler);

  return {
    wsServer,
    rebindUpstream() {
      globalHub.stop();
      globalHub.start();
      for (const socket of Array.from(directorySockets)) {
        try {
          socket.close(1012, 'OpenCode upstream restarted');
        } catch {
          void 0;
        }
      }
    },
    async close() {
      server.off('upgrade', upgradeHandler);
      globalBridge.close();

      try {
        const clients = wsServer.clients;
        if (!clients) throw new TypeError('WebSocket client tracking is unavailable');
        for (const client of clients) {
          try {
            client.terminate();
          } catch {
            void 0;
          }
        }

        await new Promise<void>((resolve) => {
          wsServer.close(() => resolve());
        });
      } catch {
        void 0;
      } finally {
        wsClients.clear();
      }
    },
  };
}
