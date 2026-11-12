import { describe, expect, test } from 'bun:test';
import type { HostMessage } from '@openchamber/sdk';
import type { RelayTunnelWebSocket } from '@/lib/relay/tunnel-client';
import { createGuestServiceSockets } from './service-socket';

class Socket implements RelayTunnelWebSocket {
  readyState = 0;
  protocol = 'binary';
  bufferedAmount = 0;
  onopen: RelayTunnelWebSocket['onopen'] = null;
  onmessage: RelayTunnelWebSocket['onmessage'] = null;
  onclose: RelayTunnelWebSocket['onclose'] = null;
  onerror: RelayTunnelWebSocket['onerror'] = null;
  sent: Parameters<RelayTunnelWebSocket['send']>[0][] = [];
  send(data: Parameters<RelayTunnelWebSocket['send']>[0]) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.({ code: 1000, reason: '' }); }
  open() { this.readyState = 1; this.onopen?.(); }
}
const setup = (refreshAuth: () => Promise<string> = async () => 'auth') => {
  const posted: HostMessage[] = [];
  const sockets: Socket[] = [];
  const paths: string[] = [];
  let authorized = true;
  const owner = createGuestServiceSockets('demo', {
    authorized: () => authorized, refreshAuth,
    post: (message) => posted.push(message),
    openSocket: (path) => { paths.push(path); const socket = new Socket(); sockets.push(socket); return socket; },
  });
  return { owner, posted, sockets, paths, retire: () => { authorized = false; owner.dispose(); } };
};
const open = { type: 'service-ws-open', payload: { socketId: 'one', path: '/rfb', query: { session: 'id' }, protocols: ['binary'] } } as const;

describe('mounted guest service sockets', () => {
  test('mints auth before opening and carries ordered binary data and acknowledgements', async () => {
    const run = setup();
    run.owner.receive({ ...open, payload: { ...open.payload, protocols: ['binary'] } });
    expect(run.sockets).toHaveLength(0);
    await Promise.resolve();
    const socket = run.sockets[0]!; socket.open();
    expect(run.paths[0]).toContain('/api/guests/demo/service/ws?path=%2Frfb');
    expect(run.paths[0]).not.toContain('auth');
    run.owner.receive({ type: 'service-ws-send', payload: { socketId: 'one', data: new Uint8Array([0, 255]) } });
    expect(socket.sent).toEqual([new Uint8Array([0, 255])]);
    expect(run.posted.at(-1)).toMatchObject({ type: 'service-ws-message', payload: { sent: 2 } });
    socket.onmessage?.({ data: new Uint8Array([1, 2, 3]).buffer });
    expect(run.posted.at(-1)).toMatchObject({ type: 'service-ws-message', payload: { data: new Uint8Array([1, 2, 3]) } });
    run.owner.receive({ type: 'service-ws-send', payload: { socketId: 'one', received: 3 } });
    run.retire(); expect(socket.readyState).toBe(3);
  });
  test('retirement during URL-token refresh cannot open a stale runtime socket', async () => {
    let resolve!: (token: string) => void;
    const run = setup(() => new Promise<string>((done) => { resolve = done; }));
    run.owner.receive({ ...open, payload: { ...open.payload, protocols: ['binary'] } });
    run.retire(); resolve('retired-token'); await Promise.resolve();
    expect(run.sockets).toHaveLength(0);
    expect(run.posted.at(-1)).toMatchObject({ type: 'service-ws-closed', payload: { socketId: 'one' } });
  });
  test('caps concurrent pending handshakes and rejects unacknowledged receive overflow', async () => {
    const run = setup();
    for (let i = 0; i < 9; i += 1) run.owner.receive({ type: 'service-ws-open', payload: { socketId: String(i), path: '/rfb' } });
    await Promise.resolve();
    expect(run.sockets).toHaveLength(8);
    expect(run.posted[0]).toMatchObject({ type: 'service-ws-closed', payload: { socketId: '8', error: 'NO_SERVICE' } });
    const socket = run.sockets[0]!; socket.open();
    socket.onmessage?.({ data: new ArrayBuffer(8_000_000) });
    socket.onmessage?.({ data: new ArrayBuffer(1) });
    expect(run.posted.at(-1)).toMatchObject({ type: 'service-ws-closed', payload: { code: 1009, error: 'RESPONSE_TOO_LARGE' } });
    run.retire();
  });
});

test('forwards an application close code and reason to the actual transport', async () => {
  const run = setup(); run.owner.receive({ type: 'service-ws-open', payload: { socketId: 'one', path: '/rfb' } }); await Promise.resolve();
  const socket = run.sockets[0]!; socket.open();
  let closed: [number | undefined, string | undefined] | null = null;
  socket.close = (code?: number, reason?: string) => { closed = [code, reason]; socket.readyState = 3; socket.onclose?.({ code: code ?? 1000, reason: reason ?? '' }); };
  run.owner.receive({ type: 'service-ws-close', payload: { socketId: 'one', code: 4001, reason: 'done' } });
  expect(closed).toEqual([4001, 'done']);
  expect(run.posted.at(-1)).toMatchObject({ type: 'service-ws-closed', payload: { code: 4001, reason: 'done', wasClean: true } });
  run.retire();
});

test('refuses to queue into a saturated runtime transport', async () => {
  const run = setup(); run.owner.receive({ type: 'service-ws-open', payload: { socketId: 'one', path: '/rfb' } }); await Promise.resolve();
  const socket = run.sockets[0]!; socket.open(); socket.bufferedAmount = 8_000_000;
  run.owner.receive({ type: 'service-ws-send', payload: { socketId: 'one', data: new Uint8Array([1]) } });
  expect(socket.sent).toEqual([]);
  expect(run.posted.at(-1)).toMatchObject({ type: 'service-ws-closed', payload: { code: 1009, error: 'RESPONSE_TOO_LARGE' } });
  run.retire();
});
