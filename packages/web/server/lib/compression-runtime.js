const SSE_PATHS = new Set([
  '/api/event',
  '/api/global/event',
  '/api/notifications/stream',
  '/api/openchamber/events',
  '/api/openchamber/realtime-proxy/sse',
]);

const headerIncludesEventStream = (value) => {
  if (typeof value === 'string') {
    return value.toLowerCase().includes('text/event-stream');
  }

  if (Array.isArray(value)) {
    return value.some((entry) => typeof entry === 'string' && entry.toLowerCase().includes('text/event-stream'));
  }

  return false;
};

export const shouldSkipResponseCompression = (req, res, options = {}) => {
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
