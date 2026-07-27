import { describe, expect, it, vi } from 'vitest';

import { shouldSkipResponseCompression } from './compression-runtime.js';

const SSE_PATHS = [
  '/api/event',
  '/api/global/event',
  '/api/notifications/stream',
  '/api/openchamber/events',
  '/api/openchamber/realtime-proxy/sse',
];

const createResponse = (contentType) => ({
  getHeader: vi.fn(() => contentType),
});

describe('response compression', () => {
  it.each(SSE_PATHS)('skips compression for SSE path %s without requiring an Accept header', (path) => {
    expect(shouldSkipResponseCompression(
      { path, headers: {} },
      createResponse(undefined),
    )).toBe(true);
  });

  it('skips compression when the request or response identifies an event stream', () => {
    expect(shouldSkipResponseCompression(
      { path: '/custom', headers: { accept: 'text/event-stream' } },
      createResponse(undefined),
    )).toBe(true);
    expect(shouldSkipResponseCompression(
      { path: '/custom', headers: {} },
      createResponse('text/event-stream; charset=utf-8'),
    )).toBe(true);
  });

  it('preserves runtime-wide and API compression overrides', () => {
    const skipApiCompression = vi.fn(() => true);

    expect(shouldSkipResponseCompression(
      { path: '/assets/app.js', headers: {} },
      createResponse(undefined),
      { runtime: 'desktop', shouldSkipApiCompression: skipApiCompression },
    )).toBe(true);
    expect(skipApiCompression).not.toHaveBeenCalled();

    expect(shouldSkipResponseCompression(
      { path: '/api/config', headers: {} },
      createResponse(undefined),
      { shouldSkipApiCompression: skipApiCompression },
    )).toBe(true);
    expect(skipApiCompression).toHaveBeenCalledOnce();
  });

  it('allows ordinary web responses to use the compression middleware', () => {
    expect(shouldSkipResponseCompression(
      { path: '/assets/app.js', headers: {} },
      createResponse('application/javascript'),
    )).toBe(false);
  });
});
