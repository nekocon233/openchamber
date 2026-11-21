import type { IncomingMessage } from 'node:http';
import type { Request } from '../shared/http-contracts.js';
import type { ClientInput } from '../client-auth/contracts.js';
import { sourceControlProviderDescriptors } from '../source-control/provider-descriptors.js';
import type { ClientAuthentication } from './ui-auth.js';

export const RESOLVED_CLIENT_AUTH = Symbol('openchamberResolvedClientAuth');

export type AuthRequest = Pick<IncomingMessage, 'headers' | 'method' | 'url'>
  & Partial<Pick<Request, 'query' | 'originalUrl' | 'baseUrl' | 'path' | 'secure'>>
  & { [RESOLVED_CLIENT_AUTH]?: ClientAuthentication };

export interface AuthInput extends ClientInput {
  password?: unknown;
  trustDevice?: unknown;
  issueClientToken?: unknown;
  clientLabel?: unknown;
  scope?: unknown;
}

export interface UrlAuthScope {
  kind: 'guest';
  id: string;
}

export const isString = (value: unknown): value is string => typeof value === 'string';

export const getUrlAuthTokenFromRequest = (req: AuthRequest) => {
  const queryToken = req?.query?.oc_url_token;
  let token = Array.isArray(queryToken) ? queryToken[0] : queryToken;
  if (!isString(token) && req?.url !== undefined) {
    try {
      token = new URL(req.url, 'http://localhost').searchParams.get('oc_url_token') || undefined;
    } catch {
      token = undefined;
    }
  }
  if (isString(token) && token.trim()) return token.trim();
  return null;
};

const getRequestPathname = (req: AuthRequest) => {
  const rawUrl = req?.originalUrl || req?.url;
  if (rawUrl) {
    try {
      return new URL(rawUrl, 'http://localhost').pathname;
    } catch {
      void 0;
    }
  }
  if (req?.baseUrl && req.path) {
    return `${req.baseUrl}${req.path}`.replace(/\/+/g, '/');
  }
  if (req?.path) return req.path;
  return '';
};

const isWebSocketUpgrade = (req: AuthRequest) => {
  const upgrade = req?.headers?.upgrade;
  const upgradeValue = Array.isArray(upgrade) ? upgrade[0] : upgrade;
  return String(upgradeValue || '').toLowerCase() === 'websocket';
};

const GUEST_URL_AUTH_SCOPE = /^guest:([a-z][a-z0-9-]*)$/;

export const parseUrlAuthScope = (value: AuthInput['scope']): UrlAuthScope | null | undefined => {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === null || raw === '') return null;
  if (!isString(raw)) return undefined;
  const match = raw.trim().match(GUEST_URL_AUTH_SCOPE);
  return match?.[1] !== undefined ? { kind: 'guest', id: match[1] } : undefined;
};

const isGuestScopedPath = (pathname: string, guestId: string) => pathname.startsWith(`/api/guests/${guestId}/`);

const SPACE_RAW_FILE_PATH = /^\/api\/spaces\/[0-9a-f]{12}\/fs\/raw$/;

const SPACE_WS_PATH = /^\/api\/spaces\/[0-9a-f]{12}\/(?:terminal\/ws|dev-tunnel|event\/ws|global\/event\/ws)$/;

const SOURCE_CONTROL_UPLOAD_PREFIXES = Object.freeze(sourceControlProviderDescriptors.list()
  .filter((descriptor) => descriptor.capabilities.uploads)
  .map((descriptor) => `/api/source-control/${descriptor.id}/uploads/`));

const isUrlAuthReadableHttpPath = (pathname: string) => {
  return pathname === '/api/event'
    || pathname === '/api/global/event'
    || pathname === '/api/openchamber/events'
    || pathname === '/api/openchamber/realtime-proxy/sse'
    || pathname === '/api/notifications/stream'
    || pathname === '/api/fs/raw'
    || SOURCE_CONTROL_UPLOAD_PREFIXES.some((prefix) => pathname.startsWith(prefix))
    || pathname.startsWith('/api/preview/proxy/')
    || /^\/api\/projects\/[^/]+\/icon$/.test(pathname)
    || pathname === '/api/guests'
    || /^\/api\/guests\/[a-z][a-z0-9-]*\//.test(pathname)
    || SPACE_RAW_FILE_PATH.test(pathname);
};

const isUrlAuthWebSocketPath = (pathname: string) => {
  return pathname === '/api/event/ws'
    || pathname === '/api/global/event/ws'
    || pathname === '/api/openchamber/realtime-proxy/ws'
    || pathname === '/api/terminal/ws'
    || pathname === '/api/dictation/ws'
    || pathname === '/api/dev-tunnel'
    || /^\/api\/guests\/[a-z][a-z0-9-]*\/surface\/ws$/.test(pathname)
    || /^\/api\/guests\/[a-z][a-z0-9-]*\/service\/ws$/.test(pathname)
    || pathname.startsWith('/api/preview/proxy/')
    || SPACE_WS_PATH.test(pathname);
};

export const canUseUrlAuthTokenForRequest = (req: AuthRequest, scope: UrlAuthScope | null = null) => {
  const method = req?.method !== undefined ? req.method.toUpperCase() : 'GET';
  const pathname = getRequestPathname(req);
  if (scope?.kind === 'guest') {
    return !isWebSocketUpgrade(req) && method === 'GET' && isGuestScopedPath(pathname, scope.id);
  }
  if (isWebSocketUpgrade(req)) {
    return isUrlAuthWebSocketPath(pathname);
  }
  return method === 'GET' && isUrlAuthReadableHttpPath(pathname);
};
