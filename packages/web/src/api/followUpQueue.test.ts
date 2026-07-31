import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runtimeFetch } = vi.hoisted(() => ({ runtimeFetch: vi.fn() }));

vi.mock('@openchamber/ui/lib/runtime-fetch', () => ({ runtimeFetch }));

import { FollowUpQueueConflictError } from '@openchamber/ui/lib/followUpQueue';
import { createWebFollowUpQueueAPI } from './followUpQueue';

const scopeToken = 'a'.repeat(64);
const capabilitiesResponse = () => new Response(JSON.stringify({
  authority: 'openchamber-host',
  version: 2,
}), { status: 200, headers: { 'Content-Type': 'application/json' } });
const item = {
  id: 'queue-one',
  messageId: 'msg_0198b4f3c001AbCdEfGhIjKlMn',
  content: 'follow up',
  createdAt: 10,
  status: 'staged' as const,
};

describe('web follow-up queue API', () => {
  beforeEach(() => {
    runtimeFetch.mockReset();
  });

  it('loads an authoritative session queue through auth-only routes', async () => {
    runtimeFetch.mockResolvedValueOnce(capabilitiesResponse()).mockResolvedValueOnce(new Response(JSON.stringify({
      scopeToken,
      revision: 1,
      items: [item],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const result = await createWebFollowUpQueueAPI().load('session-one', { expectedRuntimeKey: 'runtime-a' });

    expect(result?.items[0]?.messageId).toBe(item.messageId);
    expect(runtimeFetch).toHaveBeenNthCalledWith(1, '/auth/follow-up-queue/capabilities', expect.objectContaining({
      method: 'GET',
      cache: 'no-store',
      expectedRuntimeKey: 'runtime-a',
    }));
    expect(runtimeFetch).toHaveBeenNthCalledWith(2, '/auth/follow-up-queue/load', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ sessionId: 'session-one' }),
      expectedRuntimeKey: 'runtime-a',
    }));
  });

  it('mutates with request fidelity and validates the result', async () => {
    runtimeFetch.mockResolvedValueOnce(capabilitiesResponse()).mockResolvedValueOnce(new Response(JSON.stringify({
      snapshot: { scopeToken, revision: 1, items: [item] },
      applied: true,
      deduplicated: false,
      mutationRevision: 1,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const request = {
      sessionId: 'session-one',
      baseRevision: 0,
      clientMutationId: 'mutation-one',
      operation: { type: 'add' as const, item },
    };

    const result = await createWebFollowUpQueueAPI().mutate(request);

    expect(result?.mutationRevision).toBe(1);
    expect(runtimeFetch).toHaveBeenNthCalledWith(2, '/auth/follow-up-queue/mutations', expect.objectContaining({
      body: JSON.stringify(request),
      cache: 'no-store',
    }));
  });

  it('converts a revision conflict snapshot into the typed conflict error', async () => {
    runtimeFetch.mockResolvedValueOnce(capabilitiesResponse()).mockResolvedValueOnce(new Response(JSON.stringify({
      error: 'Follow-up queue revision conflict',
      code: 'FOLLOW_UP_QUEUE_CONFLICT',
      latestSnapshot: { scopeToken, revision: 2, items: [item] },
    }), { status: 409, headers: { 'Content-Type': 'application/json' } }));

    const promise = createWebFollowUpQueueAPI().mutate({
      sessionId: 'session-one',
      baseRevision: 0,
      clientMutationId: 'mutation-conflict',
      operation: { type: 'remove', itemId: item.id },
    });

    await expect(promise).rejects.toBeInstanceOf(FollowUpQueueConflictError);
    await expect(promise).rejects.toMatchObject({ latestSnapshot: { revision: 2 } });
  });

  it('preserves authoritative load failures instead of returning an empty queue', async () => {
    runtimeFetch.mockResolvedValueOnce(capabilitiesResponse()).mockResolvedValueOnce(new Response(JSON.stringify({
      error: 'Failed to load authoritative follow-up queue',
      code: 'FOLLOW_UP_QUEUE_READ_FAILED',
    }), { status: 500, headers: { 'Content-Type': 'application/json' } }));

    await expect(createWebFollowUpQueueAPI().load('session-one')).rejects.toMatchObject({
      code: 'FOLLOW_UP_QUEUE_READ_FAILED',
      permanent: false,
    });
  });

  it('does not send queue content when an older host lacks the capability route', async () => {
    runtimeFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    }));
    const request = {
      sessionId: 'session-one',
      baseRevision: 0,
      clientMutationId: 'mutation-private',
      operation: { type: 'add' as const, item: { ...item, content: 'private follow up' } },
    };

    await expect(createWebFollowUpQueueAPI().mutate(request)).rejects.toMatchObject({
      code: 'FOLLOW_UP_QUEUE_UNSUPPORTED',
      permanent: true,
    });
    expect(runtimeFetch).toHaveBeenCalledTimes(1);
    expect(runtimeFetch.mock.calls[0]?.[0]).toBe('/auth/follow-up-queue/capabilities');
    expect(JSON.stringify(runtimeFetch.mock.calls[0])).not.toContain('private follow up');
  });

  it('does not send queue content to an older capability version', async () => {
    runtimeFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      authority: 'openchamber-host',
      version: 1,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const request = {
      sessionId: 'session-one',
      baseRevision: 0,
      clientMutationId: 'mutation-version-one',
      operation: { type: 'add' as const, item: { ...item, content: 'version-private' } },
    };

    await expect(createWebFollowUpQueueAPI().mutate(request)).rejects.toMatchObject({
      code: 'FOLLOW_UP_QUEUE_UNSUPPORTED',
    });
    expect(runtimeFetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(runtimeFetch.mock.calls[0])).not.toContain('version-private');
  });

  it('rejects malformed successful snapshots and truncated responses', async () => {
    const api = createWebFollowUpQueueAPI();
    runtimeFetch.mockResolvedValueOnce(capabilitiesResponse()).mockResolvedValueOnce(new Response(JSON.stringify({
      scopeToken,
      revision: 0,
      items: [],
      unexpected: true,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await expect(api.load('session-one')).rejects.toMatchObject({
      code: 'FOLLOW_UP_QUEUE_INVALID_RESPONSE',
      permanent: true,
    });

    runtimeFetch.mockResolvedValueOnce(capabilitiesResponse()).mockResolvedValueOnce(new Response('{', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    await expect(api.load('session-one')).rejects.toMatchObject({
      code: 'FOLLOW_UP_QUEUE_RESPONSE_READ_FAILED',
      permanent: false,
    });

    runtimeFetch.mockResolvedValueOnce(capabilitiesResponse()).mockResolvedValueOnce(new Response(JSON.stringify({
      unexpected: true,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await expect(api.mutate({
      sessionId: 'session-one',
      baseRevision: 0,
      clientMutationId: 'mutation-invalid-success',
      operation: { type: 'add', item },
    })).rejects.toMatchObject({
      code: 'FOLLOW_UP_QUEUE_INVALID_RESPONSE',
      permanent: false,
    });
  });

  it('shares only the in-flight capability probe for one runtime', async () => {
    runtimeFetch
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({ scopeToken, revision: 0, items: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ scopeToken: 'b'.repeat(64), revision: 0, items: [] }), { status: 200 }));
    const api = createWebFollowUpQueueAPI();

    await Promise.all([
      api.load('session-one', { expectedRuntimeKey: 'runtime-a' }),
      api.load('session-two', { expectedRuntimeKey: 'runtime-a' }),
    ]);

    expect(runtimeFetch.mock.calls.filter(([path]) => path === '/auth/follow-up-queue/capabilities')).toHaveLength(1);
  });
});
