import { describe, expect, test } from 'bun:test';

import type { AttachedFile } from '@/stores/types/sessionTypes';
import type { InlineCommentDraft } from '@/stores/useInlineCommentDraftStore';
import { CONTEXT_METADATA_KEY, contextPayloadFromDraft } from '@/lib/messages/contextParts';
import type { QueuedContextPart } from '@/stores/messageQueueStore';
import {
    buildComposerContext,
    buildOutgoingMessage,
    queuedContextToParts,
    type ComposerContextInput,
    type OutgoingMessageDeps,
    type OutgoingMessageInput,
} from '../buildOutgoingMessage';

const attachment = (id: string): AttachedFile => ({
    id,
    file: new File([id], `${id}.txt`, { type: 'text/plain' }),
    filename: `${id}.txt`,
    mimeType: 'text/plain',
    size: id.length,
    dataUrl: `data:text/plain,${id}`,
    source: 'local',
});

/**
 * Resolvers with just enough behavior to observe ordering: `@agent:name`
 * names an agent, `@file:x` resolves to an attachment, `/skill` is a skill.
 */
const deps = (overrides: Partial<OutgoingMessageDeps> = {}): OutgoingMessageDeps => ({
    parseAgentMention: (text) => {
        const match = /@agent:(\w+)\s*/.exec(text);
        return match
            ? { text: text.replace(match[0], ''), agentName: match[1] }
            : { text };
    },
    extractFileMentions: (text) => {
        const attachments = [...text.matchAll(/@file:(\w+)/g)].map((match) => attachment(match[1]));
        return { text, attachments };
    },
    sanitizeAttachments: (files) => [...(files ?? [])],
    collectSkillNames: (text) => [...text.matchAll(/\/(\w+)/g)].map((match) => match[1]),
    buildSkillInstruction: (names) => (names.length ? `use: ${names.join(',')}` : null),
    ...overrides,
});

const input = (overrides: Partial<OutgoingMessageInput> = {}): OutgoingMessageInput => ({
    composerText: null,
    composerAttachments: [],
    inlineComments: [],
    additionalParts: [],
    linkedIssue: null,
    linkedPr: null,
    linkedLinearIssue: null,
    linkedGuestIssue: null,
    ...overrides,
});

describe('composer content', () => {
    test('keeps the current message independent of staged entries in the source state', () => {
        const queued = [{ text: 'saved draft', agentMention: 'plan', attachments: [attachment('saved')] }];
        const submission = {
            ...input({
                composerText: '@agent:build message A',
                composerAttachments: [attachment('current')],
                additionalParts: [{ text: 'A context', synthetic: true }],
            }),
            queued,
        };

        const result = buildOutgoingMessage(submission, deps());

        expect(result.primaryText).toBe('message A');
        expect(result.primaryAttachments.map((file) => file.id)).toEqual(['current']);
        expect(result.agentMentionName).toBe('build');
        expect(result.additionalParts).toEqual([{ text: 'A context', synthetic: true }]);
        expect(queued.map((entry) => entry.text)).toEqual(['saved draft']);
    });

    test('an empty composer stays empty when the source state has staged entries', () => {
        const submission = { ...input(), queued: [{ text: 'saved draft' }] };

        const result = buildOutgoingMessage(submission, deps());

        expect(result.isEmpty).toBe(true);
        expect(result.primaryText).toBe('');
        expect(result.additionalParts).toEqual([]);
    });

    test('becomes the primary message and preserves interior blank lines', () => {
        const result = buildOutgoingMessage(input({ composerText: '\n\nhello\n\nworld\n\n' }), deps());

        expect(result.primaryText).toBe('hello\n\nworld');
        expect(result.additionalParts).toEqual([]);
        expect(result.isEmpty).toBe(false);
    });

    test('keeps composer attachments and resolved file mentions on the primary message', () => {
        const result = buildOutgoingMessage(
            input({ composerText: 'see @file:doc', composerAttachments: [attachment('pic')] }),
            deps(),
        );

        expect(result.primaryAttachments.map((entry) => entry.id)).toEqual(['pic', 'doc']);
    });

    test('routes the leading agent mention', () => {
        const result = buildOutgoingMessage(input({ composerText: '@agent:build do it' }), deps());

        expect(result.primaryText).toBe('do it');
        expect(result.agentMentionName).toBe('build');
    });

    test('reports truly empty input', () => {
        expect(buildOutgoingMessage(input(), deps()).isEmpty).toBe(true);
    });

    test('treats attachments without text as sendable', () => {
        const result = buildOutgoingMessage(
            input({ composerText: '', composerAttachments: [attachment('pic')] }),
            deps(),
        );

        expect(result.isEmpty).toBe(false);
    });
});

describe('agent mentions', () => {
    test('an agent named in the composer routes the send', () => {
        expect(buildOutgoingMessage(input({ composerText: '@agent:build do it' }), deps())
            .agentMentionName).toBe('build');
    });

    test('no mention leaves the routing unset', () => {
        expect(buildOutgoingMessage(input({ composerText: 'plain' }), deps()).agentMentionName)
            .toBe(undefined);
    });
});

const commentDraft = (overrides: Partial<InlineCommentDraft> = {}): InlineCommentDraft => ({
    id: 'icd-1',
    sessionKey: 's1',
    source: 'diff',
    fileLabel: 'src/app.ts',
    startLine: 3,
    endLine: 5,
    side: 'modified',
    code: 'const x = 1;',
    language: 'ts',
    text: 'fix this',
    createdAt: 1,
    ...overrides,
});

describe('context drafts', () => {
    test('each becomes a synthetic part carrying structured metadata', () => {
        const result = buildOutgoingMessage(input({
            composerText: 'body',
            inlineComments: [commentDraft(), commentDraft({ id: 'icd-2', source: 'file', side: undefined })],
        }), deps());

        expect(result.primaryText).toBe('body');
        expect(result.additionalParts).toHaveLength(2);
        expect(result.additionalParts.every((part) => part.synthetic)).toBe(true);
        expect(result.additionalParts[0].metadata?.[CONTEXT_METADATA_KEY])
            .toEqual(contextPayloadFromDraft(commentDraft()));
        expect(result.additionalParts[1].metadata?.[CONTEXT_METADATA_KEY])
            .toEqual(contextPayloadFromDraft(commentDraft({ id: 'icd-2', source: 'file', side: undefined })));
        expect(result.additionalParts[0].text).toContain('Comment on `src/app.ts` lines 3-5 (modified):');
        expect(result.additionalParts[0].text).toContain('fix this');
    });

    test('context parts precede other additional context', () => {
        const result = buildOutgoingMessage(input({
            composerText: 'body',
            inlineComments: [commentDraft()],
            additionalParts: [{ text: 'conflict note', synthetic: true }],
        }), deps());

        expect(result.additionalParts.map((part) => part.text.startsWith('Comment on') ? 'comment' : part.text))
            .toEqual(['comment', 'conflict note']);
    });
});

describe('additional context', () => {
    test('preserves attachment, synthetic, and metadata fields', () => {
        const metadata = { [CONTEXT_METADATA_KEY]: contextPayloadFromDraft(commentDraft()) };
        const result = buildOutgoingMessage(input({
            composerText: 'body',
            additionalParts: [{
                text: 'context',
                attachments: [attachment('context-file')],
                synthetic: true,
                metadata,
            }],
        }), deps());

        expect(result.additionalParts).toEqual([{
            text: 'context',
            attachments: [attachment('context-file')],
            synthetic: true,
            metadata,
        }]);
    });

    test('a linked PR sends its instructions before its diff', () => {
        const result = buildOutgoingMessage(input({
            composerText: 'review this',
            linkedPr: { number: 7, title: 'PR', url: 'https://x/pr/7', instructions: 'how to read it', context: 'the diff' },
        }), deps());

        expect(result.additionalParts.map((part) => part.text)).toEqual(['how to read it', 'the diff']);
        expect(result.additionalParts.every((part) => part.synthetic)).toBe(true);
        expect(result.additionalParts[1].metadata?.[CONTEXT_METADATA_KEY])
            .toEqual({ kind: 'github-pr', number: 7, title: 'PR', url: 'https://x/pr/7' });
    });

    test('linked issues retain structured context metadata', () => {
        const result = buildOutgoingMessage(input({
            composerText: 'fix it',
            linkedIssue: { number: 3, title: 'Bug', url: 'https://x/issues/3', contextText: 'issue body' },
            linkedLinearIssue: { identifier: 'ENG-12', title: 'Login', url: 'https://linear.app/x/issue/ENG-12', contextText: 'linear body' },
        }), deps());

        expect(result.additionalParts.map((part) => part.text)).toEqual(['issue body', 'linear body']);
        expect(result.additionalParts[0].metadata?.[CONTEXT_METADATA_KEY])
            .toEqual({ kind: 'github-issue', number: 3, title: 'Bug', url: 'https://x/issues/3' });
        expect(result.additionalParts[1].metadata?.[CONTEXT_METADATA_KEY])
            .toEqual({ kind: 'linear-issue', identifier: 'ENG-12', title: 'Login', url: 'https://linear.app/x/issue/ENG-12' });
    });

    test('a linked guest issue is sent as context', () => {
        const result = buildOutgoingMessage(input({
            composerText: 'fix it',
            linkedGuestIssue: {
                providerId: 'hello',
                id: 'HELLO-1',
                title: 'Sample ticket',
                url: 'https://example.com/HELLO-1',
                contextText: 'guest body',
            },
        }), deps());
        expect(result.additionalParts).toHaveLength(1);
        expect(result.additionalParts[0].text).toBe('guest body');
        expect(result.additionalParts[0].metadata?.[CONTEXT_METADATA_KEY])
            .toEqual({
                kind: 'guest-issue',
                providerId: 'hello',
                id: 'HELLO-1',
                title: 'Sample ticket',
                url: 'https://example.com/HELLO-1',
            });
    });

    test('a linked guest issue keeps its opaque data in metadata only', () => {
        const data = { status: 'open', comments: ['hi'] };
        const result = buildOutgoingMessage(input({
            composerText: 'fix it',
            linkedGuestIssue: {
                providerId: 'hello',
                id: 'HELLO-1',
                title: 'Sample ticket',
                url: 'https://example.com/HELLO-1',
                contextText: 'guest body',
                data,
            },
        }), deps());
        expect(result.additionalParts[0].text).toBe('guest body');
        expect(result.additionalParts[0].metadata?.[CONTEXT_METADATA_KEY]).toMatchObject({ kind: 'guest-issue', data });
    });

    test('a linked guest pull is sent as guest-pr context', () => {
        const result = buildOutgoingMessage(input({
            composerText: 'fix it',
            linkedGuestIssue: {
                providerId: 'gitlab',
                id: '!12',
                title: 'Fix login',
                url: 'https://gitlab.com/acme/app/-/merge_requests/12',
                contextText: 'guest pr body',
                thread: 'pull',
            },
        }), deps());
        expect(result.additionalParts).toHaveLength(1);
        expect(result.additionalParts[0].text).toBe('guest pr body');
        expect(result.additionalParts[0].metadata?.[CONTEXT_METADATA_KEY])
            .toEqual({
                kind: 'guest-pr',
                providerId: 'gitlab',
                id: '!12',
                title: 'Fix login',
                url: 'https://gitlab.com/acme/app/-/merge_requests/12',
            });
    });

    test('additional synthetic parts precede the linked references', () => {
        const result = buildOutgoingMessage(input({
            composerText: 'x',
            additionalParts: [{ text: 'conflict note', synthetic: true }],
            linkedIssue: { number: 3, title: 'Bug', url: 'https://x/issues/3', contextText: 'issue body' },
        }), deps());
        expect(result.additionalParts.map((p) => p.text))
            .toEqual(['conflict note', 'issue body']);
    });

    test('skills named inline are collected into a trailing instruction', () => {
        const result = buildOutgoingMessage(input({ composerText: 'use /deploy now' }), deps());
        expect(result.additionalParts.at(-1)).toEqual({ text: 'use: deploy', synthetic: true });
    });

    test('skills named in the composer are collected without duplicates', () => {
        const result = buildOutgoingMessage(input({
            composerText: '/deploy and /audit and /deploy',
        }), deps());
        expect(result.additionalParts.at(-1)?.text).toBe('use: deploy,audit');
    });

    test('no skills means no instruction', () => {
        const result = buildOutgoingMessage(input({ composerText: 'plain text' }), deps());
        expect(result.additionalParts).toEqual([]);
    });

    test('context alone is still worth sending', () => {
        const result = buildOutgoingMessage(input({
            linkedIssue: { number: 3, title: 'Bug', url: 'https://x/issues/3', contextText: 'issue body' },
        }), deps());
        expect(result.isEmpty).toBe(false);
    });

    test('attachments alone are worth sending', () => {
        const result = buildOutgoingMessage(
            input({ composerText: '', composerAttachments: [attachment('pic')] }),
            deps(),
        );
        expect(result.isEmpty).toBe(false);
    });

    test('orders supplied context, linked references, PR instructions and skills', () => {
        const result = buildOutgoingMessage(input({
            composerText: 'typed /deploy',
            additionalParts: [{ text: 'synthetic', synthetic: true }],
            linkedIssue: { number: 3, title: 'Bug', url: 'https://x/issues/3', contextText: 'issue' },
            linkedPr: { number: 7, title: 'PR', url: 'https://x/pr/7', instructions: 'pr-how', context: 'pr-diff' },
            linkedLinearIssue: { identifier: 'ENG-12', title: 'Login', url: 'https://linear.app/x/issue/ENG-12', contextText: 'linear' },
        }), deps());

        expect(result.primaryText).toBe('typed /deploy');
        expect(result.additionalParts.map((part) => part.text)).toEqual([
            'synthetic',
            'issue',
            'pr-how',
            'pr-diff',
            'linear',
            'use: deploy',
        ]);
    });

    test('deduplicates skill instructions collected from the composer body', () => {
        const result = buildOutgoingMessage(
            input({ composerText: '/deploy then /deploy and /audit' }),
            deps(),
        );

        expect(result.additionalParts.at(-1)?.text).toBe('use: deploy,audit');
    });

    test('context without visible text is still sendable', () => {
        const result = buildOutgoingMessage(input({
            linkedIssue: { number: 3, title: 'Bug', url: 'https://x/issues/3', contextText: 'issue body' },
        }), deps());

        expect(result.isEmpty).toBe(false);
    });
});

describe('capturing composer context for the queue', () => {
    const contextInput = (overrides: Partial<ComposerContextInput> = {}): ComposerContextInput => ({
        inlineComments: [],
        additionalParts: [],
        linkedIssue: null,
        linkedPr: null,
        linkedLinearIssue: null,
        linkedGuestIssue: null,
        ...overrides,
    });

    test('captures everything attached, in send order, with the skill instruction last', () => {
        const context = buildComposerContext(contextInput({
            inlineComments: [commentDraft()],
            additionalParts: [{ text: 'conflict note', synthetic: true }],
            linkedIssue: { number: 3, title: 'Bug', url: 'https://x/issues/3', contextText: 'issue' },
            linkedPr: { number: 7, title: 'PR', url: 'https://x/pr/7', instructions: 'pr-how', context: 'pr-diff' },
            linkedLinearIssue: { identifier: 'ENG-12', title: 'Login', url: 'https://linear.app/x/issue/ENG-12', contextText: 'linear' },
        }), 'use: deploy');

        expect(context.map((part) => part.kind)).toEqual(['context', 'synthetic', 'context', 'context', 'context', 'instruction']);
        expect(context[0]?.kind).toBe('context');
        expect(context[0]?.text).toContain('Comment on `src/app.ts` lines 3-5 (modified):');
        expect(context[0]?.kind === 'context' ? context[0].metadata[CONTEXT_METADATA_KEY] : null)
            .toEqual(contextPayloadFromDraft(commentDraft()));
        expect(context[3]).toEqual({
            kind: 'context',
            text: 'pr-diff',
            instructions: 'pr-how',
            metadata: { [CONTEXT_METADATA_KEY]: { kind: 'github-pr', number: 7, title: 'PR', url: 'https://x/pr/7' } },
        });
        expect(context.at(-1)).toEqual({ kind: 'instruction', text: 'use: deploy' });
    });

    test('nothing attached captures nothing', () => {
        expect(buildComposerContext(contextInput(), null)).toEqual([]);
    });

    test('delivering captured context reproduces the composer parts exactly', () => {
        const input = contextInput({
            inlineComments: [commentDraft()],
            additionalParts: [{ text: 'conflict note', synthetic: true }],
            linkedPr: { number: 7, title: 'PR', url: 'https://x/pr/7', instructions: 'pr-how', context: 'pr-diff' },
        });
        const captured: QueuedContextPart[] = buildComposerContext(input, 'use: deploy');
        const direct = buildOutgoingMessage({ ...input, composerText: 'use /deploy', composerAttachments: [] }, deps());
        expect(queuedContextToParts(captured)).toEqual(direct.additionalParts);
    });
});
