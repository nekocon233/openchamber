import { afterEach, describe, expect, it, vi } from 'vitest';

import { NativeAgentsRequestError } from '@openchamber/ui/lib/native-agents/errors';
import { createWebNativeAgentsAPI } from './nativeAgents';

type Respond = (url: URL, signal: AbortSignal | undefined) => Promise<Response>;

const requests: URL[] = [];

const stubFetch = (respond: Respond) => {
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString(), 'http://openchamber.test');
    requests.push(url);
    return respond(url, init?.signal ?? undefined);
  });
};

// Never answers; rejects only when the request is aborted, like a half-open
// socket. An already aborted signal rejects at once, as fetch does.
const stalled: Respond = (_url, signal) => new Promise((_resolve, reject) => {
  if (signal?.aborted) reject(signal.reason);
  signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
});

afterEach(() => {
  requests.length = 0;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('web native agents API', () => {
  it('reads a directory snapshot from the native route', async () => {
    stubFetch(async () => Response.json({ ncl_a: { type: 'busy' } }));

    const statuses = await createWebNativeAgentsAPI().statuses('/work/project');

    expect(statuses).toEqual({ ncl_a: { type: 'busy' } });
    expect(requests[0]?.pathname).toBe('/api/native/sessions/status');
    expect(requests[0]?.searchParams.get('directory')).toBe('/work/project');
  });

  it('reports a failed read with the error and code the server sent', async () => {
    stubFetch(async () => Response.json(
      { error: 'Native session not found', code: 'NATIVE_SESSION_NOT_FOUND' },
      { status: 404 },
    ));

    const read = createWebNativeAgentsAPI().getSession('ncl_missing', '/work/project');

    await expect(read).rejects.toBeInstanceOf(NativeAgentsRequestError);
    await expect(read).rejects.toMatchObject({ status: 404, code: 'NATIVE_SESSION_NOT_FOUND' });
  });

  it('fails a success whose body is not the expected answer instead of returning empty', async () => {
    stubFetch(async () => new Response('<!doctype html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));

    await expect(createWebNativeAgentsAPI().questions('/work/project')).rejects.toThrow();
  });

  it('ends a stalled read at its deadline', async () => {
    vi.useFakeTimers();
    stubFetch(stalled);

    const read = createWebNativeAgentsAPI().listSessions('/work/project');
    const settled = expect(read).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(30_000);

    await settled;
  });

  it('posts a prompt as JSON and resolves once the server accepted it', async () => {
    const bodies: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new URL(input instanceof Request ? input.url : input.toString(), 'http://openchamber.test'));
      bodies.push(String(init?.body));
      expect(init?.method).toBe('POST');
      expect(init?.signal ?? null).toBeNull();
      return Response.json({ accepted: true });
    });
    const request = {
      directory: '/work/project',
      messageID: 'ncl_u_1b0e1c52-2f1f-4c3a-9d8e-0a7b6c5d4e3f',
      parts: [{ type: 'text' as const, text: 'Hello' }],
      model: { providerID: 'claude-native', modelID: 'opus' },
      agent: 'build' as const,
    };

    await createWebNativeAgentsAPI().prompt('ncl_f1033b7a-88c5-4b77-bbec-6d63ec3a1188', request);

    expect(requests[0]?.pathname).toBe('/api/native/sessions/ncl_f1033b7a-88c5-4b77-bbec-6d63ec3a1188/prompt');
    expect(JSON.parse(bodies[0] ?? '')).toEqual(request);
  });

  it('reverts with the session record it answers, keeping the revert marker', async () => {
    const bodies: string[] = [];
    const session = {
      id: 'ncl_f1033b7a-88c5-4b77-bbec-6d63ec3a1188',
      slug: 'ncl_f1033b7a-88c5-4b77-bbec-6d63ec3a1188',
      projectID: '',
      directory: '/work/project',
      title: 'Work',
      version: 'claude-cli',
      time: { created: 1, updated: 2 },
      revert: { messageID: 'ncl_u_1b0e1c52-2f1f-4c3a-9d8e-0a7b6c5d4e3f' },
    };
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new URL(input instanceof Request ? input.url : input.toString(), 'http://openchamber.test'));
      bodies.push(String(init?.body));
      return Response.json({ session, filesRestored: 2, conversationOnly: false });
    });

    const result = await createWebNativeAgentsAPI().revert(session.id, 'ncl_u_1b0e1c52-2f1f-4c3a-9d8e-0a7b6c5d4e3f', '/work/project');

    expect(result).toEqual({ session, filesRestored: 2, conversationOnly: false });
    expect(requests[0]?.pathname).toBe(`/api/native/sessions/${session.id}/revert`);
    expect(JSON.parse(bodies[0] ?? '')).toEqual({ directory: '/work/project', messageID: 'ncl_u_1b0e1c52-2f1f-4c3a-9d8e-0a7b6c5d4e3f' });
  });

  it('forks the whole conversation by leaving the message out', async () => {
    const bodies: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new URL(input instanceof Request ? input.url : input.toString(), 'http://openchamber.test'));
      bodies.push(String(init?.body));
      return Response.json({
        id: 'ncl_2b0e1c52-2f1f-4c3a-9d8e-0a7b6c5d4e3f',
        slug: 'ncl_2b0e1c52-2f1f-4c3a-9d8e-0a7b6c5d4e3f',
        projectID: '',
        directory: '/work/project',
        title: 'Work (fork)',
        version: 'claude-cli',
        time: { created: 1, updated: 2 },
      });
    });
    const api = createWebNativeAgentsAPI();

    await api.fork('ncl_f1033b7a-88c5-4b77-bbec-6d63ec3a1188', null, '/work/project');
    await api.fork('ncl_f1033b7a-88c5-4b77-bbec-6d63ec3a1188', 'ncl_u_1b0e1c52-2f1f-4c3a-9d8e-0a7b6c5d4e3f', '/work/project');

    expect(requests[0]?.pathname).toBe('/api/native/sessions/ncl_f1033b7a-88c5-4b77-bbec-6d63ec3a1188/fork');
    expect(JSON.parse(bodies[0] ?? '')).toEqual({ directory: '/work/project' });
    expect(JSON.parse(bodies[1] ?? '')).toEqual({ directory: '/work/project', messageID: 'ncl_u_1b0e1c52-2f1f-4c3a-9d8e-0a7b6c5d4e3f' });
  });

  it('reports a refused write with its code', async () => {
    stubFetch(async () => Response.json({ error: 'A native session keeps the CLI it started with', code: 'NATIVE_BACKEND_MISMATCH' }, { status: 409 }));
    await expect(createWebNativeAgentsAPI().abort('ncl_x')).rejects.toMatchObject({ status: 409, code: 'NATIVE_BACKEND_MISMATCH' });
  });

  it("ends a read when the caller's signal aborts", async () => {
    stubFetch(stalled);
    const controller = new AbortController();

    const read = createWebNativeAgentsAPI().statuses('/work/project', { signal: controller.signal });
    controller.abort(new DOMException('Superseded', 'AbortError'));

    await expect(read).rejects.toMatchObject({ name: 'AbortError' });
  });
});
