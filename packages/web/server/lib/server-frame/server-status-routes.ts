import { createTunnelSessionNotificationAuth, type NotificationAuth } from '../notifications/auth-runtime.js';
import { collectLocalFileDiagnostics } from '../diagnostics/local-files.js';
import { isString } from '../shared/object-guards.js';
import type { AddressInfo, Server } from 'node:net';
import type { Application, NextFunction, Request, RequestHandler, Response } from '../shared/http-contracts.js';
import type { createUiAuth } from '../ui-auth/ui-auth.js';
import type { createTunnelAuth } from '../tunnels/tunnel-auth.js';
import type { ClientInput, PairingInput, RedemptionInput } from '../client-auth/contracts.js';
import type { RequestAuthorizationDependencies, ServerStatusDependencies } from './core-routes.js';

export type UiAuthController = ReturnType<typeof createUiAuth>;

export type TunnelAuthController = ReturnType<typeof createTunnelAuth>;

export interface RouteInput extends ClientInput, PairingInput, RedemptionInput {
  previewUrls?: unknown;
  pairingId?: unknown;
  serverUrl?: unknown;
  includeRelay?: unknown;
  includeDirect?: unknown;
  url?: unknown;
  theme?: unknown;
}

export interface ServerIdentity {
  serverId?: string;
}

interface ServerInfo {
  openchamberVersion: string;
  runtime: string;
  pid: number;
  startedAt: string;
  port?: number | null;
  tunnelUrl?: string | null;
}

const hasRouteInput = (value: unknown): value is RouteInput => value != null;

export const readBody = (req: Request) => hasRouteInput(req.body) ? req.body : undefined;

export const hasErrorDetails = (value: unknown): value is { message?: unknown; statusCode?: unknown } => value != null;

export const isNumber = (value: unknown): value is number => typeof value === 'number';

const isAddressInfo = (value: ReturnType<Server['address']>): value is AddressInfo => Boolean(value) && typeof value === 'object';

export type AuthenticatedRequest = Request & {
  openchamberExternalAuthenticated?: boolean;
  openchamberRelayClientAuthenticated?: boolean;
  openchamberTunnelAuthenticated?: boolean;
  openchamberTunnelSession?: ReturnType<TunnelAuthController['getTunnelSessionFromRequest']>;
  openchamberAuthIdentity?: NotificationAuth | null;
};

const getRequestPathname = (req: Request): string => {
  const rawUrl = req?.originalUrl || req?.url || '';
  if (!isString(rawUrl) || rawUrl.length === 0) return '';
  try {
    return new URL(rawUrl, 'http://localhost').pathname;
  } catch {
    return '';
  }
};

export const isPrivateRelayRequest = (req: Request): boolean => {
  const value = req?.headers?.['x-openchamber-relay-connection'];
  if (Array.isArray(value)) return value.some((entry) => isString(entry) && entry.length > 0);
  return isString(value) && value.length > 0;
};

export const isExternalScope = (scope: string | undefined): boolean => scope === 'tunnel' || scope === 'unknown-public';

export const isFileGrantRead = (req: Request): boolean => req.method === 'GET'
  && /^\/api\/(?:fs\/preview|guest-files)\/[^/]+\/./.test(getRequestPathname(req));

const isMcpOauthCallbackPath = (req: Request): boolean => req.method === 'GET'
  && /^\/api\/mcp\/oauth\/[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?\/callback$/.test(getRequestPathname(req));

const requiresExternalAuth = (req: Request): boolean => {
  if (isFileGrantRead(req) || isMcpOauthCallbackPath(req)) return false;
  const pathname = getRequestPathname(req).toLowerCase();
  if (req.method === 'POST' && pathname === '/api/client-auth/pairing/redeem') return false;
  if (pathname === '/api/version') return false;
  if (pathname === '/api' || pathname.startsWith('/api/')) return true;
  return pathname.startsWith('/auth/follow-up-queue/')
    || pathname === '/auth/url-token'
    || (req.method === 'GET' && pathname === '/auth/session');
};

const sendClientAuthRequired = (res: Response) => (
  res.setHeader('Cache-Control', 'no-store'),
  res.status(401).json({ error: 'Client authentication required', locked: true, clientAuthRequired: true })
);

export const runUiAuthGate = async ({
  req,
  res,
  uiAuthController,
  gate,
  clientOnly = false,
  requireIdentity = false,
}: {
  req: AuthenticatedRequest;
  res: Response;
  uiAuthController: UiAuthController | null | undefined;
  gate: RequestHandler | undefined;
  clientOnly?: boolean;
  requireIdentity?: boolean;
}): Promise<boolean> => {
  if (!gate) return false;
  let allowed = false;
  await gate(req, res, () => {
    allowed = true;
  });
  if (!allowed || req.method === 'OPTIONS') return allowed;

  if (uiAuthController?.resolveChannelAuth) {
    const auth = await uiAuthController.resolveChannelAuth(req, res, {
      allowUrlToken: !clientOnly,
      allowSessionCreation: false,
      clientOnly,
    });
    if (!auth && requireIdentity) {
      sendClientAuthRequired(res);
      return false;
    }
    if (auth) req.openchamberAuthIdentity = auth;
  }
  return true;
};

export const enforceExternalRequestAuth = async ({
  req,
  res,
  next,
  tunnelAuthController,
  uiAuthController,
}: {
  req: AuthenticatedRequest;
  res: Response;
  next: NextFunction;
  tunnelAuthController: TunnelAuthController | null | undefined;
  uiAuthController: UiAuthController | null | undefined;
}) => {
  const path = getRequestPathname(req).toLowerCase();
  const managesPasskeys = (req.method === 'GET' && path === '/api/passkeys')
    || ((req.method === 'PATCH' || req.method === 'DELETE') && /^\/api\/passkeys\/[^/]+$/.test(path));
  if (managesPasskeys && (isPrivateRelayRequest(req) || isExternalScope(tunnelAuthController?.classifyRequestScope?.(req)))) {
    return res.status(403).json({ error: 'Passkey management is disabled for tunnel scope', tunnelLocked: true });
  }
  if (req.openchamberExternalAuthenticated === true) return next();

  if (isPrivateRelayRequest(req)) {
    if (req.method === 'POST' && getRequestPathname(req) === '/api/client-auth/pairing/redeem') {
      return next();
    }
    const allowed = await runUiAuthGate({
      req,
      res,
      uiAuthController,
      gate: uiAuthController?.requireClientAuth,
      clientOnly: true,
      requireIdentity: true,
    });
    if (!allowed) {
      if (!res.headersSent && !uiAuthController?.requireClientAuth) {
        sendClientAuthRequired(res);
      }
      return;
    }
    req.openchamberRelayClientAuthenticated = true;
    req.openchamberExternalAuthenticated = true;
    return next();
  }

  if (!requiresExternalAuth(req)) return next();
  const requestScope = tunnelAuthController?.classifyRequestScope
    ? tunnelAuthController.classifyRequestScope(req)
    : 'local';
  if (!isExternalScope(requestScope)) return next();

  const tunnelSession = tunnelAuthController?.getTunnelSessionFromRequest
    ? tunnelAuthController.getTunnelSessionFromRequest(req)
    : null;
  if (tunnelSession?.sessionId) {
    req.openchamberTunnelAuthenticated = true;
    req.openchamberTunnelSession = tunnelSession;
    req.openchamberAuthIdentity = createTunnelSessionNotificationAuth(
      tunnelSession.sessionId,
      tunnelSession.expiresAt,
    );
    req.openchamberExternalAuthenticated = true;
    return next();
  }

  if (uiAuthController?.enabled === true && getRequestPathname(req) === '/auth/session') {
    return next();
  }
  const clientOnly = uiAuthController?.enabled !== true;
  const gate = clientOnly ? uiAuthController?.requireClientAuth : uiAuthController?.requireAuth;
  const allowed = await runUiAuthGate({
    req,
    res,
    uiAuthController,
    gate,
    clientOnly,
    requireIdentity: true,
  });
  if (!allowed) {
    if (!res.headersSent && !gate) {
      sendClientAuthRequired(res);
    }
    return;
  }
  req.openchamberExternalAuthenticated = true;
  return next();
};

export const isRequestAuthorized = async (req: Request, res: Response, { tunnelAuthController, uiAuthController }: RequestAuthorizationDependencies) => {
  const scope = tunnelAuthController?.classifyRequestScope?.(req);
  if (scope === 'tunnel' || scope === 'unknown-public') {
    return Boolean(tunnelAuthController?.getTunnelSessionFromRequest(req));
  }
  if (!uiAuthController) return false;
  return Boolean(await uiAuthController.resolveAuthContext(req, res, { allowUrlToken: false }));
};

export const registerServerStatusRoutes = (app: Application, dependencies: ServerStatusDependencies) => {
  const {
    express,
    process,
    openchamberVersion,
    runtimeName,
    serverStartedAt,
    gracefulShutdown,
    getHealthSnapshot,
    getServerPort = () => null,
    getTunnelUrl = () => null,
    getServerId = async () => null,
    tunnelAuthController = null,
    uiAuthController = null,
    readOpenCodeLoad = null,
  } = dependencies;

  let cachedServerId: string | null = null;
  const resolveServerId = async () => {
    if (cachedServerId) return cachedServerId;
    try {
      const value = await getServerId();
      cachedServerId = value && value.trim() ? value.trim() : null;
    } catch {
      cachedServerId = null;
    }
    return cachedServerId;
  };

  const allocateLoopbackPort = async () => {
    const net = await import('node:net');
    return await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        try {
          const address = server.address();
          const port = isAddressInfo(address) ? address.port : 0;
          server.close(() => {
            resolve(port);
          });
        } catch (error) {
          try {
            server.close();
          } catch {
            void 0;
          }
          reject(error);
        }
      });
    });
  };

  const compatibility = {
    apiVersion: 1,
    minClientApiVersion: 1,
    capabilities: [
      'api.health.v1',
      'api.runtime-url.v1',
      'api.raw-file.v1',
      'api.notifications.emit.v1',
      'realtime.sse.v1',
      'realtime.websocket.global-events.v1',
      'terminal.websocket.v1',
      'api.message-part-shells.v1',
    ],
  };

  const isDevShutdownAllowed = () => {
    return process.env.OPENCHAMBER_DEV_SHUTDOWN === 'true';
  };

  const isSameOriginRequest = (req: Request) => {
    const rawOrigin = req.get('origin');
    const rawHost = req.get('host');
    if (!rawOrigin || !rawHost) {
      return false;
    }
    try {
      const origin = new URL(String(rawOrigin));
      return origin.host === rawHost;
    } catch {
      return false;
    }
  };

  const resolveProcessGroupId = async (pid: number | null) => {
    if (!pid || !Number.isFinite(pid) || pid <= 0) {
      return null;
    }
    if (process.platform === 'win32') {
      return null;
    }

    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      const result = await execFileAsync('ps', ['-o', 'pgid=', '-p', String(pid)]);
      const raw = String(result.stdout || '').trim();
      const pgid = Number.parseInt(raw, 10);
      return Number.isFinite(pgid) && pgid > 0 ? pgid : null;
    } catch {
      return null;
    }
  };

  const parseLoopbackPort = (rawUrl: RouteInput['previewUrls']) => {
    if (!isString(rawUrl)) {
      return null;
    }
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    const host = url.hostname;
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1' && host !== '0.0.0.0') {
      return null;
    }
    const port = url.port ? Number.parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 80);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      return null;
    }
    return port;
  };

  const killListenPort = async (port: number) => {
    if (!Number.isFinite(port) || port <= 0) {
      return;
    }
    if (process.platform === 'win32') {
      return;
    }

    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      const result = await execFileAsync('lsof', ['-nP', '-t', `-iTCP:${Math.trunc(port)}`, '-sTCP:LISTEN'], {
        timeout: 2500,
      });
      const pids = String(result.stdout || '')
        .split(/\s+/)
        .map((value) => Number.parseInt(value, 10))
        .filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== process.pid);

      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          void 0;
        }
      }
      if (pids.length > 0) {
        setTimeout(() => {
          for (const pid of pids) {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {
              void 0;
            }
          }
        }, 1200).unref?.();
      }
    } catch {
      void 0;
    }
  };

  app.get('/health', async (_req, res) => {
    const serverId = await resolveServerId();
    const identity: ServerIdentity = {};
    if (serverId) identity.serverId = serverId;
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      openchamberVersion,
      runtime: runtimeName,
      compatibility,
      ...identity,
      ...getHealthSnapshot(),
    });
  });

  const requireLocalDiagnostics: RequestHandler = (req, res, next) => {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress ?? '')
      || req.headers['x-openchamber-relay-connection']
      || (tunnelAuthController?.classifyRequestScope && tunnelAuthController.classifyRequestScope(req) !== 'local')) {
      res.status(403).json({ error: 'Local diagnostics require a loopback connection' });
      return;
    }
    if (uiAuthController?.requireAuth) return uiAuthController.requireAuth(req, res, next);
    next();
  };

  app.get('/api/diagnostics/local-files', requireLocalDiagnostics, async (_req, res) => {
    try {
      const webPort = getServerPort();
      res.json(await collectLocalFileDiagnostics(webPort === null ? {} : { webPort }));
    } catch {
      res.status(500).json({ error: 'Diagnostics unavailable' });
    }
  });

  app.get('/api/diagnostics/opencode-load', requireLocalDiagnostics, async (_req, res) => {
    if (!readOpenCodeLoad) {
      res.status(404).json({ error: 'Diagnostics unavailable' });
      return;
    }
    try {
      res.json(await readOpenCodeLoad());
    } catch {
      res.status(500).json({ error: 'Diagnostics unavailable' });
    }
  });

  app.use(async (req, res, next) => {
    try {
      const pathname = getRequestPathname(req).toLowerCase();
      if (
        pathname.startsWith('/auth/follow-up-queue/')
        || pathname.startsWith('/api/follow-up-queue/')
      ) {
        res.setHeader('Cache-Control', 'no-store');
      }
      await enforceExternalRequestAuth({ req, res, next, tunnelAuthController, uiAuthController });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/version', async (_req, res) => {
    const serverId = await resolveServerId();
    const identity: ServerIdentity = {};
    if (serverId) identity.serverId = serverId;
    res.json({
      status: 'ok',
      openchamberVersion,
      runtime: runtimeName,
      startedAt: serverStartedAt,
      compatibility,
      ...identity,
    });
  });

  const requireShutdownAuth: RequestHandler = async (req: AuthenticatedRequest, res, next) => {
    if (req.openchamberExternalAuthenticated === true) return next();
    if (!uiAuthController?.requireAuth) {
      return next();
    }
    if (isPrivateRelayRequest(req)) {
      if (!uiAuthController.requireClientAuth) {
        return res.status(401).json({ error: 'Client authentication required', locked: true, clientAuthRequired: true });
      }
      return uiAuthController.requireClientAuth(req, res, next);
    }
    const requestScope = tunnelAuthController?.classifyRequestScope
      ? tunnelAuthController.classifyRequestScope(req)
      : 'local';
    if (isExternalScope(requestScope)) {
      const tunnelSession = tunnelAuthController?.getTunnelSessionFromRequest
        ? tunnelAuthController.getTunnelSessionFromRequest(req)
        : null;
      if (tunnelSession) return next();
      if (uiAuthController.enabled !== true && uiAuthController.requireClientAuth) {
        return uiAuthController.requireClientAuth(req, res, next);
      }
    }
    return uiAuthController.requireAuth(req, res, next);
  };

  app.post('/api/system/shutdown', async (req, res, next) => {
    try {
      await requireShutdownAuth(req, res, () => {
        res.json({ ok: true });
        gracefulShutdown({ exitProcess: true }).catch((error) => {
          console.error('Shutdown request failed:', error?.message || error);
        });
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/system/dev-shutdown', express.json({ limit: '64kb' }), async (req, res) => {
    if (!isDevShutdownAllowed()) {
      return res.status(403).json({ ok: false, error: 'Dev shutdown is disabled' });
    }
    if (!isSameOriginRequest(req)) {
      return res.status(403).json({ ok: false, error: 'Invalid origin' });
    }

    res.json({ ok: true });

    try {
      const previewUrls = readBody(req)?.previewUrls;
      const rawPreviewUrls = Array.isArray(previewUrls) ? previewUrls : [];
      const previewPorts = Array.from(new Set(
        rawPreviewUrls
          .map((value: RouteInput['previewUrls']) => parseLoopbackPort(value))
          .filter(isNumber)
      ));
      await Promise.all(previewPorts.map((port) => killListenPort(port)));

      const pgid = await resolveProcessGroupId(process.pid);
      const ppid = process.ppid;
      const parentPgid = ppid ? await resolveProcessGroupId(ppid) : null;

      void gracefulShutdown({ exitProcess: false });

      const pgidsToKill = Array.from(new Set([pgid, parentPgid].filter((id): id is number => Boolean(id))));
      for (const id of pgidsToKill) {
        try {
          process.kill(-id, 'SIGTERM');
        } catch {
          void 0;
        }
      }

      setTimeout(() => {
        for (const id of pgidsToKill) {
          try {
            process.kill(-id, 'SIGKILL');
          } catch {
            void 0;
          }
        }
      }, 1500).unref?.();

      setTimeout(() => {
        try {
          process.exit(0);
        } catch {
          void 0;
        }
      }, 2500).unref?.();
    } catch (error) {
      console.error('Dev shutdown request failed:', (hasErrorDetails(error) && error.message) || error);
      try {
        process.exit(0);
      } catch {
        void 0;
      }
    }
  });

  app.get('/api/system/info', async (req, res) => {
    const info: ServerInfo = {
      openchamberVersion,
      runtime: runtimeName,
      pid: process.pid,
      startedAt: serverStartedAt,
    };
    if (await isRequestAuthorized(req, res, { tunnelAuthController, uiAuthController }).catch(() => false)) {
      info.port = getServerPort();
      info.tunnelUrl = getTunnelUrl();
    }
    res.json(info);
  });

  app.get('/api/system/free-port', async (_req, res) => {
    try {
      const port = await allocateLoopbackPort();
      if (!Number.isFinite(port) || port <= 0) {
        return res.status(500).json({ error: 'Failed to allocate port' });
      }
      return res.json({ port });
    } catch (error) {
      return res.status(500).json({ error: (hasErrorDetails(error) && error.message) || 'Failed to allocate port' });
    }
  });

};
