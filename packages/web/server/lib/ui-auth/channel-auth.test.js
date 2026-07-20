import { describe, expect, it, vi } from 'vitest';

import { authorizeWebSocketUpgrade, createAuthChannelLifecycle } from './channel-auth.js';

describe('auth channel lifecycle', () => {
  it('closes only channels whose auth identity is authoritatively invalidated', () => {
    let invalidate;
    const lifecycle = createAuthChannelLifecycle({
      subscribeInvalidation(listener) {
        invalidate = listener;
        return () => {};
      },
      matchesSelector: (auth, selector) => auth.identity === selector.identity,
    });
    const firstClose = vi.fn();
    const secondClose = vi.fn();
    lifecycle.track({ identity: 'notify:client:first', expiresAt: null }, firstClose);
    lifecycle.track({ identity: 'notify:client:second', expiresAt: null }, secondClose);

    invalidate({ identity: 'notify:client:first' });

    expect(firstClose).toHaveBeenCalledTimes(1);
    expect(secondClose).not.toHaveBeenCalled();
    expect(lifecycle.size).toBe(1);
    lifecycle.dispose();
    expect(secondClose).toHaveBeenCalledTimes(1);
  });

  it('closes an established channel when its auth identity expires', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const lifecycle = createAuthChannelLifecycle();
      const close = vi.fn();
      lifecycle.track({ identity: 'notify:client:expiring', expiresAt: Date.now() + 100 }, close);

      await vi.advanceTimersByTimeAsync(100);

      expect(close).toHaveBeenCalledTimes(1);
      expect(lifecycle.size).toBe(0);
      lifecycle.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('websocket authorization', () => {
  it('rejects a relay-marked URL token that was not derived from client bearer auth', async () => {
    const isRequestOriginAllowed = vi.fn(async () => true);
    const result = await authorizeWebSocketUpgrade({
      req: {
        headers: { 'x-openchamber-relay-connection': 'relay-1' },
      },
      uiAuthController: {
        resolveUrlAuth: async () => ({ kind: 'ui-session', identity: 'notify:ui:local' }),
      },
      tunnelAuthController: {
        classifyRequestScope: () => 'local',
      },
      isRequestOriginAllowed,
    });

    expect(result).toEqual({
      ok: false,
      statusCode: 401,
      reason: 'Client URL authentication required',
    });
    expect(isRequestOriginAllowed).not.toHaveBeenCalled();
  });
});
