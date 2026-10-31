import { describe, expect, it, vi } from 'vitest';
import { readGitHubPullPatch, resolveGitHubPullSnapshot } from './pull-diff.js';

const repo = { owner: 'acme', repo: 'app' };
const patch = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n';
const tooLarge = (status = 422) => Object.assign(new Error('Diff too large'), {
  status, response: { data: { errors: [{ resource: 'PullRequest', field: 'diff', code: 'too_large' }] } },
});

describe('GitHub pull request diff reader', () => {
  it('keeps the small PR fast path without fetching Git objects', async () => {
    const octokit = { request: vi.fn(async () => ({ data: patch })) };
    const readSnapshot = vi.fn();
    await expect(readGitHubPullPatch({ octokit, repo, number: 7, readSnapshot })).resolves.toEqual({ patch });
    expect(octokit.request).toHaveBeenCalledOnce();
    expect(readSnapshot).not.toHaveBeenCalled();
  });

  it('identifies the displayed commit only when the revision stays unchanged', async () => {
    const headSha = 'a'.repeat(40), baseSha = 'b'.repeat(40);
    const get = vi.fn(async () => ({ data: { number: 7, head: { sha: headSha }, base: { sha: baseSha } } }));
    const octokit = { rest: { pulls: { get } }, request: vi.fn(async () => ({ data: patch })) };
    await expect(readGitHubPullPatch({ octokit, repo, number: 7, includeRevision: true })).resolves.toEqual({ patch, headSha });
    get.mockResolvedValueOnce({ data: { number: 7, head: { sha: headSha }, base: { sha: baseSha } } })
      .mockResolvedValueOnce({ data: { number: 7, head: { sha: 'c'.repeat(40) }, base: { sha: baseSha } } });
    await expect(readGitHubPullPatch({ octokit, repo, number: 7, includeRevision: true })).rejects.toMatchObject({ code: 'STALE_CONFIG', status: 409 });
  });

  it.each([406, 422])('uses the complete local snapshot for an explicit %s diff size refusal', async (status) => {
    const octokit = { request: vi.fn(async () => { throw tooLarge(status); }) };
    const snapshot = { patch, files: [{ filename: 'a' }] };
    const readSnapshot = vi.fn(async () => snapshot);
    await expect(readGitHubPullPatch({ octokit, repo, number: 7, readSnapshot })).resolves.toBe(snapshot);
    expect(readSnapshot).toHaveBeenCalledOnce();
  });

  it.each([new Error('Network failed'), tooLarge(401), tooLarge(403), tooLarge(429),
    { status: 422, response: { data: { errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid' }] } } },
  ])('does not turn other errors into Git transfers', async (failure) => {
    const readSnapshot = vi.fn();
    await expect(readGitHubPullPatch({ octokit: { request: async () => { throw failure; } }, repo, number: 7, readSnapshot })).rejects.toBe(failure);
    expect(readSnapshot).not.toHaveBeenCalled();
  });

  it('preserves successful empty diffs and rejects malformed responses', async () => {
    await expect(readGitHubPullPatch({ octokit: { request: async () => ({ data: '' }) }, repo, number: 7 })).resolves.toEqual({ patch: '' });
    await expect(readGitHubPullPatch({ octokit: { request: async () => ({ data: '<html>error</html>' }) }, repo, number: 7 })).rejects.toThrow('invalid pull request diff');
  });

  it('uses the exact PR revisions when resolving its merge base', async () => {
    const head = 'a'.repeat(40), base = 'b'.repeat(40), mergeBase = 'c'.repeat(40);
    const context = { accountId: 'exact-account' };
    const octokit = {
      rest: { pulls: { get: vi.fn(async () => ({ data: { number: 7, head: { sha: head }, base: { sha: base } } })) } },
      request: vi.fn(async () => ({ data: { merge_base_commit: { sha: mergeBase } } })),
    };
    await expect(resolveGitHubPullSnapshot({ octokit, repo, number: 7, context })).resolves.toEqual({
      context, repo, number: 7, headSha: head, baseSha: base, mergeBaseSha: mergeBase, endpoint: 'https://github.com/acme/app.git',
    });
    expect(octokit.request).toHaveBeenCalledWith('GET /repos/{owner}/{repo}/compare/{basehead}', { ...repo, basehead: `${base}...${head}` });
    await expect(resolveGitHubPullSnapshot({ octokit, repo, number: 7, context, expectedHeadSha: base })).rejects.toMatchObject({ code: 'STALE_CONFIG' });
    await expect(resolveGitHubPullSnapshot({ octokit, repo, number: 7, context, expectedHeadSha: head, expectedBaseSha: head })).rejects.toMatchObject({ code: 'STALE_CONFIG' });
  });
});
