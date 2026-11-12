import { afterEach, describe, expect, test } from 'bun:test';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { createGuestServiceSocketRuntime } from './service-ws.js';
import { stopGuestService } from './service.js';
import { createUiAuth } from '../ui-auth/ui-auth.js';
import { createRequestSecurityRuntime } from '../security/request-security.js';
import { createTunnelAuth } from '../opencode/tunnel-auth.js';
import { createAuthChannelLifecycle } from '../ui-auth/channel-auth.js';
import { subscribeNotificationAuthInvalidation, notificationAuthMatchesSelector, invalidateNotificationAuth, createClientNotificationAuth } from '../notifications/auth-runtime.js';
import { isAllowedRelayWebSocketPath } from '../relay/tunnel-host.js';
import { startRelayHost } from '../relay/host-client.js';
import { generateEcdhKeyPair, exportPublicKeyJwk } from '../relay/e2ee.js';
import { createRelayTunnelClient } from '../../../../ui/src/lib/relay/tunnel-client.ts';

const cleanups = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()(); });
const listen = async (server) => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; };
const open = (url, headers = {}) => new Promise((resolve, reject) => {
  const socket = new WebSocket(url, ['binary'], { headers });
  socket.once('open', () => resolve(socket));
  socket.once('error', reject);
  socket.once('unexpected-response', (_req, res) => { res.resume(); reject(new Error(String(res.statusCode))); });
});
const refused = async (url, headers = {}) => { try { const socket = await open(url, headers); socket.terminate(); return 101; } catch (error) { return Number(error.message); } };
const response = () => { let body; return { setHeader() {}, status() { return this; }, json(value) { body = value; }, get body() { return body; } }; };

const setup = async ({ password = '', gate } = {}) => {
  const service = http.createServer();
  const serviceWs = new WebSocketServer({ noServer: true });
  const servicePort = await listen(service);
  const paths = [];
  const upstreamSockets = [];
  service.on('upgrade', (req, socket, head) => {
    expect(req.headers.authorization).toBe('Bearer private-service-token');
    expect(req.headers.origin).toBeUndefined();
    paths.push(req.url);
    serviceWs.handleUpgrade(req, socket, head, (ws) => { upstreamSockets.push(ws); ws.on('message', (bytes, binary) => ws.send(bytes, { binary })); });
  });
  const server = http.createServer();
  const port = await listen(server);
  const uiAuthController = createUiAuth({ password, clientAuthController: {
    authenticateBearerToken: async (token) => token === 'test-client' ? { ok: true, clientId: 'service-ws-test', client: { id: 'service-ws-test', expiresAt: null, revokedAt: null } } : null,
    listClients: async () => [{ id: 'service-ws-test', expiresAt: null, revokedAt: null }],
  } });
  const security = createRequestSecurityRuntime({ readSettingsFromDiskMigrated: async () => ({}) });
  const lifecycle = createAuthChannelLifecycle({ subscribeInvalidation: subscribeNotificationAuthInvalidation, matchesSelector: notificationAuthMatchesSelector });
  const guest = { id: 'desktop', name: 'Desktop', source: 'bundled', packageRoot: '/test', panel: { id: 'desktop', name: 'Desktop', icon: 'computer' },
    enabled: true, capabilityGrants: ['service'], service: { entry: 'service/main.js', runtime: 'host' } };
  let holds = 0;
  const runtime = createGuestServiceSocketRuntime({ server, uiAuthController, tunnelAuthController: createTunnelAuth(),
    isRequestOriginAllowed: security.isRequestOriginAllowed, rejectWebSocketUpgrade: security.rejectWebSocketUpgrade,
    persistPath: '/test/extensions.json', findGuest: async () => guest, trackAuthChannel: lifecycle.track,
    holdService: () => { holds++; return () => { holds--; }; },
    readyService: async () => { await gate; return { runtime: { port: servicePort, token: 'private-service-token' }, isCurrent: () => true }; },
  });
  const mint = response();
  await uiAuthController.handleUrlAuthToken({ method: 'POST', path: '/auth/url-token', headers: { authorization: 'Bearer test-client' } }, mint);
  const path = '/api/guests/desktop/service/ws?path=%2Frfb&query=%7B%22session%22%3A%22one%22%7D';
  const url = `ws://127.0.0.1:${port}${path}`;
  cleanups.push(async () => {
    runtime.stop(); lifecycle.dispose(); uiAuthController.dispose();
    for (const ws of serviceWs.clients) ws.terminate(); serviceWs.close();
    server.closeAllConnections(); service.closeAllConnections();
    await Promise.all([new Promise((resolve) => server.close(resolve)), new Promise((resolve) => service.close(resolve))]);
  });
  return { runtime, guest, paths, upstreamSockets, port, path, url, token: mint.body.token, holds: () => holds };
};

describe('extension service WebSocket boundary', () => {
  test('proxies binary and text with host-only bearer, releases holds, and closes before process teardown', async () => {
    const run = await setup();
    const socket = await open(run.url);
    expect(socket.protocol).toBe('binary'); expect(run.holds()).toBe(1);
    const echoed = once(socket, 'message'); socket.send(Buffer.from([0, 255, 4]));
    const [bytes, binary] = await echoed; expect(Buffer.from(bytes)).toEqual(Buffer.from([0, 255, 4])); expect(binary).toBe(true);
    const textEcho = once(socket, 'message'); socket.send('hello');
    const [text, textBinary] = await textEcho; expect(Buffer.from(text).toString()).toBe('hello'); expect(textBinary).toBe(false);
    expect(run.paths).toEqual(['/rfb?session=one']);
    const closed = once(socket, 'close'); await stopGuestService('desktop'); await closed;
    expect(run.holds()).toBe(0);
  });
  test('normalizes an upstream close without status and preserves application close parameters', async () => {
    const run = await setup();
    const socket = await open(run.url);
    const closed = once(socket, 'close'); run.upstreamSockets[0].close();
    const [code] = await closed; expect(code).toBe(1000); expect(run.holds()).toBe(0);
    const next = await open(run.url); const upstreamClosed = once(run.upstreamSockets[1], 'close');
    next.close(4001, 'done'); const [upstreamCode, reason] = await upstreamClosed;
    expect(upstreamCode).toBe(4001); expect(Buffer.from(reason).toString()).toBe('done');
  });
  test('enforces password URL auth, rejects opaque and hostile origins, and revokes established sockets', async () => {
    const run = await setup({ password: 'test-password' });
    expect(await refused(run.url)).toBe(401);
    const authenticated = `${run.url}&oc_url_token=${encodeURIComponent(run.token)}`;
    expect(await refused(authenticated, { origin: 'null' })).toBe(403);
    expect(await refused(authenticated, { origin: 'https://evil.example' })).toBe(403);
    const socket = await open(authenticated, { origin: `http://127.0.0.1:${run.port}` });
    const closed = once(socket, 'close'); invalidateNotificationAuth(createClientNotificationAuth('service-ws-test')); await closed;
    expect(run.holds()).toBe(0);
    expect(await refused(authenticated)).toBe(401);
  });
  test('refuses disabled, ungranted, invalid-path and enterprise-blocked services without a hold', async () => {
    const run = await setup();
    run.guest.enabled = false; expect(await refused(run.url)).toBe(403);
    run.guest.enabled = true; run.guest.capabilityGrants = []; expect(await refused(run.url)).toBe(403);
    run.guest.capabilityGrants = ['service'];
    for (const path of ['//outside.example', '/rfb?other=1', '/a/../rfb']) expect(await refused(`ws://127.0.0.1:${run.port}/api/guests/desktop/service/ws?path=${encodeURIComponent(path)}`)).toBe(400);
    const before = process.env.OPENCHAMBER_ENTERPRISE_MODE;
    try { process.env.OPENCHAMBER_ENTERPRISE_MODE = '1'; expect(await refused(run.url)).toBe(403); }
    finally { if (before === undefined) delete process.env.OPENCHAMBER_ENTERPRISE_MODE; else process.env.OPENCHAMBER_ENTERPRISE_MODE = before; }
    expect(run.holds()).toBe(0); expect(run.paths).toEqual([]);
  });
  test('deactivation cancels a handshake waiting for service readiness', async () => {
    let release; const gate = new Promise((resolve) => { release = resolve; });
    const run = await setup({ gate });
    const attempt = refused(run.url);
    for (let i = 0; i < 100 && run.holds() === 0; i++) await new Promise((resolve) => setTimeout(resolve, 1));
    run.runtime.endForGuest('desktop'); release();
    expect(await attempt).toBe(503); expect(run.holds()).toBe(0); expect(run.paths).toEqual([]);
  });
  test('carries binary frames through the encrypted private relay with real URL-auth and Origin gates', async () => {
    const run = await setup();
    expect(isAllowedRelayWebSocketPath('/api/guests/desktop/service/ws')).toBe(true);
    expect(isAllowedRelayWebSocketPath('/api/guests/desktop/service/ws/extra')).toBe(false);
    const broker = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(broker, 'listening');
    let control, clientLeg, hostLeg; const waiting = [];
    broker.on('connection', (socket, req) => {
      const role = new URL(req.url, 'http://localhost').searchParams.get('role');
      if (role === 'host-control') { control = socket; socket.send(JSON.stringify({ type: 'sync', connectionIds: clientLeg ? ['fixture'] : [] })); }
      else if (role === 'client') {
        clientLeg = socket; control?.send(JSON.stringify({ type: 'connected', connectionId: 'fixture' }));
        socket.on('message', (bytes, binary) => hostLeg ? hostLeg.send(bytes, { binary }) : waiting.push({ bytes, binary }));
      } else {
        hostLeg = socket; for (const frame of waiting.splice(0)) socket.send(frame.bytes, { binary: frame.binary });
        socket.on('message', (bytes, binary) => clientLeg?.send(bytes, { binary }));
      }
    });
    const keys = await generateEcdhKeyPair();
    const relayUrl = `ws://127.0.0.1:${broker.address().port}/ws`;
    const host = startRelayHost({ relayUrl, localPort: run.port, identity: { serverId: 'fixture', hostEncPrivateKey: keys.privateKey, signRelayAuth: () => ({ ts: 0, sig: '', pk: '' }) } });
    const client = createRelayTunnelClient({ relayUrl, serverId: 'fixture', hostEncPubJwk: await exportPublicKeyJwk(keys.publicKey) });
    cleanups.push(async () => { client.close(); host.stop(); for (const ws of broker.clients) ws.terminate(); await new Promise((resolve) => broker.close(resolve)); });
    for (let i = 0; i < 500 && client.getStatus().state !== 'connected'; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(client.getStatus().state).toBe('connected');
    const socket = client.openWebSocket(`${run.path}&oc_url_token=${encodeURIComponent(run.token)}`, ['binary']);
    const opened = new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error('Relay socket failed')); });
    await opened;
    expect(socket.protocol).toBe('binary');
    const echo = new Promise((resolve) => { socket.onmessage = (event) => resolve(event.data); });
    const data = new Uint8Array(512 * 1024).map((_, index) => index % 251); socket.send(data);
    expect(new Uint8Array(await echo)).toEqual(data);
    socket.close();
  }, 10_000);
});
