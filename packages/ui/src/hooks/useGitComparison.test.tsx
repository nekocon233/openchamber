import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { GitComparisonSource } from './useGitComparison';

const PR_CONTEXT = {
  provider: 'github', instance: 'github.com', accountId: 'github.com#7', repositoryId: 'repo-1',
  bindingRevision: 4, directory: '/repo', primaryRemote: 'origin',
} as const;

test('comparison reads preserve scope, report failures, retry, and stop while hidden', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, location: dom.location,
    localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
    customElements: dom.customElements, CSSStyleSheet: dom.CSSStyleSheet,
    Event: dom.Event, CustomEvent: dom.CustomEvent,
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: URL; resolve: (response: Response) => void }> = [];
  globalThis.fetch = Object.assign((input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    // Hold unrelated app-store bootstrap outside this fixture. Only explicitly
    // resolved comparison requests should publish data during these transitions.
    if (url.pathname === '/api/fs/home' || url.pathname === '/api/session-folders') {
      return new Promise<Response>(() => {});
    }
    return new Promise<Response>((resolve) => { requests.push({ url, resolve }); });
  }, originalFetch);
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { useGitComparison } = await import('./useGitComparison');
  const { notifyGitPush } = await import('@/lib/gitPushEvents');
  const { getRuntimeKey } = await import('@/lib/runtime-switch');
  type Capture = { current: ReturnType<typeof useGitComparison> | null };
  const captured: Capture = { current: null };
  let directory = '/repo-a';
  let source: GitComparisonSource = { kind: 'branch', baseRef: 'refs/heads/main', headRef: 'feature' };
  let enabled = false;
  let revision = '1';
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  function Harness() {
    captured.current = useGitComparison(directory, source, enabled, revision, PR_CONTEXT);
    return null;
  }
  const current = () => {
    if (!captured.current) throw new Error('Comparison did not render');
    return captured.current;
  };
  const render = () => act(async () => { root.render(<I18nProvider><Harness /></I18nProvider>); });
  const finish = (index: number, response: Response) => act(async () => { requests[index].resolve(response); });
  try {
    await render();
    expect(requests.map(({ url }) => url.pathname)).toEqual([]);
    enabled = true;
    await render();
    expect(requests).toHaveLength(1);
    expect(requests[0].url.searchParams.get('base')).toBe('refs/heads/main');
    expect(requests[0].url.searchParams.get('includeWorkingTree')).toBe('true');
    await finish(0, Response.json({ files: [{ path: 'a.ts', status: 'M' }] }));
    expect(current().files?.map((file) => file.path)).toEqual(['a.ts']);
    const oldRefresh = current().refresh;
    const oldFetchDiff = current().fetchDiff;

    const patch = current().fetchDiff('a.ts');
    await act(async () => { await Promise.resolve(); });
    expect(requests[1].url.pathname).toBe('/api/git/range-diff');
    expect(requests[1].url.searchParams.get('includeWorkingTree')).toBe('true');
    await finish(1, Response.json({ diff: 'branch patch' }));
    expect(await patch).toEqual({ diff: 'branch patch' });

    revision = '2';
    await render();
    expect(current().files?.map((file) => file.path)).toEqual(['a.ts']);
    await finish(2, Response.json({ error: 'snapshot failed' }, { status: 500 }));
    expect(current().files).toBeNull();
    expect(current().error).toBe('snapshot failed');
    let retry: Promise<void> | undefined;
    await act(async () => { retry = current().refresh(); });
    await finish(3, Response.json({ files: [] }));
    await retry;
    expect(current().files).toEqual([]);
    expect(current().error).toBeNull();

    source = { kind: 'commit', hash: 'a'.repeat(40) };
    await render();
    expect(current().files).toBeNull();
    expect(requests[4].url.pathname).toBe('/api/git/commit-files');
    await finish(4, Response.json({ files: [{ path: 'new.ts', previousPath: 'old.ts', changeType: 'R', insertions: 1, deletions: 1, isBinary: false }] }));
    const commitPatch = current().fetchDiff('new.ts', 20);
    await act(async () => { await Promise.resolve(); });
    expect(requests[5].url.pathname).toBe('/api/git/commit-diff');
    expect(requests[5].url.searchParams.get('hash')).toBe('a'.repeat(40));
    expect(requests[5].url.searchParams.get('previousPath')).toBe('old.ts');
    expect(requests[5].url.searchParams.get('context')).toBe('20');
    await finish(5, Response.json({ diff: 'commit patch' }));
    expect(await commitPatch).toEqual({ diff: 'commit patch' });
    await oldRefresh();
    await expect(oldFetchDiff('a.ts')).rejects.toThrow();
    expect(requests).toHaveLength(6);

    source = { kind: 'branch', baseRef: 'main', headRef: 'feature' };
    await render();
    directory = '/repo-b';
    await render();
    await finish(7, Response.json({ files: [{ path: 'b.ts', status: 'A' }] }));
    await finish(6, Response.json({ files: [{ path: 'stale.ts', status: 'D' }] }));
    expect(current().files?.map((file) => file.path)).toEqual(['b.ts']);

    const refreshBeforeHide = current().refresh;
    const fetchBeforeHide = current().fetchDiff;
    enabled = false;
    revision = '3';
    await render();
    await current().refresh();
    await refreshBeforeHide();
    await expect(fetchBeforeHide('b.ts')).rejects.toThrow();
    expect(requests).toHaveLength(8);
    expect(current().files?.map((file) => file.path)).toEqual(['b.ts']);
    enabled = true;
    await render();
    expect(requests).toHaveLength(9);
    await finish(8, Response.json({ files: [{ path: 'b.ts', status: 'A' }] }));

    source = { kind: 'pr', number: 42, sourceRepo: { owner: 'upstream', repo: 'project' } };
    await render();
    expect(requests[9].url.pathname).toBe('/api/walkthrough/pr-files');
    expect(JSON.parse(requests[9].url.searchParams.get('source') ?? '')).toEqual(source);
    // The published diff is read through the bound context, never an ambient account.
    expect(requests[9].url.searchParams.get('accountId')).toBe(PR_CONTEXT.accountId);
    expect(requests[9].url.searchParams.get('repositoryId')).toBe(PR_CONTEXT.repositoryId);
    const prHead = 'a'.repeat(40);
    const publishedPatch = 'diff --git a/pr.ts b/pr.ts\n--- a/pr.ts\n+++ b/pr.ts\n@@ -1 +1 @@\n-old\n+published\n';
    const lazyPatch = 'diff --git a/lazy.ts b/lazy.ts\n--- a/lazy.ts\n+++ b/lazy.ts\n@@ -1 +1 @@\n-before\n+after\n';
    const prFilesResponse = (patch: string) => Response.json({
      mode: 'files',
      headSha: prHead,
      files: [{ path: 'pr.ts', status: 'M', insertions: 1, deletions: 1, patch }],
    });
    await finish(9, Response.json({
      mode: 'files',
      headSha: prHead,
      files: [
        { path: 'pr.ts', status: 'M', insertions: 1, deletions: 1, patch: publishedPatch },
        { path: 'lazy.ts', status: 'M', insertions: 1, deletions: 1 },
        { path: 'huge.json', status: 'M', insertions: 100_000, deletions: 0 },
      ],
    }));
    expect(current().files?.map((file) => file.path)).toEqual(['pr.ts', 'lazy.ts', 'huge.json']);
    expect(await current().fetchDiff('pr.ts')).toEqual({ diff: publishedPatch, reviewHeadSha: prHead });
    // Opening inline files uses the snapshot without another HTTP read.
    expect(requests).toHaveLength(10);

    // Deferred files fetch on demand and cache per snapshot; oversized files fail only for themselves.
    const lazyRead = current().fetchDiff('lazy.ts');
    await act(async () => { await Promise.resolve(); });
    expect(requests[10].url.pathname).toBe('/api/walkthrough/pr-file-diff');
    expect(requests[10].url.searchParams.get('path')).toBe('lazy.ts');
    expect(requests[10].url.searchParams.get('headSha')).toBe(prHead);
    await finish(10, Response.json({ diff: lazyPatch, headSha: prHead }));
    expect(await lazyRead).toEqual({ diff: lazyPatch, reviewHeadSha: prHead });
    expect(await current().fetchDiff('lazy.ts')).toEqual({ diff: lazyPatch, reviewHeadSha: prHead });
    expect(requests).toHaveLength(11);

    const hugeOutcome = current().fetchDiff('huge.json').then(
      () => null,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    await act(async () => { await Promise.resolve(); });
    expect(requests[11].url.pathname).toBe('/api/walkthrough/pr-file-diff');
    await finish(11, Response.json({ error: 'This file is too large to show', code: 'file-too-large' }, { status: 413 }));
    expect(await hugeOutcome).toBe('This file is too large to show');
    expect(await current().fetchDiff('pr.ts')).toEqual({ diff: publishedPatch, reviewHeadSha: prHead });

    const snapshotRevision = current().revision;
    enabled = false;
    await render();
    enabled = true;
    await render();
    expect(requests).toHaveLength(12);
    expect(current().revision).toBe(snapshotRevision);
    await act(async () => { retry = current().refresh(); });
    await finish(12, prFilesResponse(publishedPatch.replace('+published', '+updated')));
    await retry;
    expect(current().revision).toBeGreaterThan(snapshotRevision);
    expect((await current().fetchDiff('pr.ts')).diff).toContain('+updated');

    await act(async () => { retry = current().refresh(); });
    await finish(13, Response.json({ error: 'GitHub unavailable' }, { status: 503 }));
    await retry;
    expect(current().files).toBeNull();
    expect(current().error).toBe('GitHub unavailable');
    await act(async () => { retry = current().refresh(); });
    await finish(14, Response.json({ mode: 'patch', headSha: null, patch: '' }));
    await retry;
    expect(current().files).toEqual([]);
    const refreshOldPr = current().refresh;
    const readOldPr = current().fetchDiff;
    source = { kind: 'pr', number: 42, sourceRepo: { owner: 'fork', repo: 'project' } };
    await render();
    source = { kind: 'pr', number: 43, sourceRepo: { owner: 'upstream', repo: 'project' } };
    await render();
    await finish(16, Response.json({ mode: 'patch', headSha: prHead, patch: publishedPatch.replace('+published', '+new PR') }));
    await finish(15, prFilesResponse(publishedPatch));
    expect((await current().fetchDiff('pr.ts')).diff).toContain('+new PR');
    await refreshOldPr();
    await expect(readOldPr('pr.ts')).rejects.toThrow();
    expect(requests).toHaveLength(17);

    await act(async () => { retry = current().refresh(); });
    await finish(17, new Response('<html>OpenCode</html>', { headers: { 'content-type': 'text/html' } }));
    await act(async () => { await Promise.resolve(); });
    expect(requests[18].url.pathname).toBe('/api/walkthrough/pr-diff');
    await finish(18, new Response('<html>OpenCode</html>', { headers: { 'content-type': 'text/html' } }));
    await retry;
    expect(current().files).toBeNull();
    expect(current().error).toContain('unavailable on this server');

    // Older servers without /api/walkthrough/pr-files fall back to /api/walkthrough/pr-diff.
    await act(async () => { retry = current().refresh(); });
    await finish(19, new Response('<html>OpenCode</html>', { headers: { 'content-type': 'text/html' } }));
    await act(async () => { await Promise.resolve(); });
    expect(requests[20].url.pathname).toBe('/api/walkthrough/pr-diff');
    await finish(20, new Response(publishedPatch, { headers: { 'content-type': 'text/plain', 'x-openchamber-pr-head-sha': prHead } }));
    await retry;
    expect((await current().fetchDiff('pr.ts')).diff).toContain('+published');

    await act(async () => { retry = current().refresh(); });
    await finish(21, prFilesResponse(publishedPatch));
    await retry;
    enabled = false;
    await render();
    await act(async () => {
      notifyGitPush('/repo-b', getRuntimeKey());
      notifyGitPush('/repo-b', getRuntimeKey());
    });
    expect(requests).toHaveLength(22);
    enabled = true;
    await render();
    expect(requests).toHaveLength(23);
    await finish(22, prFilesResponse(publishedPatch.replace('+published', '+after push')));
    expect((await current().fetchDiff('pr.ts')).diff).toContain('+after push');
    await act(async () => { notifyGitPush('/other-repo', getRuntimeKey()); });
    expect(requests).toHaveLength(23);
    await act(async () => { notifyGitPush('/repo-b', 'another-runtime'); });
    expect(requests).toHaveLength(23);
    await act(async () => { notifyGitPush('/repo-b', getRuntimeKey()); });
    expect(requests).toHaveLength(24);
    await act(async () => { notifyGitPush('/repo-b', getRuntimeKey()); });
    expect(requests).toHaveLength(25);
    await finish(24, prFilesResponse(publishedPatch.replace('+published', '+latest push')));
    await finish(23, prFilesResponse(publishedPatch.replace('+published', '+older push')));
    expect((await current().fetchDiff('pr.ts')).diff).toContain('+latest push');
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    await dom.happyDOM.abort();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
