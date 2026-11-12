import {
  GUEST_SERVICE_SOCKET_MAX, GUEST_SERVICE_SOCKET_FRAME_MAX, GUEST_SERVICE_SOCKET_BUFFER_MAX,
  OPENCHAMBER_SDK_CHANNEL, OPENCHAMBER_SDK_API_VERSION, serviceSocketDataSize,
  type GuestServiceSocketMessage, type HostMessage, type HostServiceSocketMessage, type HostRequestErrorCode,
} from '@openchamber/sdk';
import { openRuntimeWebSocket } from '@/lib/relay/runtime-socket';
import type { RelayTunnelWebSocket } from '@/lib/relay/tunnel-client';
import { refreshRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';

type SocketEntry = { socket: RelayTunnelWebSocket | null; received: number; ended: boolean; timer: ReturnType<typeof setTimeout> | null };
type Dependencies = {
  authorized: () => boolean;
  post: (message: HostMessage, transfer?: Transferable[]) => void;
  refreshAuth?: () => Promise<string>;
  openSocket?: (path: string, protocols?: string[]) => RelayTunnelWebSocket;
};

/** One registry per mounted document. Retired frames cannot open or retain channels. */
export const createGuestServiceSockets = (guestId: string, deps: Dependencies) => {
  const entries = new Map<string, SocketEntry>();
  let disposed = false;
  const post = (message: HostServiceSocketMessage, transfer?: Transferable[]) => {
    deps.post({ channel: OPENCHAMBER_SDK_CHANNEL, v: OPENCHAMBER_SDK_API_VERSION, ...message }, transfer);
  };
  const end = (socketId: string, entry: SocketEntry, code = 1006, reason = '', error?: HostRequestErrorCode) => {
    if (entry.ended) return;
    entry.ended = true;
    entries.delete(socketId);
    if (entry.timer) clearTimeout(entry.timer);
    try {
      if (entry.socket && entry.socket.readyState < 2) entry.socket.close(code === 1000 || code >= 3000 ? code : 1000, reason);
    } catch { /* A retired socket cannot interrupt cleanup of the remaining ones. */ }
    post({ type: 'service-ws-closed', payload: { socketId, code, reason, wasClean: !error && code !== 1006, ...(error ? { error } : {}) } });
  };
  const open = async (payload: Extract<GuestServiceSocketMessage, { type: 'service-ws-open' }>['payload']) => {
    const { socketId } = payload;
    if (entries.has(socketId)) { end(socketId, entries.get(socketId)!, 1008, 'Duplicate socket id.', 'HOST_REJECTED'); return; }
    const entry: SocketEntry = { socket: null, received: 0, ended: false, timer: null };
    if (disposed || !deps.authorized() || entries.size >= GUEST_SERVICE_SOCKET_MAX) {
      end(socketId, entry, 1008, 'Service socket is unavailable.', 'NO_SERVICE');
      return;
    }
    entries.set(socketId, entry);
    entry.timer = setTimeout(() => end(socketId, entry, 1006, 'Socket connection timed out.', 'HOST_TIMEOUT'), 20_000);
    try {
      await (deps.refreshAuth ?? refreshRuntimeUrlAuthToken)();
      if (entry.ended) return;
      if (disposed || !deps.authorized()) { end(socketId, entry, 1008, 'Extension is unavailable.', 'DISABLED'); return; }
      const query = new URLSearchParams({ path: payload.path });
      if (payload.query) query.set('query', JSON.stringify(payload.query));
      const path = `/api/guests/${guestId}/service/ws?${query}`;
      const socket = (deps.openSocket ?? ((url, protocols) => openRuntimeWebSocket(getRuntimeUrlResolver().websocket(url), protocols)))(path, payload.protocols);
      entry.socket = socket;
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => {
        if (entry.ended || disposed || !deps.authorized()) { end(socketId, entry, 1008, 'Extension is unavailable.', 'DISABLED'); return; }
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = null;
        post({ type: 'service-ws-open', payload: { socketId, protocol: socket.protocol ?? '' } });
      };
      socket.onmessage = ({ data }) => {
        if (entry.ended || disposed || !deps.authorized()) { end(socketId, entry, 1008, 'Extension is unavailable.', 'DISABLED'); return; }
        const bytes = typeof data === 'string' ? data : new Uint8Array(data);
        const size = serviceSocketDataSize(bytes);
        if (size > GUEST_SERVICE_SOCKET_FRAME_MAX || entry.received + size > GUEST_SERVICE_SOCKET_BUFFER_MAX) {
          end(socketId, entry, 1009, 'Service socket buffer exceeded.', 'RESPONSE_TOO_LARGE'); return;
        }
        entry.received += size;
        post({ type: 'service-ws-message', payload: { socketId, data: bytes } }, typeof bytes === 'string' ? undefined : [bytes.buffer]);
      };
      socket.onerror = () => end(socketId, entry, 1006, 'Service connection failed.', 'SERVICE_FAILED');
      socket.onclose = ({ code, reason }) => end(socketId, entry, code, reason);
    } catch { end(socketId, entry, 1006, 'Service connection failed.', 'SERVICE_FAILED'); }
  };
  return {
    receive(message: GuestServiceSocketMessage) {
      if (message.type === 'service-ws-open') { void open(message.payload); return; }
      const { socketId } = message.payload;
      const entry = entries.get(socketId);
      if (!entry || entry.ended) return;
      if (message.type === 'service-ws-close') {
        if (!entry.socket || entry.socket.readyState !== 1) { end(socketId, entry, 1006, '', 'HOST_UNAVAILABLE'); return; }
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = setTimeout(() => end(socketId, entry, 1006, '', 'HOST_TIMEOUT'), 5000);
        try { entry.socket.close(message.payload.code ?? 1000, message.payload.reason ?? ''); }
        catch { end(socketId, entry, 1006, '', 'REQUEST_FAILED'); }
        return;
      }
      if (disposed || !deps.authorized()) { end(socketId, entry, 1008, 'Extension is unavailable.', 'DISABLED'); return; }
      const payload = message.payload;
      if ('received' in payload) {
        if (payload.received > entry.received) { end(socketId, entry, 1008, 'Invalid socket acknowledgement.', 'HOST_REJECTED'); return; }
        entry.received -= payload.received;
        return;
      }
      const size = serviceSocketDataSize(payload.data);
      if (!entry.socket || entry.socket.readyState !== 1) { end(socketId, entry, 1008, 'Socket is not open.', 'HOST_REJECTED'); return; }
      if (size > GUEST_SERVICE_SOCKET_FRAME_MAX || (entry.socket.bufferedAmount ?? GUEST_SERVICE_SOCKET_BUFFER_MAX) + size > GUEST_SERVICE_SOCKET_BUFFER_MAX) {
        end(socketId, entry, 1009, 'Service socket buffer exceeded.', 'RESPONSE_TOO_LARGE'); return;
      }
      try {
        entry.socket.send(payload.data);
        post({ type: 'service-ws-message', payload: { socketId, sent: size } });
      } catch { end(socketId, entry, 1006, 'Service send failed.', 'REQUEST_FAILED'); }
    },
    dispose() { disposed = true; for (const [id, entry] of [...entries]) end(id, entry, 1000, 'Frame retired.'); },
  };
};
