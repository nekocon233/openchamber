import { describe, expect, test } from 'bun:test';

import type { AttachedFile } from '@/stores/types/sessionTypes';
import {
    buildOutgoingMessage,
    type OutgoingMessageDeps,
    type OutgoingMessageInput,
} from '../buildOutgoingMessage';

const attachment = (id: string) => ({ id, filename: `${id}.txt` } as unknown as AttachedFile);

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
    appendComments: (text, comments) => `${text}\n[${comments.length} comments]`,
    buildSkillInstruction: (names) => (names.length ? `use: ${names.join(',')}` : null),
    ...overrides,
});

const input = (overrides: Partial<OutgoingMessageInput> = {}): OutgoingMessageInput => ({
    composerText: null,
    composerAttachments: [],
    inlineComments: [],
    syntheticTexts: [],
    linkedIssueContext: null,
    linkedPr: null,
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

describe('composer context', () => {
    test('appends inline comments to the primary composer body', () => {
        const result = buildOutgoingMessage(input({
            composerText: 'body',
            inlineComments: [{}, {}],
        }), deps());

        expect(result.primaryText).toBe('body\n[2 comments]');
    });

    test('orders synthetic context, issue, PR instructions, PR diff, then skills', () => {
        const result = buildOutgoingMessage(input({
            composerText: 'typed /deploy',
            syntheticTexts: ['synthetic'],
            linkedIssueContext: 'issue',
            linkedPr: { instructions: 'pr-how', context: 'pr-diff' },
        }), deps());

        expect(result.primaryText).toBe('typed /deploy');
        expect(result.additionalParts).toEqual([
            { text: 'synthetic', synthetic: true },
            { text: 'issue', synthetic: true },
            { text: 'pr-how', synthetic: true },
            { text: 'pr-diff', synthetic: true },
            { text: 'use: deploy', synthetic: true },
        ]);
    });

    test('deduplicates skill instructions collected from the composer body', () => {
        const result = buildOutgoingMessage(
            input({ composerText: '/deploy then /deploy and /audit' }),
            deps(),
        );

        expect(result.additionalParts.at(-1)?.text).toBe('use: deploy,audit');
    });

    test('treats context without visible text as sendable', () => {
        const result = buildOutgoingMessage(input({ linkedIssueContext: 'issue body' }), deps());

        expect(result.isEmpty).toBe(false);
    });
});
