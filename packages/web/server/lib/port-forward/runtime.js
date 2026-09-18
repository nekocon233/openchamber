/**
 * Decides whether a request belongs to a forwarded dev server, and on what terms.
 *
 * Reaching a dev server through here requires three separate things to be true,
 * and none of them substitutes for another:
 *
 * 1. the user turned this port on — discovery alone never opens anything, or
 *    every service that happens to listen on the host would be published the
 *    moment one of them was;
 * 2. discovery still reports the port — a dev server that stopped stops being
 *    reachable, re-checked per request rather than remembered;
 * 3. the caller holds a grant or a cookie for that exact port.
 *
 * A discovery failure denies the request and leaves the user's forwards alone.
 * Those are different facts: "the scan broke" is not "the dev server is gone",
 * and treating it as the latter would quietly switch off forwards the user
 * still wants the moment `lsof` hiccuped.
 */
import { claimUpgrade } from './claim.js';
import { createForwardGrants } from './grants.js';
import { buildForwardHost, matchForwardHost, parseForwardHostTemplate } from './host-template.js';
import { proxyRequest, proxyUpgrade } from './proxy.js';

/**
 * `__Host-` makes the browser enforce what this cookie already needs to be:
 * secure, path-wide, and bound to this exact hostname with no `Domain` escape
 * hatch. Without that a sibling forward could set a cookie for the parent
 * domain and be sent along with every other forward's requests.
 */
const COOKIE_NAME = '__Host-oc_forward';
const GRANT_PARAM = '__oc_fwd';

const readCookie = (header, name) => {
  for (const pair of String(header ?? '').split(';')) {
    const separator = pair.indexOf('=');
    if (separator === -1) continue;
    if (pair.slice(0, separator).trim() !== name) continue;
    return pair.slice(separator + 1).trim();
  }
  return '';
};

/** The first hop's scheme; later entries describe proxies further out. */
const forwardedProtoOf = (req) => {
  const header = req.headers['x-forwarded-proto'];
  const value = Array.isArray(header) ? header[0] : header;
  return String(value ?? '').split(',')[0].trim().toLowerCase();
};

const refuse = (res, status, message) => {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(message);
};

const refuseUpgrade = (socket, status, message) => {
  try {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  } catch {
    // The peer is already gone; destroying below is all that is left.
  }
  try { socket.destroy(); } catch { /* already gone */ }
};

const HTTPS_REQUIRED = 'This forwarded dev server must be reached over HTTPS. '
  + 'Its cookie cannot be set otherwise, so the page would never load. '
  + 'Check that the tunnel in front of OpenChamber terminates TLS and sets X-Forwarded-Proto.';

/**
 * A request target that is a path and only a path.
 *
 * `new URL(value, base)` discards the base whenever `value` parses as absolute,
 * and `//evil.example` parses as protocol-relative — so an unchecked target
 * could move the redirect, and the proxied path, off this origin entirely.
 */
export const isSafeRequestPath = (value) => {
  const path = String(value ?? '');
  return path.startsWith('/') && !path.startsWith('//');
};

export const createPortForwardRuntime = ({
  discoverDevServers,
  grants = createForwardGrants(),
  logger = console,
} = {}) => {
  let parsed = null;
  let enabled = new Set();

  /**
   * Adopts a host template. Changing it drops every active forward, because the
   * hostnames the user was given no longer route anywhere — keeping the
   * forwards would leave URLs that look live and answer nothing.
   */
  const configure = (value) => {
    const next = String(value ?? '').trim();
    if (!next) {
      if (parsed) {
        enabled = new Set();
        grants.clear();
      }
      parsed = null;
      return { ok: true, template: null };
    }

    let nextParsed;
    try {
      nextParsed = parseForwardHostTemplate(next);
    } catch (error) {
      return { ok: false, error: error.message };
    }

    if (parsed?.template !== nextParsed.template) {
      enabled = new Set();
      grants.clear();
    }
    parsed = nextParsed;
    return { ok: true, template: parsed.template };
  };

  const originFor = (port) => `https://${buildForwardHost(parsed, port)}`;

  /**
   * Whether discovery still offers this port. Failure is reported as failure so
   * the caller can refuse without mistaking it for "the dev server stopped".
   */
  const checkDiscovery = async (port) => {
    const result = await discoverDevServers();
    if (!result?.ok) return { ok: false, reason: 'discovery-unavailable' };
    if (!result.servers.some((entry) => entry.port === port)) {
      return { ok: false, reason: 'not-listening' };
    }
    return { ok: true };
  };

  /**
   * Everything that must hold before bytes move, in the order that gives the
   * most specific answer: the checks the user can act on come before the ones
   * about credentials.
   */
  const authorize = async (req, port) => {
    if (forwardedProtoOf(req) !== 'https') {
      return { ok: false, status: 400, message: HTTPS_REQUIRED };
    }
    if (!enabled.has(port)) {
      return { ok: false, status: 404, message: `Port ${port} is not being forwarded. Turn it on in OpenChamber first.` };
    }
    const discovery = await checkDiscovery(port);
    if (!discovery.ok) {
      return discovery.reason === 'not-listening'
        ? { ok: false, status: 502, message: `Nothing is listening on port ${port} any more.` }
        : { ok: false, status: 503, message: 'OpenChamber cannot currently confirm which dev servers are running, so it will not forward this request.' };
    }
    return { ok: true };
  };

  return {
    configure,

    get configured() {
      return parsed !== null;
    },

    get template() {
      return parsed?.template ?? null;
    },

    /**
     * True when this request names a forwarded hostname — regardless of whether
     * that port is actually forwarded. A host that matches the template must
     * never fall through to OpenChamber's own routes: that would serve the app,
     * and its sign-in page, from an origin OpenChamber does not authenticate.
     */
    handles(req) {
      if (!parsed) return false;
      return matchForwardHost(parsed, req.headers?.host) !== null;
    },

    async handleRequest(req, res) {
      const port = matchForwardHost(parsed, req.headers?.host);
      if (port === null) {
        refuse(res, 404, 'Unknown forwarded host.');
        return;
      }

      if (!isSafeRequestPath(req.url)) {
        refuse(res, 400, 'Unsupported request target.');
        return;
      }

      const allowed = await authorize(req, port);
      if (!allowed.ok) {
        refuse(res, allowed.status, allowed.message);
        return;
      }

      const url = new URL(req.url, originFor(port));
      const grant = url.searchParams.get(GRANT_PARAM);
      if (grant) {
        const session = grants.redeemGrant(grant, port);
        if (!session) {
          refuse(res, 403, 'That link has already been used or has expired. Open the dev server from OpenChamber again.');
          return;
        }
        // Redirected rather than served directly so the grant leaves the
        // address bar, and with it the `Referer` of every subresource the page
        // goes on to request.
        url.searchParams.delete(GRANT_PARAM);
        res.writeHead(302, {
          location: `${url.pathname}${url.search}`,
          'set-cookie': `${COOKIE_NAME}=${session}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned`,
          'cache-control': 'no-store',
        });
        res.end();
        return;
      }

      if (!grants.hasValidSession(readCookie(req.headers.cookie, COOKIE_NAME), port)) {
        refuse(res, 403, 'This forwarded dev server needs to be opened from OpenChamber.');
        return;
      }

      proxyRequest(req, res, { port, cookieName: COOKIE_NAME, forwardedProto: 'https', logger });
    },

    async handleUpgrade(req, socket, head) {
      const port = matchForwardHost(parsed, req.headers?.host);
      if (port === null) return;

      // Claimed before any await: the other upgrade listeners run synchronously
      // on this same event and would otherwise answer the socket first.
      claimUpgrade(req);

      const allowed = await authorize(req, port);
      if (!allowed.ok) {
        refuseUpgrade(socket, allowed.status, 'Forward unavailable');
        return;
      }

      // A grant cannot travel on an upgrade: the WebSocket API sets no headers
      // and the handshake is not a navigation, so there is nothing to redirect.
      // The page that opens the socket was itself loaded through the cookie.
      if (!grants.hasValidSession(readCookie(req.headers.cookie, COOKIE_NAME), port)) {
        refuseUpgrade(socket, 403, 'Forbidden');
        return;
      }

      proxyUpgrade(req, socket, head, { port, cookieName: COOKIE_NAME, forwardedProto: 'https', logger });
    },

    enable(port) {
      if (!parsed) return { ok: false, error: 'no-template' };
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        return { ok: false, error: 'invalid-port' };
      }
      enabled.add(port);
      return { ok: true, port, origin: originFor(port) };
    },

    disable(port) {
      const removed = enabled.delete(port);
      // Revoked unconditionally: a caller stopping a forward that was already
      // off still means "nothing issued for this port should work".
      grants.revokePort(port);
      return removed;
    },

    list() {
      if (!parsed) return [];
      return [...enabled]
        .sort((left, right) => left - right)
        .map((port) => ({ port, origin: originFor(port) }));
    },

    /** Mints the single-use URL that opens `path` on a forwarded port. */
    issueGrantUrl(port, path = '/') {
      if (!parsed || !enabled.has(port)) return null;
      if (!isSafeRequestPath(path)) return null;
      const url = new URL(path, originFor(port));
      url.searchParams.set(GRANT_PARAM, grants.issueGrant(port));
      return url.toString();
    },

    dispose() {
      enabled = new Set();
      grants.clear();
      parsed = null;
    },
  };
};
