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
import type { ReviewChangeRequestInput } from '@/lib/source-control/types';
import { createWebAPIs } from '../../../../web/src/api/index';
import { ReviewSubmitForm } from './ReviewSubmitButton';
import type { ChangeRequestReview, ReviewSubmission } from './useChangeRequestReview';

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
    });
});
