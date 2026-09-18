/**
 * Who may load a forwarded dev server.
 *
 * A forwarded port answers on its own hostname, so the browser sends none of
 * the OpenChamber credentials with it: a bearer header belongs to the API
 * origin, and this is a different one. The page is also loaded by the browser
 * itself — an iframe, a link, every subresource under it — so there is nowhere
 * to attach a header even if one existed.
 *
 * So the panel, which *is* authenticated, mints a single-use grant on the
 * OpenChamber origin and hands it to the browser in the forwarded URL. The
 * forward exchanges it once for a cookie scoped to that one hostname, and every
 * request afterwards carries the cookie. The grant is short-lived and consumed
 * on first use, so the copy left in history, logs, or a `Referer` is already
 * spent.
 *
 * Nothing here is persisted. A forward is something the user turned on for this
 * session; surviving a restart would mean a dev server stayed reachable after
 * the moment anybody decided it should be.
 */
import crypto from 'node:crypto';

/** Long enough to cross one redirect, short enough to be worthless if leaked. */
const GRANT_TTL_MS = 30_000;
/** A working day, so a long-lived panel is not interrupted to re-authorise. */
const SESSION_TTL_MS = 12 * 60 * 60 * 1_000;

const TOKEN_BYTES = 32;

const defaultRandomToken = () => crypto.randomBytes(TOKEN_BYTES).toString('base64url');

/**
 * Tokens are 256-bit random values looked up in a map. The lookup is not
 * constant-time, but distinguishing a hit from a miss by timing does not help
 * an attacker who must first produce a value in the space at all.
 */
export const createForwardGrants = ({
  now = () => Date.now(),
  randomToken = defaultRandomToken,
  grantTtlMs = GRANT_TTL_MS,
  sessionTtlMs = SESSION_TTL_MS,
} = {}) => {
  /** token -> { port, expiresAt } */
  const grants = new Map();
  /** token -> { port, expiresAt } */
  const sessions = new Map();

  const dropExpired = (store, at) => {
    for (const [token, entry] of store) {
      if (entry.expiresAt <= at) store.delete(token);
    }
  };

  const takeValid = (store, token, port, at) => {
    const entry = token ? store.get(token) : undefined;
    if (!entry) return null;
    if (entry.expiresAt <= at) {
      store.delete(token);
      return null;
    }
    // A grant for one port must not open another. Without this the weakest
    // forward the user ever enabled would be a key to every other one.
    if (entry.port !== port) return null;
    return entry;
  };

  return {
    /** Mints a single-use grant for `port`. The caller must already be authenticated. */
    issueGrant(port) {
      const at = now();
      dropExpired(grants, at);
      dropExpired(sessions, at);

      const token = randomToken();
      grants.set(token, { port, expiresAt: at + grantTtlMs });
      return token;
    },

    /**
     * Consumes a grant and returns the session token to set as a cookie, or
     * null when the grant is unknown, expired, already used, or for a
     * different port.
     */
    redeemGrant(token, port) {
      const at = now();
      const grant = takeValid(grants, token, port, at);
      if (!grant) return null;
      grants.delete(token);

      const session = randomToken();
      sessions.set(session, { port, expiresAt: at + sessionTtlMs });
      return session;
    },

    hasValidSession(token, port) {
      return takeValid(sessions, token, port, now()) !== null;
    },

    /**
     * Invalidates everything issued for a port. Called when a forward is turned
     * off, so stopping one is immediate rather than a promise that it expires
     * eventually.
     */
    revokePort(port) {
      for (const [token, entry] of grants) {
        if (entry.port === port) grants.delete(token);
      }
      for (const [token, entry] of sessions) {
        if (entry.port === port) sessions.delete(token);
      }
    },

    clear() {
      grants.clear();
      sessions.clear();
    },
  };
};
