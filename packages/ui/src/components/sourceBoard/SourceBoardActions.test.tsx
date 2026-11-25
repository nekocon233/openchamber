import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import type { GitHubPullReference, SourceControlAPI, SourceControlReadContext } from '@/lib/api/types';
import type { MergeChangeRequestInput, SourceControlCapabilities, SourceControlMergeMutationResult } from '@/lib/source-control/types';

const browser = new Window({ url: 'http://source-board.test' });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
    window: browser, document: browser.document, navigator: browser.navigator, location: browser.location,
    localStorage: browser.localStorage, sessionStorage: browser.sessionStorage,
    HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node,
    HTMLInputElement: browser.HTMLInputElement, HTMLButtonElement: browser.HTMLButtonElement,
    HTMLDivElement: browser.HTMLDivElement, DocumentFragment: browser.DocumentFragment, ShadowRoot: browser.ShadowRoot,
    Event: browser.Event, CustomEvent: browser.CustomEvent, KeyboardEvent: browser.KeyboardEvent,
    MouseEvent: browser.MouseEvent, PointerEvent: browser.PointerEvent,
    MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
    getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
})) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
const originalFetch = globalThis.fetch;
// Unrelated app-store initialization cannot reach any external service.
globalThis.fetch = Object.assign(() => new Promise<Response>(() => {}), originalFetch);

const { createRoot } = await import('react-dom/client');
const { OpenCode } = await import('@opencode/client');
const { I18nProvider } = await import('@/lib/i18n');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { registerRuntimeAPIs } = await import('@/contexts/runtimeAPIRegistry');
const { createTestNativeAgentsAPI, createTestRuntimeAPIs } = await import('@/lib/native-agents/test-utils/runtime');
const { initializeRuntimeEndpoint, switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
const { createWebSourceControlAPI } = await import('../../../../web/src/api/source-control');
const { SyncProvider } = await import('@/sync/sync-context');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { rememberMergeMethod } = await import('@/components/views/git/mergeMethodPreference');
const { SourceBoardActions } = await import('./SourceBoardActions');
const { toast } = await import('@/components/ui/toast');
const { useTrackedItemsStore } = await import('@/stores/useTrackedItemsStore');
const { trackedItemKey } = await import('@/lib/trackedItems/model');

const CONTEXT: SourceControlReadContext = {
    provider: 'github', instance: 'github.com', directory: '/fixture/repository', repositoryId: 'repository-one',
    accountId: 'github.com#7', bindingRevision: 3, primaryRemote: 'origin',
};
const PULL: GitHubPullReference = {
    kind: 'pull', number: 17, title: 'Review the parser', url: 'https://github.com/fixture/repository/pull/17',
    body: '', bodyTruncated: false, createdAt: null, updatedAt: null, author: null, labels: [], commentCount: 0,
    sourceRepo: { owner: 'fixture', repo: 'repository', source: 'fixture/repository' }, provider: 'github',
    state: 'open', draft: false, head: 'parser-fix', base: 'main', headSha: 'a'.repeat(40), headRepo: null,
};
const host = document.createElement('div');
document.body.append(host);
const sdk = OpenCode.make({ baseUrl: 'http://source-board.test', fetch: async () => Response.json([]) });
let root: ReturnType<typeof createRoot> | null = null;
let capabilityFailure = false;
let capabilityGate: Promise<void> | null = null;
let mergeGate: Promise<void> | null = null;
let mergeFailure: Error | null = null;
let mergeResult: SourceControlMergeMutationResult;
let mergeCalls: MergeChangeRequestInput[] = [];
let refreshes = 0;
let completions: number[] = [];
let sourceControl: SourceControlAPI;
let apis: ReturnType<typeof createTestRuntimeAPIs>;
const deferred = () => {
    let release = () => {};
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
};
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const render = async (pull = PULL, context: SourceControlReadContext | null = CONTEXT, returnOnSubmit = true) => {
    root ??= createRoot(host);
    await act(async () => root?.render(
        <I18nProvider><RuntimeAPIContext.Provider value={apis}><SyncProvider sdk={sdk} directory="">
            <SourceBoardActions item={{ source: 'repository', reference: pull }} project={null} context={context}
                onStartWorktree={() => { throw new Error('This test must never start a worktree'); }} onChanged={() => { refreshes++; }}
                onMergeSubmitted={returnOnSubmit ? () => { completions.push(refreshes); } : undefined} />
        </SyncProvider></RuntimeAPIContext.Provider></I18nProvider>,
    ));
    await settle();
};
const button = (label: string, container: ParentNode = host) => {
    const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent?.trim() === label);
    if (!found) throw new Error(`Missing button: ${label}`);
    return found;
};
const click = (value: HTMLButtonElement) => act(async () => { value.click(); });
const dialog = () => {
    const found = document.querySelector('[role="dialog"]');
    if (!found) throw new Error('Merge confirmation is missing');
    return found;
};
const confirm = () => click(button('Merge', dialog()));

beforeEach(() => {
    capabilityFailure = false; capabilityGate = null; mergeGate = null; mergeFailure = null; mergeResult = { merged: true }; mergeCalls = []; refreshes = 0; completions = [];
    initializeRuntimeEndpoint({ apiBaseUrl: 'http://source-board.test', runtimeKey: 'source-board-one' });
    useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null });
    rememberMergeMethod('squash');
    sourceControl = {
        ...createWebSourceControlAPI(),
        capabilities: async identity => {
            if (capabilityGate) await capabilityGate;
            if (capabilityFailure) throw new Error('Capabilities unavailable');
            const capabilities: SourceControlCapabilities = {
                identity, authentication: true, authenticationMethods: {
                    device: { available: true }, pat: { available: true }, cli: { available: true },
                }, multipleAccounts: true, projects: true, issues: true, changeRequests: true, draftChangeRequests: true,
                mergeChangeRequests: true, forceMergeChangeRequests: true, mergeMethods: ['merge', 'squash', 'rebase'], ci: true,
            };
            return capabilities;
        },
        changeRequestMerge: async input => {
            mergeCalls.push(structuredClone(input));
            if (mergeGate) await mergeGate;
            if (mergeFailure) throw mergeFailure;
            return { status: 'succeeded', actor: { provider: input.provider, instance: input.instance, providerAccountId: 'provider-user-seven' },
                replayed: false, result: mergeResult, target: {
                    ...input.target, project: { ...input.target.project, id: 'fixture/repository' }, repositoryId: input.repositoryId,
                    bindingRevision: input.bindingRevision, primaryRemote: input.primaryRemote,
                } };
        },
    };
    apis = createTestRuntimeAPIs(createTestNativeAgentsAPI({}));
    Object.defineProperty(apis, 'sourceControl', { value: sourceControl });
    registerRuntimeAPIs(apis);
});
afterEach(async () => {
    await act(async () => root?.unmount()); root = null;
    registerRuntimeAPIs(null);
});
afterAll(async () => {
    globalThis.fetch = originalFetch;
    await browser.happyDOM.close();
    for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
    }
});

test('only the standard merge action is offered when the server advertises force merge', async () => {
    rememberMergeMethod('rebase');
    await render();
    expect(host.textContent).not.toContain('Force merge');
    await click(button('Rebase and merge'));
    expect(dialog().textContent).toContain('Merge pull request #17?');
    expect(dialog().textContent).toContain('main');
    expect(mergeCalls).toEqual([]);
    await confirm(); await settle();
    expect(mergeCalls).toHaveLength(1);
    expect(mergeCalls[0]).toMatchObject({ ...CONTEXT, method: 'rebase', target: {
        project: { owner: 'fixture', name: 'repository' }, number: 17, head: 'parser-fix', base: 'main', headSha: PULL.headSha,
    } });
    expect(mergeCalls[0]).not.toHaveProperty('force');
    expect(mergeCalls[0].idempotencyKey.length).toBeGreaterThan(0);
    expect(refreshes).toBe(1);
    expect(completions).toEqual([0]);
});

test('a scheduled squash keeps the squash button available and uses the plain auto-merge label', async () => {
    const waiting = { enabledAt: '2026-11-25T08:25:39Z', mergeMethod: 'SQUASH' };
    const item = { provider: CONTEXT.provider, instance: CONTEXT.instance, accountId: CONTEXT.accountId,
        kind: 'pull' as const, owner: PULL.sourceRepo.owner, repo: PULL.sourceRepo.repo, number: PULL.number };
    const state = { owner: item.owner, repo: item.repo, number: item.number, title: PULL.title, state: 'open' as const,
        draft: false, headSha: PULL.headSha, mergeable: true, mergeableState: 'blocked', checks: null, autoMergeRequest: waiting };
    try {
        await act(async () => useTrackedItemsStore.getState().apply('source-board-one', [{
            key: trackedItemKey(item), record: { type: 'pull', item, state, fetchedAt: Date.now() },
        }]));
        await render();
        expect([...host.querySelectorAll('span')].some(span => span.textContent === 'Auto-merge on')).toBe(true);
        const squash = button('Squash and merge');
        expect(squash.disabled).toBe(false);
        await click(squash);
        expect(dialog().textContent).toContain('The current auto-merge will be cancelled');
        expect(mergeCalls).toHaveLength(0);
        await click(button('Squash and merge', dialog()));
        await settle();
        expect(mergeCalls).toHaveLength(1);
        expect(mergeCalls[0]).toMatchObject({ method: 'squash', cancel: waiting, target: { number: PULL.number, headSha: PULL.headSha } });
    } finally {
        await act(async () => useTrackedItemsStore.setState({ records: {} }));
    }
});

test('canceling the merge confirmation never dispatches or refreshes', async () => {
    await render();
    await click(button('Squash and merge'));
    await click(button('Cancel', dialog()));
    expect(mergeCalls).toEqual([]);
    expect(refreshes).toBe(0);
    expect(completions).toEqual([]);
    expect(button('Squash and merge').disabled).toBe(false);
});

test('a queued merge returns on dispatch and refreshes when its result arrives', async () => {
    mergeResult = { merged: false, outcome: 'queued' };
    await render(); await click(button('Squash and merge'));
    await click(button('Merge', dialog())); await settle();
    expect(mergeCalls).toHaveLength(1);
    expect(refreshes).toBe(1);
    expect(completions).toEqual([0]);
});

test('dispatch returns before delivery and a reopened detail cannot submit the same PR twice', async () => {
    const gate = deferred(); mergeGate = gate.promise;
    await render(); await click(button('Squash and merge'));
    await click(button('Merge', dialog()));
    expect(mergeCalls).toHaveLength(1);
    expect(completions).toEqual([0]);
    expect(refreshes).toBe(0);
    await act(async () => root?.unmount()); root = null;
    await render();
    expect(button('Squash and merge').disabled).toBe(true);
    await act(async () => { gate.release(); }); await settle();
    expect(refreshes).toBe(1);
    expect(completions).toEqual([0]);
    expect(button('Squash and merge').disabled).toBe(false);
    expect(mergeCalls).toHaveLength(1);
});

test('a failure after returning keeps repository-labelled feedback and releases the PR', async () => {
    const gate = deferred(); mergeGate = gate.promise;
    mergeFailure = new Error('Background merge was refused');
    await render(); await click(button('Squash and merge'));
    await click(button('Merge', dialog()));
    expect(completions).toEqual([0]);
    await act(async () => root?.unmount()); root = null;
    await act(async () => { gate.release(); }); await settle();
    expect(toast.getHistory().some(item => 'title' in item && item.type === 'error' && item.description === 'Background merge was refused'
        && String(item.title).includes('fixture/repository #17'))).toBe(true);
    expect(refreshes).toBe(1);
    await render();
    expect(button('Squash and merge').disabled).toBe(false);
});

test('loading or failed capabilities leave merge unavailable', async () => {
    const gate = deferred(); capabilityGate = gate.promise;
    await render();
    expect(host.textContent).not.toContain('Squash and merge');
    capabilityFailure = true;
    await act(async () => { gate.release(); }); await settle();
    expect(host.textContent).not.toContain('Squash and merge');
    expect(mergeCalls).toEqual([]);
});

test('repeated clicks share one confirmation and dispatch', async () => {
    const gate = deferred(); mergeGate = gate.promise;
    await render();
    const merge = button('Squash and merge');
    await act(async () => { merge.click(); merge.click(); merge.click(); });
    expect(dialog().textContent).toContain('Merge pull request #17?');
    await confirm(); await settle();
    expect(button('Squash and merge').disabled).toBe(true);
    expect(mergeCalls).toHaveLength(1);
    await act(async () => { gate.release(); }); await settle();
    expect(mergeCalls).toHaveLength(1);
    expect(button('Squash and merge').disabled).toBe(false);
});

test('changing the pull, head or binding while confirming cancels the old operation', async () => {
    for (const replacement of [
        { pull: { ...PULL, number: 18 }, context: CONTEXT },
        { pull: { ...PULL, headSha: 'b'.repeat(40) }, context: CONTEXT },
        { pull: PULL, context: { ...CONTEXT, bindingRevision: 4 } },
        { pull: PULL, context: { ...CONTEXT, directory: '/fixture/other' } },
    ]) {
        await render(); await click(button('Squash and merge'));
        await render(replacement.pull, replacement.context);
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(mergeCalls).toEqual([]);
    }
    expect(refreshes).toBe(0);
});

test('a runtime switch with unchanged props cancels confirmation and sends nothing', async () => {
    await render(); await click(button('Squash and merge'));
    await act(async () => { switchRuntimeEndpoint({ apiBaseUrl: 'http://other-source-board.test', runtimeKey: 'source-board-two' }); });
    await settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(mergeCalls).toEqual([]);
    expect(refreshes).toBe(0);
});

test('provider failure refreshes once without retrying', async () => {
    mergeFailure = new Error('GitHub rejected the request');
    await render(); await click(button('Squash and merge')); await confirm(); await settle();
    expect(mergeCalls).toHaveLength(1);
    expect(refreshes).toBe(1);
    expect(button('Squash and merge').disabled).toBe(false);
    expect(completions).toEqual([0]);
});

for (const failed of [false, true]) {
    test(`a late ${failed ? 'failure' : 'success'} cannot refresh a different pull or unlock a duplicate dispatch`, async () => {
        const gate = deferred(); mergeGate = gate.promise;
        mergeFailure = failed ? new Error('Old pull request failed') : null;
        await render(PULL, CONTEXT, false); await click(button('Squash and merge')); await confirm();
        expect(mergeCalls).toHaveLength(1);
        await render({ ...PULL, number: 18 }, CONTEXT, false);
        await click(button('Squash and merge'));
        expect(mergeCalls).toHaveLength(1);
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        await act(async () => { gate.release(); }); await settle();
        expect(refreshes).toBe(0);
        expect(completions).toEqual([]);
        expect(mergeCalls).toHaveLength(1);
    });
}
