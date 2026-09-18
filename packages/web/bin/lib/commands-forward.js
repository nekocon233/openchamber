/**
 * `openchamber forward` — pull a dev server from a remote OpenChamber to this machine.
 *
 * Binds a loopback port here and pipes it to the host's `127.0.0.1:<port>` over
 * the existing `/api/dev-tunnel` socket. The page then loads from a real origin
 * at the root of its own host, so absolute URLs, cookies, and HMR all behave
 * exactly as they do locally, with nothing rewritten.
 *
 * This is the fallback for deployments that cannot give each forwarded port its
 * own hostname — a Cloudflare quick tunnel, the private relay, anywhere a
 * wildcard certificate is out of reach. It needs no server changes: the host
 * end, its authentication, and its port allowlist already exist.
 *
 * The remote is checked over plain HTTP before any socket opens. A refused
 * WebSocket upgrade surfaces to the browser as a blank page with no
 * explanation, so the reasons it would be refused — bad token, port not
 * running, discovery unavailable — are turned into messages here instead.
 */
import { createDevTunnelClient } from '../../server/lib/dev-tunnel/client.js';
import { EXIT_CODE, TunnelCliError } from './cli-errors.js';
import { resolveToken } from './cli-tunnel-profiles.js';
import {
  createSpinner,
  intro,
  isJsonMode,
  isQuietMode,
  log,
  logStatus,
  outro,
  printJson,
  shouldRenderHumanOutput,
} from '../cli-output.js';

const PROBE_TIMEOUT_MS = 10_000;

const parsePort = (raw) => {
  if (raw === true || raw === false) return null;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
};

/**
 * The origin to talk to. A bare `host:port` is accepted and assumed plain HTTP,
 * which is what a LAN or Tailscale address almost always is.
 */
const normalizeBaseUrl = (value) => {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw.includes('://') ? raw : `http://${raw}`);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
};

/**
 * Confirms the remote is reachable, the token is accepted, and the port is one
 * the host will actually dial — all before a socket exists to fail silently.
 */
const probeRemote = async ({ baseUrl, token, port }) => {
  let response;
  try {
    response = await fetch(new URL('/api/dev-servers', baseUrl), {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    throw new TunnelCliError(
      `Could not reach OpenChamber at ${baseUrl}: ${error?.message || error}`,
      EXIT_CODE.NETWORK_RUNTIME_ERROR,
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new TunnelCliError(
      `OpenChamber at ${baseUrl} refused this client token. Create one on the host with: openchamber connect-url`,
      EXIT_CODE.AUTH_CONFIG_ERROR,
    );
  }
  if (response.status === 503) {
    throw new TunnelCliError(
      'OpenChamber cannot list the dev servers running on it, so it will not tunnel to one.',
      EXIT_CODE.NETWORK_RUNTIME_ERROR,
    );
  }
  if (!response.ok) {
    throw new TunnelCliError(
      `OpenChamber at ${baseUrl} answered ${response.status}.`,
      EXIT_CODE.NETWORK_RUNTIME_ERROR,
    );
  }

  const body = await response.json().catch(() => null);
  const servers = Array.isArray(body?.servers) ? body.servers : null;
  if (!servers) {
    throw new TunnelCliError(
      `OpenChamber at ${baseUrl} returned an unexpected dev-server list.`,
      EXIT_CODE.NETWORK_RUNTIME_ERROR,
    );
  }

  const ports = servers.map((entry) => entry?.port).filter((value) => Number.isInteger(value));
  if (!ports.includes(port)) {
    // Naming the alternatives is the difference between a dead end and a fix:
    // the usual cause is a dev server that has not started yet.
    const available = ports.length > 0
      ? ` Currently running there: ${ports.join(', ')}.`
      : ' No dev servers are running there.';
    throw new TunnelCliError(
      `Port ${port} is not a dev server OpenChamber can reach.${available}`,
      EXIT_CODE.GENERAL_ERROR,
    );
  }

  return ports;
};

export function createForwardCommand({ setForegroundActive, setForegroundShutdown }) {
  return async function forwardCommand(options, rawPort) {
    const showOutput = shouldRenderHumanOutput(options);

    const port = parsePort(rawPort);
    if (port === null) {
      throw new TunnelCliError(
        'A port is required. Usage: openchamber forward <port> --url <openchamber-url>',
        EXIT_CODE.USAGE_ERROR,
      );
    }

    const baseUrl = normalizeBaseUrl(options.url ?? process.env.OPENCHAMBER_URL);
    if (!baseUrl) {
      throw new TunnelCliError(
        'A remote OpenChamber URL is required. Provide --url <http(s)://host:port> or set OPENCHAMBER_URL.',
        EXIT_CODE.USAGE_ERROR,
      );
    }

    let token;
    try {
      token = resolveToken(options) || process.env.OPENCHAMBER_CLIENT_TOKEN;
    } catch (error) {
      throw new TunnelCliError(error?.message || String(error), EXIT_CODE.USAGE_ERROR);
    }

    if (showOutput) intro('Forward a remote dev server');

    const probeSpinner = createSpinner(options);
    probeSpinner?.start(`Checking ${baseUrl}`);
    try {
      await probeRemote({ baseUrl, token, port });
    } catch (error) {
      probeSpinner?.stop('Unreachable', 1);
      throw error;
    }
    probeSpinner?.stop(`Port ${port} is running on ${baseUrl}`);

    const client = createDevTunnelClient({
      logger: showOutput ? console : { warn: () => {} },
    });

    let localPort;
    try {
      const opened = await client.open({
        baseUrl,
        port,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      localPort = opened.localPort;
    } catch (error) {
      throw new TunnelCliError(
        `Could not bind a local port: ${error?.message || error}`,
        EXIT_CODE.NETWORK_RUNTIME_ERROR,
      );
    }

    const localUrl = `http://127.0.0.1:${localPort}`;

    const shutdown = (signal) => {
      client.closeAll();
      setForegroundActive(false);
      setForegroundShutdown(null);
      if (showOutput) outro(`Stopped forwarding port ${port}.`);
      process.exit(signal === 'SIGINT' ? 130 : signal === 'SIGQUIT' ? 131 : 143);
    };

    // Routed through the shared foreground hook so the global SIGINT handler
    // closes the tunnel instead of printing "Operation cancelled".
    setForegroundShutdown(shutdown);
    setForegroundActive(true);
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGQUIT', () => shutdown('SIGQUIT'));

    if (isJsonMode(options)) {
      // Emitted before blocking so a script can read the port and then manage
      // this process; the tunnel only exists while the process does.
      printJson({
        status: 'ok',
        localPort,
        localUrl,
        remotePort: port,
        baseUrl,
        messages: [{ level: 'info', code: 'FORWARD_ACTIVE', message: 'The forward stays open until this process exits.' }],
      });
    } else if (isQuietMode(options)) {
      process.stdout.write(`${localUrl}\n`);
    } else {
      log.success(`${localUrl} → ${baseUrl} port ${port}`);
      logStatus('info', '[FORWARD_STOP]', 'Press Ctrl-C to stop forwarding.');
    }

    // The tunnel is the process. Nothing resolves this; the signal handlers exit.
    await new Promise(() => {});
  };
}
