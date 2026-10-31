import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { z } from 'zod';
import { githubPendingReviewActionSchema, type GitHubPendingReviewState } from '@/lib/source-control/pendingReview';
import type { SourceControlReadContext } from '@/lib/source-control/types';
import type { PendingReviewController } from './usePendingReview';

test('pending reviews keep ownership, unsent text and retry identity across refreshes', async () => {
  const dom = new Window({ url: 'http://localhost' });
  for (const [name, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator, location: dom.location,
    localStorage: dom.localStorage, Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
    Event: dom.Event, CustomEvent: dom.CustomEvent, MutationObserver: dom.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true,
  })) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  const headSha = 'a'.repeat(40);
  const context: SourceControlReadContext = { provider: 'github', instance: 'github.com', accountId: 'github.com#7', repositoryId: 'repo-A', bindingRevision: 1, primaryRemote: 'origin', directory: '/review-A' };
  const states = new Map<string, GitHubPendingReviewState>();
  const requestSchema = z.object({ idempotencyKey: z.string(), action: githubPendingReviewActionSchema,
    repositoryId: z.string(), bindingRevision: z.number(), primaryRemote: z.string(),
    target: z.object({ project: z.object({ owner: z.string(), name: z.string() }), number: z.number(), headSha: z.string() }),
  });
  const calls: z.infer<typeof requestSchema>[] = [];
  const receipts = new Map<string, string>();
  let failRead = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    if (!url.pathname.endsWith('/pr/review/pending')) return new Promise<Response>(() => {});
    if (init?.method !== 'POST') {
      if (failRead) return Response.json({ error: 'Offline' }, { status: 503 });
      const owner = url.searchParams.get('owner') ?? '';
      return Response.json(states.get(owner) ?? { headSha, open: true, ownPull: false, review: null });
    }
    const payload = requestSchema.parse(JSON.parse(String(init.body)));
    calls.push(payload);
    const existing = receipts.get(payload.idempotencyKey);
    if (existing) {
      if (calls.filter(call => call.idempotencyKey === payload.idempotencyKey).length === 2) throw new TypeError('Lost replay response');
      return new Response(existing, { headers: { 'content-type': 'application/json' } });
    }
    const owner = payload.target.project.owner;
    const state = states.get(owner) ?? { headSha, open: true, ownPull: false, review: null };
    if (payload.action.kind === 'comment') {
      const old = state.review;
      const comment = { id: `C${(old?.comments.length ?? 0) + 1}`, body: payload.action.body, path: payload.action.path, side: payload.action.side, line: payload.action.line, startLine: null, outdated: false };
      states.set(owner, { ...state, review: { id: `R-${owner}`, headSha, body: '', version: String((old?.comments.length ?? 0) + 1), comments: [...(old?.comments ?? []), comment] } });
    }
    const receipt = JSON.stringify({ status: 'succeeded', actor: { provider: 'github', instance: 'github.com', providerAccountId: 'github.com#7' }, replayed: false, result: {},
      target: { ...payload.target, project: { ...payload.target.project, id: `${owner}/${payload.target.project.name}` }, repositoryId: payload.repositoryId, bindingRevision: payload.bindingRevision, primaryRemote: payload.primaryRemote } });
    receipts.set(payload.idempotencyKey, receipt);
    if (calls.length === 1) throw new TypeError('Lost response');
    return new Response(receipt, { headers: { 'content-type': 'application/json' } });
  }, originalFetch);
  const { createRoot } = await import('react-dom/client');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { I18nProvider } = await import('@/lib/i18n');
  const { createWebAPIs } = await import('../../../../web/src/api/index');
  const { usePendingReview } = await import('./usePendingReview');
  const { usePendingReviewDraftStore } = await import('@/stores/usePendingReviewDraftStore');
  let controller: PendingReviewController | undefined;
  const current = () => { if (!controller) throw new Error('Not mounted'); return controller; };
  const Probe = ({ owner, active }: { owner: string; active: boolean }) => {
    controller = usePendingReview({ ...context, repositoryId: `repo-${owner}`, directory: `/review-${owner}` }, { owner, repo: 'app', number: 7 }, active);
    return <span>{controller.data?.review?.comments.length ?? 0}</span>;
  };
  const root = createRoot(document.createElement('div'));
  const apis = createWebAPIs();
  const render = async (owner: string, active = true) => act(async () => root.render(<RuntimeAPIContext.Provider value={apis}><I18nProvider><Probe owner={owner} active={active} /></I18nProvider></RuntimeAPIContext.Provider>));
  const untilReady = async () => {
    for (let i = 0; i < 50 && current().loading; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(current().loading).toBe(false);
  };
  try {
    await render('A'); await untilReady();
    const keyA = current().key;
    if (!keyA) throw new Error('Review scope was not resolved');
    usePendingReviewDraftStore.getState().setText(`${keyA}:summary`, 'Unsent summary');
    const first = { kind: 'comment' as const, path: 'a.ts', side: 'RIGHT' as const, line: 3, body: 'First note' };
    await act(async () => { expect(await current().mutate(first, headSha)).toBe(false); });
    expect(current().data?.review?.comments).toHaveLength(1);
    await act(async () => { expect(await current().mutate({ ...first, body: 'Second note', reviewId: 'R-A' }, headSha)).toBe(true); });
    await act(async () => { expect(await current().mutate({ ...first, reviewId: 'R-A' }, headSha)).toBe(false); });
    expect(calls[2].idempotencyKey).toBe(calls[0].idempotencyKey);
    expect(calls[2].action).toEqual(calls[0].action);
    await act(async () => { expect(await current().mutate({ ...first, reviewId: 'R-A' }, headSha)).toBe(true); });
    expect(calls[3].idempotencyKey).toBe(calls[0].idempotencyKey);
    expect(calls[3].action).toEqual(calls[0].action);
    expect(current().data?.review?.comments).toHaveLength(2);
    await render('B'); await untilReady();
    expect(current().data?.review).toBeNull();
    expect(current().key).not.toBe(keyA);
    await render('A'); await untilReady();
    expect(current().data?.review?.comments).toHaveLength(2);
    expect(usePendingReviewDraftStore.getState().texts[`${current().key}:summary`]).toBe('Unsent summary');
    failRead = true;
    await act(async () => { await current().refresh(); });
    expect(current().readError).toContain('Offline');
    expect(current().data?.review?.comments).toHaveLength(2);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    dom.happyDOM.cancelAsync();
  }
});
