import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { PendingReviewSection } from '@/components/sourceBoard/PendingReviewSection';
import { SourceBoardReply } from '@/components/sourceBoard/SourceBoardReply';
import type { PendingReviewController } from '@/components/sourceBoard/usePendingReview';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { GitHubReference, SourceControlReadContext } from '@/lib/api/types';
import { I18nProvider } from '@/lib/i18n';
import type { GitHubPendingReviewAction } from '@/lib/source-control/pendingReview';
import { githubLikeDescriptor } from '@/lib/source-control/providers/descriptor.fixture';
import { useSourceControlProviderRegistry } from '@/lib/source-control/providers/registry';
import type { ReviewChangeRequestInput } from '@/lib/source-control/types';
import { createWebAPIs } from '../../../../web/src/api/index';
import { ReviewSubmitForm } from './ReviewSubmitButton';
import { useChangeRequestReview, useComparisonReview, type ChangeRequestReview, type ReviewSubmission } from './useChangeRequestReview';

describe('sending a review', () => {
    let browser: Window;
    let root: Root;
    let restoreGlobals: () => void;

    beforeEach(() => {
        browser = new Window({ url: 'http://localhost/' });
        const globals = {
            window: browser, document: browser.document, navigator: browser.navigator,
            HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, SVGElement: browser.SVGElement,
            MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
            requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
            getComputedStyle: browser.getComputedStyle.bind(browser), localStorage: browser.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
        };
        const descriptors = Object.getOwnPropertyDescriptors(globalThis);
        Object.assign(globalThis, globals);
        restoreGlobals = () => {
            for (const key of Object.keys(globals)) {
                const descriptor = descriptors[key];
                if (descriptor) Object.defineProperty(globalThis, key, descriptor);
                else Reflect.deleteProperty(globalThis, key);
            }
        };
        const host = document.createElement('div');
        document.body.append(host);
        root = createRoot(host);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        await browser.happyDOM.abort();
        browser.close();
        restoreGlobals();
    });

    const review = (submit: ChangeRequestReview['submit']): ChangeRequestReview => ({
        state: {
            viewerIsAuthor: false, headSha: 'abc', truncated: false, threads: [],
            draft: { id: 'R', body: '', comments: [
                { id: '1', path: 'a.ts', side: 'new', line: 1, startLine: null, body: 'x', author: null },
                { id: '2', path: 'a.ts', side: 'new', line: 2, startLine: null, body: 'y', author: null },
            ] },
        },
        readFailed: false,
        submissionPending: false,
        summaryDraftKey: 'review-fixture',
        fileComments: true,
        addComment: async () => true, updateComment: async () => true, deleteComment: async () => true,
        reply: async () => true, setResolved: async () => true, attachThread: () => undefined, discard: async () => true,
        submit,
    });
    const button = (label: string) => [...document.querySelectorAll('button')].find((entry) => entry.textContent?.includes(label));

    test('the send button waits with a spinner and takes no second press', async () => {
        let finish: (sent: boolean) => void = () => undefined;
        const submit = mock((): Promise<boolean> => new Promise((resolve) => { finish = resolve; }));
        await act(async () => root.render(<I18nProvider><ReviewSubmitForm review={review(submit)} provider="github" onDone={() => undefined} /></I18nProvider>));

        const send = button('Send 2 comments');
        expect(send).toBeTruthy();
        await act(async () => { send?.click(); });

        expect(send?.querySelector('[data-spinner]')).toBeTruthy();
        expect(button('Send 2 comments')?.hasAttribute('disabled')).toBe(true);
        await act(async () => { send?.click(); });
        expect(submit).toHaveBeenCalledTimes(1);

        await act(async () => { finish(false); });
        expect(button('Send 2 comments')?.querySelector('[data-spinner]')).toBeFalsy();
    });

    test('request changes can be sent without a summary body', async () => {
        let received: ReviewSubmission | null = null;
        const submit: ChangeRequestReview['submit'] = async (submission) => {
            received = submission;
            return true;
        };
        await act(async () => root.render(<I18nProvider><ReviewSubmitForm review={review(submit)} provider="github" onDone={() => undefined} /></I18nProvider>));

        const requestChanges = button('Request changes');
        expect(requestChanges).toBeTruthy();
        expect(requestChanges?.hasAttribute('disabled')).toBe(false);
        await act(async () => { requestChanges?.click(); });
        expect(received).toEqual({ verdict: 'request-changes', body: undefined });
    });

    test('approval targets the displayed patch when the review state reports a newer head', async () => {
        const comparedHead = 'a'.repeat(40);
        const newerHead = 'b'.repeat(40);
        const context: SourceControlReadContext = {
            provider: 'github', instance: 'github.com', accountId: 'github.com#1',
            repositoryId: 'repo-1', bindingRevision: 1, primaryRemote: 'origin', directory: '/repo',
        };
        const submissions: ReviewChangeRequestInput[] = [];
        let dispatched = 0;
        let rejectReview = () => {};
        const apis = createWebAPIs();
        apis.sourceControl.changeRequestReviewState = async () => ({
            connected: true, viewerIsAuthor: false, headSha: newerHead, draft: null, threads: [], truncated: false,
        });
        apis.sourceControl.changeRequestReview = async (payload) => {
            submissions.push(payload);
            return new Promise((_, reject) => {
                rejectReview = () => reject(new Error('The pull request head changed'));
            });
        };
        const ComparisonReview = () => {
            const { review: comparisonReview } = useComparisonReview({
                selectedSource: { kind: 'pr', number: 7, sourceRepo: { owner: 'acme', repo: 'app' } },
                prs: [], readContext: context, provider: 'github',
            }, context.directory, true, comparedHead);
            return comparisonReview?.state
                ? <ReviewSubmitForm review={comparisonReview} provider="github"
                    onVerdictDispatched={() => { dispatched += 1; }} onDone={() => undefined} />
                : null;
        };
        const providerRegistry = useSourceControlProviderRegistry.getState();
        try {
            const provider = githubLikeDescriptor();
            await providerRegistry.refresh({ providers: async () => [
                { ...provider, features: { ...provider.features, reviewDrafts: true } },
            ] });
            await act(async () => root.render(
                <RuntimeAPIContext.Provider value={apis}>
                    <I18nProvider><ComparisonReview /></I18nProvider>
                </RuntimeAPIContext.Provider>,
            ));
            const approve = button('Approve');
            expect(approve).toBeTruthy();
            await act(async () => approve?.click());
            expect(submissions.map(({ target }) => target.headSha)).toEqual([comparedHead]);
            expect(dispatched).toBe(1);
            expect(approve?.disabled).toBe(true);
            await act(async () => rejectReview());
        } finally {
            await act(async () => useSourceControlProviderRegistry.setState(providerRegistry));
        }
    });

    for (const [label, verdict] of [['Approve', 'approve'], ['Request changes', 'request-changes']] as const) {
        test(`a comparison opened directly refreshes project PRs after ${verdict} succeeds`, async () => {
            const headSha = 'a'.repeat(40);
            const project = { owner: 'acme', name: 'app' };
            const context: SourceControlReadContext = {
                provider: 'github', instance: 'github.com', accountId: 'github.com#1',
                repositoryId: 'repo-1', bindingRevision: 1, primaryRemote: 'origin', directory: '/repo',
            };
            const apis = createWebAPIs();
            const refreshes: Array<Parameters<typeof apis.sourceControl.refreshProviderReads>> = [];
            let finishReview: (() => void) | undefined;
            apis.sourceControl.refreshProviderReads = async (...args) => { refreshes.push(args); };
            apis.sourceControl.changeRequestReviewState = async () => ({
                connected: true, viewerIsAuthor: false, headSha, draft: null, threads: [], truncated: false,
            });
            apis.sourceControl.changeRequestReview = async () => {
                await new Promise<void>((resolve) => { finishReview = resolve; });
                return {
                    status: 'succeeded', replayed: false,
                    actor: { provider: context.provider, instance: context.instance, providerAccountId: context.accountId },
                    target: { project: { ...project, id: 'acme/app' }, number: 7, headSha,
                        repositoryId: context.repositoryId, bindingRevision: context.bindingRevision, primaryRemote: context.primaryRemote },
                    result: { commented: false },
                };
            };
            const ComparisonReview = () => {
                const activeReview = useChangeRequestReview({ context, project, number: 7, headSha, directory: context.directory, provider: 'github' });
                return activeReview?.state
                    ? <ReviewSubmitForm review={activeReview} provider="github" onDone={() => undefined} />
                    : null;
            };
            const registry = useSourceControlProviderRegistry.getState();
            try {
                const provider = githubLikeDescriptor();
                await registry.refresh({ providers: async () => [{ ...provider, features: { ...provider.features, reviewDrafts: true } }] });
                await act(async () => root.render(<RuntimeAPIContext.Provider value={apis}>
                    <I18nProvider><ComparisonReview /></I18nProvider>
                </RuntimeAPIContext.Provider>));
                await act(async () => button(label)?.click());
                expect(finishReview).toBeDefined();
                expect(refreshes).toEqual([]);
                await act(async () => finishReview?.());
                expect(refreshes).toEqual([[context, { lists: true }]]);
            } finally {
                await act(async () => useSourceControlProviderRegistry.setState(registry));
            }
        });
    }

    test('pending review section submits request changes without a summary body', async () => {
        let received: { action: GitHubPendingReviewAction; headSha: string } | null = null;
        const controller: PendingReviewController = {
            key: 'review-1',
            loading: false,
            busy: false,
            readError: null,
            error: null,
            data: {
                headSha: 'a'.repeat(40),
                open: true,
                ownPull: false,
                review: { id: 'R1', headSha: 'a'.repeat(40), body: '', version: 'v1', comments: [] },
            },
            refresh: async () => undefined,
            mutate: async (action, headSha) => {
                received = { action, headSha };
                return true;
            },
        };
        await act(async () => root.render(<I18nProvider><PendingReviewSection controller={controller} onSubmitted={() => undefined} /></I18nProvider>));

        const requestChanges = button('Request changes');
        expect(requestChanges).toBeTruthy();
        expect(requestChanges?.hasAttribute('disabled')).toBe(false);
        await act(async () => { requestChanges?.click(); });
        expect(received).toEqual({
            action: { kind: 'submit', reviewId: 'R1', version: 'v1', verdict: 'request-changes' },
            headSha: 'a'.repeat(40),
        });
    });

    test('board reply requests changes without a comment body', async () => {
        let received: ReviewChangeRequestInput | null = null;
        const apis = createWebAPIs();
        const refreshes: Array<Parameters<typeof apis.sourceControl.refreshProviderReads>> = [];
        apis.sourceControl.refreshProviderReads = async (...args) => { refreshes.push(args); };
        apis.sourceControl.changeRequestReview = async (payload) => {
            received = payload;
            return {
                status: 'succeeded',
                replayed: false,
                actor: { provider: 'gitlab', instance: 'https://gitlab.example.com', providerAccountId: 'https://gitlab.example.com#1' },
                target: { repositoryId: 'repo-1', bindingRevision: 1, primaryRemote: 'origin', project: { id: 'acme/app', owner: 'acme', name: 'app' }, number: 7, headSha: 'a'.repeat(40) },
                result: { commented: false },
            };
        };
        const context: SourceControlReadContext = {
            provider: 'gitlab',
            instance: 'https://gitlab.example.com',
            accountId: 'https://gitlab.example.com#1',
            repositoryId: 'repo-1',
            bindingRevision: 1,
            primaryRemote: 'origin',
            directory: '/repo',
        };
        const reference: GitHubReference = {
            kind: 'pull',
            state: 'open',
            draft: false,
            number: 7,
            title: 'Feature',
            url: 'https://gitlab.example.com/acme/app/-/merge_requests/7',
            body: '',
            bodyTruncated: false,
            createdAt: null,
            updatedAt: null,
            author: null,
            labels: [],
            commentCount: 0,
            sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' },
            head: 'feature',
            base: 'main',
            headSha: 'a'.repeat(40),
            headRepo: null,
            provider: 'gitlab',
        };
        await act(async () => root.render(
            <RuntimeAPIContext.Provider value={apis}>
                <I18nProvider>
                    <SourceBoardReply reference={reference} context={context} onRefresh={() => undefined} />
                </I18nProvider>
            </RuntimeAPIContext.Provider>,
        ));

        const requestChanges = button('Request changes');
        expect(requestChanges).toBeTruthy();
        expect(requestChanges?.hasAttribute('disabled')).toBe(false);
        await act(async () => { requestChanges?.click(); });
        expect(received).toMatchObject({
            verdict: 'request-changes',
            target: { project: { owner: 'acme', name: 'app' }, number: 7, headSha: 'a'.repeat(40) },
        });
        expect(received).not.toHaveProperty('body');
        expect(refreshes).toEqual([[context, { lists: true }]]);
    });
});
