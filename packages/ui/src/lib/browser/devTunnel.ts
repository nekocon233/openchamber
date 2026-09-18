/**
 * Makes a remote dev server browsable from the desktop app.
 *
 * A URL like `http://localhost:5173` means "this machine" to whoever resolves
 * it. When OpenChamber is running on another host, that is the wrong machine:
 * the dev server is on the host, the browser is here. The desktop shell binds
 * an equivalent local port and pipes it to the host, so the same page loads
 * from a real local origin with nothing rewritten.
 *
 * Everywhere else — local runtime, web, mobile — the URL is already correct and
 * is returned untouched.
 */
import { invokeDesktopCommand } from '@/lib/desktopNative';
import { getRuntimeBearerTokenSync, getRuntimeExtraHeadersSync } from '@/lib/runtime-auth';
import { getRuntimeApiBaseUrl, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { isLoopbackUrl, isRemoteOpenChamberOrigin, loopbackPort } from './url';

type TunnelResult = { localPort: number; reused: boolean; url: string };

/** Keyed by `${baseUrl}|${port}`; the shell owns the real lifetime. */
const localPortByTarget = new Map<string, number>();
/** Reverse map, so a tunnel port never leaks into the address bar or storage. */
const originByLocalPort = new Map<number, string>();

const isDesktopRuntime = (): boolean => (
  typeof window !== 'undefined' && Boolean(window.__OPENCHAMBER_ELECTRON__)
);

const rewriteToLocalPort = (url: string, localPort: number): string => {
  try {
    const parsed = new URL(url);
    parsed.protocol = 'http:';
    parsed.hostname = '127.0.0.1';
    parsed.port = String(localPort);
    return parsed.toString();
  } catch {
    return url;
  }
};

/** Thrown when a remote dev server exists but could not be reached from here. */
export class DevTunnelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DevTunnelUnavailableError';
  }
}

/**
 * Returns the URL the browser view should actually load.
 *
 * A failure to tunnel is reported rather than papered over. Loading the
 * original loopback URL instead would not be "the same outcome without this
 * mechanism": on a remote instance it changes which machine answers, so the
 * user would be shown whatever happens to run on that port here — possibly a
 * different application — under the address they asked for. The refusal is
 * often authoritative, too: discovery unavailable, port not offered,
 * authentication rejected. None of that should look like a page.
 */
export const resolveBrowsableUrl = async (url: string): Promise<string> => {
  if (!url || !isDesktopRuntime() || !isLoopbackUrl(url)) return url;

  const baseUrl = getRuntimeApiBaseUrl();
  if (!isRemoteOpenChamberOrigin(baseUrl)) return url;

  const port = loopbackPort(url);
  if (!port) return url;

  const key = `${baseUrl}|${port}`;
  const cached = localPortByTarget.get(key);
  if (cached) {
    try {
      originByLocalPort.set(cached, new URL(url).origin);
    } catch {
      // Unparseable input never reaches here; nothing to record.
    }
    return rewriteToLocalPort(url, cached);
  }

  try {
    const result = await invokeDesktopCommand<TunnelResult>('desktop_dev_tunnel_open', {
      baseUrl,
      port,
      clientToken: getRuntimeBearerTokenSync(),
      requestHeaders: getRuntimeExtraHeadersSync(),
    });
    if (!result || !Number.isInteger(result.localPort) || result.localPort <= 0) {
      throw new DevTunnelUnavailableError(url);
    }
    localPortByTarget.set(key, result.localPort);
    try {
      originByLocalPort.set(result.localPort, new URL(url).origin);
    } catch {
      // Unparseable input never reaches here; nothing to record.
    }
    return rewriteToLocalPort(url, result.localPort);
  } catch (error) {
    if (error instanceof DevTunnelUnavailableError) throw error;
    throw new DevTunnelUnavailableError(url);
  }
};

/**
 * True when a loopback URL belongs to the machine OpenChamber runs on rather
 * than to this one.
 *
 * A page served through a tunnel can send the browser to another local port —
 * a docs server behind a dev gateway, an API on its own port — and that
 * navigation happens inside the view, where nothing resolved it. Without this
 * the address would be looked for on the user's own machine, where it is either
 * nothing at all or, worse, a different application.
 *
 * A URL already pointing at a tunnel's local port is not retargeted; that one
 * is this machine, deliberately.
 */
export const shouldTunnelLoopbackUrl = (url: string): boolean => {
  if (!url || !isDesktopRuntime() || !isLoopbackUrl(url)) return false;
  if (!isRemoteOpenChamberOrigin(getRuntimeApiBaseUrl())) return false;
  const port = loopbackPort(url);
  return port > 0 && !originByLocalPort.has(port);
};

/**
 * Maps a URL the view actually loaded back to the address the user asked for.
 *
 * Without this the tunnel's random local port would show up in the address bar
 * and, worse, be persisted as the tab's target — a port that means nothing
 * after a restart.
 */
export const toDisplayUrl = (url: string): string => {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== '127.0.0.1') return url;
    const origin = originByLocalPort.get(Number.parseInt(parsed.port || '0', 10));
    if (!origin) return url;
    return `${origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
};

/**
 * Forgets cached tunnels. Cache entries are keyed by runtime base URL, so a
 * switch does not make them wrong — but the shell's listeners belong to the
 * previous endpoint, and holding their ports would keep resolving URLs to a
 * host the user has left.
 */
const resetDevTunnelCache = (): void => {
  localPortByTarget.clear();
  originByLocalPort.clear();
};

if (typeof window !== 'undefined') {
  subscribeRuntimeEndpointChanged(resetDevTunnelCache);
}
