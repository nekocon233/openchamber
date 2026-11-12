import { describe, expect, it, vi } from 'vitest';
import { createWebSourceControlAPI } from './source-control';

const context = { provider: 'github', instance: 'github.com', directory: '/repo', repositoryId: 'bound-repo', accountId: 'exact-account', bindingRevision: 3, primaryRemote: 'origin' };
const payload = { headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), files: [{ path: 'a.ts', additions: 3, deletions: 1 }] };

describe('per-file statistics web adapter', () => {
  it('carries exact binding, repository, revision and cancellation authority', async () => {
    const fetch = vi.fn(async () => Response.json(payload));
    const signal = new AbortController().signal;
    expect(await createWebSourceControlAPI({ fetch }).changeRequestFileStats(context, 7, {
      project: { owner: 'acme', name: 'app' }, expectedHeadSha: payload.headSha, signal,
    })).toEqual(payload);
    expect(fetch).toHaveBeenCalledWith('/api/source-control/github/pulls/file-stats', {
      query: new URLSearchParams({ instance: 'github.com', directory: '/repo', repositoryId: 'bound-repo', accountId: 'exact-account', bindingRevision: '3', primaryRemote: 'origin', number: '7', owner: 'acme', repo: 'app', expectedHeadSha: payload.headSha }),
      headers: { Accept: 'application/json' }, signal,
    });
  });
  it.each([
    { files: [] }, { ...payload, headSha: 'c'.repeat(40) },
    { ...payload, files: [{ path: 'a', additions: -1, deletions: 0 }] },
    { ...payload, files: [payload.files[0], payload.files[0]] },
  ])('rejects invalid or stale answers', async body => {
    const fetch = vi.fn(async () => Response.json(body));
    await expect(createWebSourceControlAPI({ fetch }).changeRequestFileStats(context, 7, { expectedHeadSha: payload.headSha })).rejects.toThrow();
  });
  it('propagates provider errors instead of returning empty counts', async () => {
    const fetch = vi.fn(async () => Response.json({ error: 'Account unavailable' }, { status: 401 }));
    await expect(createWebSourceControlAPI({ fetch }).changeRequestFileStats(context, 7)).rejects.toThrow('Account unavailable');
  });
});
