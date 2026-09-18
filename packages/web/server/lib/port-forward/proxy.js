/**
 * Carries one request between a forwarded hostname and the dev server behind it.
 *
 * The forward exists so the page keeps its own origin, which means the path
 * space here is identical on both sides: nothing is prefixed, so no HTML, URL,
 * or script has to be rewritten to survive the trip. Compare the raw byte
 * tunnel in `../dev-tunnel/`, which achieves the same thing for the desktop
 * client and can therefore avoid touching headers at all. This one cannot: it
 * terminates HTTP, so it owns `Host`, the hop-by-hop headers, and its own
 * cookie. Those three edits are the entire difference, and they are listed in
 * `DOCUMENTATION.md` so nobody assumes the two paths make the same promise.
 */
import http from 'node:http';
import net from 'node:net';

const CONNECT_TIMEOUT_MS = 5_000;

/**
 * Headers that describe one hop and must not be relayed to the next. `Connection`
 * itself may also name further headers to drop, which is why the set is built
 * per request rather than being a constant.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const hopByHopFor = (headers) => {
  const drop = new Set(HOP_BY_HOP);
  for (const token of String(headers.connection ?? '').split(',')) {
    const name = token.trim().toLowerCase();
    if (name) drop.add(name);
  }
  return drop;
};

/**
 * Removes OpenChamber's own cookie from the pairs sent onward.
 *
 * The dev server has no use for it and every reason not to see it: whatever it
 * logs, echoes into an error page, or forwards to its own upstream would be
 * carrying a credential for this forward.
 */
const stripForwardCookie = (value, cookieName) => {
  const raw = String(value ?? '');
  if (!raw) return '';
  const kept = raw
    .split(';')
    .filter((pair) => pair.split('=')[0].trim() !== cookieName);
  return kept.join(';').trim();
};

const buildUpstreamHeaders = (req, { port, cookieName, forwardedProto }) => {
  const drop = hopByHopFor(req.headers);
  const headers = {};

  for (const [name, value] of Object.entries(req.headers)) {
    if (drop.has(name)) continue;
    if (name === 'host' || name === 'cookie') continue;
    headers[name] = value;
  }

  // Presented as loopback because that is what the dev server is: frameworks
  // that check `Host` against an allowlist (Vite's `allowedHosts`, Rails'
  // `host_authorization`) would otherwise reject a hostname they were never
  // told about, and the user would see a framework error page instead of
  // their app.
  headers.host = `localhost:${port}`;

  const cookie = stripForwardCookie(req.headers.cookie, cookieName);
  if (cookie) headers.cookie = cookie;

  // The browser reached us over TLS the tunnel terminated; a dev server that
  // builds absolute URLs or sets a `Secure` cookie needs to know that.
  headers['x-forwarded-proto'] = forwardedProto;
  headers['x-forwarded-host'] = String(req.headers.host ?? '');
  const remote = req.socket?.remoteAddress;
  if (remote) headers['x-forwarded-for'] = remote;

  return headers;
};

const responseHeadersFor = (upstreamRes) => {
  const drop = hopByHopFor(upstreamRes.headers);
  const out = [];
  const raw = upstreamRes.rawHeaders;
  // Walked raw so repeated headers survive: a dev server may set several
  // cookies, and collapsing them would silently drop all but one.
  for (let index = 0; index < raw.length; index += 2) {
    const name = raw[index];
    if (drop.has(name.toLowerCase())) continue;
    out.push(name, raw[index + 1]);
  }
  return out;
};

/** Proxies a plain HTTP request to `127.0.0.1:port`. */
export const proxyRequest = (req, res, { port, cookieName, forwardedProto, logger = console }) => {
  const upstream = http.request({
    host: '127.0.0.1',
    port,
    method: req.method,
    path: req.url,
    headers: buildUpstreamHeaders(req, { port, cookieName, forwardedProto }),
  });

  upstream.setTimeout(CONNECT_TIMEOUT_MS, () => {
    upstream.destroy(new Error('Timed out connecting to the dev server'));
  });

  upstream.on('response', (upstreamRes) => {
    // The socket survived the connect, so the timeout has done its job; a
    // streaming response (SSE, a long poll) must not be cut off by it.
    upstream.setTimeout(0);
    res.writeHead(upstreamRes.statusCode ?? 502, responseHeadersFor(upstreamRes));
    upstreamRes.pipe(res);
    upstreamRes.on('error', () => res.destroy());
  });

  upstream.on('error', (error) => {
    logger.warn?.(`[port-forward] upstream failed for port ${port}: ${error?.message || error}`);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`The dev server on port ${port} did not answer.`);
  });

  req.on('error', () => upstream.destroy());
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
};

/**
 * Rebuilds the upgrade request for the upstream socket.
 *
 * `Connection` and `Upgrade` are hop-by-hop everywhere else and are exactly
 * what must survive here — dropping them turns the handshake into a plain
 * request and the socket never upgrades.
 */
const serializeUpgradeRequest = (req, { port, cookieName, forwardedProto }) => {
  const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
  const raw = req.rawHeaders;

  for (let index = 0; index < raw.length; index += 2) {
    const name = raw[index];
    const lower = name.toLowerCase();
    if (lower === 'host' || lower === 'cookie') continue;
    if (lower === 'x-forwarded-proto' || lower === 'x-forwarded-host' || lower === 'x-forwarded-for') continue;
    lines.push(`${name}: ${raw[index + 1]}`);
  }

  lines.push(`Host: localhost:${port}`);
  const cookie = stripForwardCookie(req.headers.cookie, cookieName);
  if (cookie) lines.push(`Cookie: ${cookie}`);
  lines.push(`X-Forwarded-Proto: ${forwardedProto}`);
  const browserHost = String(req.headers.host ?? '');
  if (browserHost) lines.push(`X-Forwarded-Host: ${browserHost}`);
  const remote = req.socket?.remoteAddress;
  if (remote) lines.push(`X-Forwarded-For: ${remote}`);

  return `${lines.join('\r\n')}\r\n\r\n`;
};

/**
 * Pipes a WebSocket upgrade to the dev server as raw bytes.
 *
 * This is what makes HMR work. Once the handshake is through, neither side
 * inspects the stream again — a framework's hot-update protocol is its own
 * business.
 */
export const proxyUpgrade = (req, socket, head, { port, cookieName, forwardedProto, logger = console }) => {
  socket.setNoDelay(true);

  const upstream = net.connect({ host: '127.0.0.1', port });
  upstream.setNoDelay(true);

  let settled = false;
  const teardown = () => {
    if (settled) return;
    settled = true;
    try { upstream.destroy(); } catch { /* already gone */ }
    try { socket.destroy(); } catch { /* already gone */ }
  };

  const connectTimer = setTimeout(() => {
    if (!upstream.connecting) return;
    logger.warn?.(`[port-forward] timed out upgrading to port ${port}`);
    teardown();
  }, CONNECT_TIMEOUT_MS);

  upstream.on('connect', () => {
    clearTimeout(connectTimer);
    upstream.write(serializeUpgradeRequest(req, { port, cookieName, forwardedProto }));
    if (head?.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });

  upstream.on('error', (error) => {
    clearTimeout(connectTimer);
    logger.warn?.(`[port-forward] upgrade failed for port ${port}: ${error?.message || error}`);
    teardown();
  });
  upstream.on('close', () => { clearTimeout(connectTimer); teardown(); });
  socket.on('error', teardown);
  socket.on('close', teardown);
};
