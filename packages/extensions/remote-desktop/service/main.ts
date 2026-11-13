import http from 'node:http';
import { ZodError } from 'zod';
import { desktopStartSchema, type DesktopServiceReply, type DesktopFailure } from '../contract.ts';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { inspectEnvironment, INSTALL_COMMANDS } from './environment.ts';
import { createDesktopSessions, DesktopError } from './session.ts';
import { runSessionSupervisor } from './supervisor.ts';
import { createRfbWebSocket, websocketAccept } from './websocket.ts';

const json = (res: http.ServerResponse, status: number, value: DesktopServiceReply) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};
const readRawBody = async (req: http.IncomingMessage): Promise<string> => {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw new Error('BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
};
const readStartBody = async (req: http.IncomingMessage) => {
  const raw = (await readRawBody(req)).trim();
  return desktopStartSchema.parse(raw ? JSON.parse(raw) : {});
};

export const startDesktopService = (port: number, token: string) => {
  const sessions = createDesktopSessions(fileURLToPath(import.meta.url));
  const authorized = (req: http.IncomingMessage) => req.headers.authorization === `Bearer ${token}` && !req.headers.origin;
  const server = http.createServer((req, res) => {
    if (!authorized(req)) { json(res, 401, { error: 'UNAUTHORIZED' }); return; }
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/health' && req.method === 'GET') { json(res, 200, { ok: true }); return; }
        if (url.pathname === '/status' && req.method === 'GET') {
          const environment = await inspectEnvironment();
          const missing: DesktopFailure[] = environment.platform !== 'linux' ? ['UNSUPPORTED'] : [];
          if (environment.platform === 'linux') {
            if (!environment.binaries.password) missing.push('NO_PASSWORD_TOOL');
            if (!environment.binaries.virtual) missing.push('NO_VIRTUAL_SERVER');
            if (!environment.binaries.desktop) missing.push('NO_DESKTOP');
          }
          json(res, 200, {
            platform: environment.platform,
            missing,
            session: sessions.status(),
            install: INSTALL_COMMANDS,
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/session/stop') {
          await readRawBody(req);
          await sessions.stop();
          json(res, 200, { stopped: true });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/session/start') {
          const { width, height } = await readStartBody(req);
          const session = await sessions.start({ width, height });
          // This short-lived VNC credential authenticates only this loopback
          // desktop. The host service bearer and TCP port never reach the frame.
          json(res, 200, { id: session.id, display: session.display, password: session.password });
          return;
        }
        json(res, 404, { error: 'NOT_FOUND' });
      } catch (error) {
        if (!res.headersSent) json(res, error instanceof DesktopError ? 409 : error instanceof ZodError || error instanceof SyntaxError ? 400 : 500, { error: error instanceof DesktopError ? error.code : error instanceof ZodError || error instanceof SyntaxError ? 'BAD_REQUEST' : 'REQUEST_FAILED' });
        else res.end();
      }
    })();
  });
  server.requestTimeout = 20_000;
  server.on('upgrade', (req, socket, head) => {
    if (!authorized(req)) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const accept = websocketAccept(req);
    const session = sessions.get(url.searchParams.get('session') ?? '');
    if (url.pathname !== '/rfb' || !accept || !session) { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return; }
    const tcp = net.createConnection({ host: '127.0.0.1', port: session.port });
    let release = () => {};
    let ws: ReturnType<typeof createRfbWebSocket> | null = null;
    const close = () => { tcp.destroy(); release(); };
    tcp.once('connect', () => {
      const protocol = accept.protocol ? `Sec-WebSocket-Protocol: ${accept.protocol}\r\n` : '';
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept.accept}\r\n${protocol}\r\n`);
      ws = createRfbWebSocket(socket, (bytes) => { if (!tcp.write(bytes)) socket.pause(); }, close);
      release = sessions.watch(session, () => ws?.close(1001));
      tcp.on('data', (data) => { if (!ws?.send(data)) tcp.pause(); });
      socket.on('drain', () => tcp.resume());
      tcp.on('drain', () => socket.resume());
      if (head.length) ws.feed(head);
    });
    tcp.once('error', () => { if (ws) ws.close(1011); else socket.destroy(); close(); });
    tcp.once('close', () => { ws?.close(1000); close(); });
    socket.once('close', close);
    socket.once('error', close);
  });
  server.listen(port, '127.0.0.1');
  return { server, async stop() { await sessions.stopAll(); server.close(); server.closeAllConnections(); } };
};

if (process.argv.includes('--desktop-session')) runSessionSupervisor();
else {
  const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
  const token = process.env.OPENCHAMBER_SERVICE_TOKEN;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !token) throw new Error('OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required');
  const service = startDesktopService(port, token);
  let stopping = false;
  const stop = () => { if (stopping) return; stopping = true; void service.stop().finally(() => process.exit(0)); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
