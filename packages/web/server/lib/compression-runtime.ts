import type { IncomingHttpHeaders, OutgoingHttpHeader } from 'node:http';

import { isString } from './shared/guards.js';

export interface CompressionRequestLike {
  headers?: IncomingHttpHeaders | undefined;
  path?: string | undefined;
  url?: string | undefined;
}

export interface CompressionResponseLike {
  getHeader?: ((name: string) => OutgoingHttpHeader | undefined) | undefined;
}

export interface CompressionOptions {
  runtime?: string | undefined;
  shouldSkipApiCompression?: (() => boolean) | undefined;
}

const SSE_PATHS = new Set([
  '/api/event',
  '/api/global/event',
  '/api/notifications/stream',
  '/api/openchamber/events',
  '/api/openchamber/realtime-proxy/sse',
]);

const headerIncludesEventStream = (value: OutgoingHttpHeader | string | string[] | undefined): boolean => {
  if (isString(value)) {
    return value.toLowerCase().includes('text/event-stream');
  }

  if (Array.isArray(value)) {
    return value.some((entry) => isString(entry) && entry.toLowerCase().includes('text/event-stream'));
  }

  return false;
};

export const shouldSkipResponseCompression = (
  req: CompressionRequestLike | null | undefined,
  res: CompressionResponseLike | null | undefined,
  options: CompressionOptions = {},
): boolean => {
  const {
    runtime = '',
    shouldSkipApiCompression = () => false,
  } = options;

  if (runtime === 'desktop') {
    return true;
  }

  if (headerIncludesEventStream(req?.headers?.accept)) {
    return true;
  }

  const pathname = req?.path || req?.url || '';
  if ((pathname === '/api' || pathname.startsWith('/api/')) && shouldSkipApiCompression()) {
    return true;
  }

  if (SSE_PATHS.has(pathname)) {
    return true;
  }

  return headerIncludesEventStream(res?.getHeader?.('Content-Type'));
};
