import { describe, expect, test } from 'bun:test';

import type { AttachedFile } from '@/stores/types/sessionTypes';
import type { InlineCommentDraft } from '@/stores/useInlineCommentDraftStore';
import { CONTEXT_METADATA_KEY, contextPayloadFromDraft } from '@/lib/messages/contextParts';
import {
    buildOutgoingMessage,
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
    ...overrides,
});

describe('composer content', () => {
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
