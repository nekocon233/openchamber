import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AttachedFile } from '@/stores/types/sessionTypes';
import type { InlineCommentDraft } from '@/stores/useInlineCommentDraftStore';
import { CONTEXT_METADATA_KEY, contextPayloadFromDraft } from '@/lib/messages/contextParts';
import type { QueuedContextPart, QueuedMessage } from '@/stores/messageQueueStore';
import {
    buildComposerContext,
    buildOutgoingMessage,
    expandCommentSnippets,
    queuedContextToParts,
    selectComposerQueue,
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
    ...overrides,
});

const input = (overrides: Partial<OutgoingMessageInput> = {}): OutgoingMessageInput => ({
    composerText: null,
    composerAttachments: [],
    inlineComments: [],
    syntheticTexts: [],
    references: [],
    ...overrides,
});

describe('composer content', () => {
    test('keeps the composer text primary with its attachments and synthetic context', () => {
        const result = buildOutgoingMessage(input({
            composerText: '@agent:build message A',
            composerAttachments: [attachment('current')],
            syntheticTexts: ['A context'],
        }), deps());

        expect(result.primaryText).toBe('message A');
        expect(result.primaryAttachments.map((file) => file.id)).toEqual(['current']);
        expect(result.agentMentionName).toBe('build');
        expect(result.additionalParts).toEqual([{ text: 'A context', synthetic: true }]);
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

describe('manual queue projection', () => {
    const item = (overrides: Partial<QueuedMessage> = {}): QueuedMessage => ({
        id: 'ordinary',
        messageId: 'message-1',
        content: 'User follow up',
        createdAt: 1,
        status: 'queued',
        sendConfig: { providerID: 'openai', modelID: 'chosen', agent: 'plan' },
        ...overrides,
    });
    const scheduledTask = { projectId: 'project-1', taskId: 'task-1' };

    test('a scheduled entry is excluded and contributes no captured configuration', () => {
        const ordinary = item();
        const scheduled = item({ id: 'scheduled', sendConfig: { providerID: 'other', modelID: 'other' }, scheduledTask });
        const projection = selectComposerQueue([scheduled, ordinary]);
        expect(projection).toEqual([ordinary]);
        expect(projection[0]?.sendConfig).toBe(ordinary.sendConfig);
    });

    test('a scheduled-only queue has no manual sendable content', () => {
        expect(selectComposerQueue([item({ id: 'scheduled', scheduledTask })])).toHaveLength(0);
    });

    test('ordinary queues keep their original items, order and identity', () => {
        const queue = [item(), item({ id: 'second' })];
        expect(selectComposerQueue(queue)).toBe(queue);
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
            syntheticTexts: ['conflict note'],
        }), deps());

        expect(result.additionalParts.map((part) => part.text.startsWith('Comment on') ? 'comment' : part.text))
            .toEqual(['comment', 'conflict note']);
    });
});

describe('synthetic context', () => {
    test('a linked PR is sent as its context only, with no instructions guessing the intent', () => {
        const result = buildOutgoingMessage(input({
            composerText: 'review this',
            references: [{ kind: 'change-request', provider: 'gitlab', number: 7, title: 'MR', url: 'https://x/mr/7', context: 'the diff' }],
        }), deps());
        expect(result.additionalParts.map((p) => p.text)).toEqual(['the diff']);
        expect(result.additionalParts.every((p) => p.synthetic)).toBe(true);
        // The provider rides the metadata, so the message shows `MR !7`.
        expect(result.additionalParts[0].metadata?.[CONTEXT_METADATA_KEY])
            .toEqual({ kind: 'change-request', provider: 'gitlab', number: 7, title: 'MR', url: 'https://x/mr/7' });
    });

    test('linked issues retain structured context metadata', () => {
        const result = buildOutgoingMessage(input({
            composerText: 'fix it',
            references: [{ kind: 'repository-issue', number: 3, title: 'Bug', url: 'https://x/issues/3', contextText: 'issue body' }],
        }), deps());
        expect(result.additionalParts).toHaveLength(1);
        expect(result.additionalParts[0].text).toBe('issue body');
        expect(result.additionalParts[0].metadata?.[CONTEXT_METADATA_KEY])
            .toEqual({ kind: 'repository-issue', number: 3, title: 'Bug', url: 'https://x/issues/3' });
    });

    test('a linked Linear issue is sent as context', () => {
        const result = buildOutgoingMessage(input({
            composerText: 'fix it',
            references: [{ kind: 'linear-issue', identifier: 'ENG-12', title: 'Login', url: 'https://linear.app/x/issue/ENG-12', contextText: 'linear body' }],
        }), deps());
        expect(result.additionalParts).toHaveLength(1);
        expect(result.additionalParts[0].text).toBe('linear body');
        expect(result.additionalParts[0].metadata?.[CONTEXT_METADATA_KEY])
            .toEqual({ kind: 'linear-issue', identifier: 'ENG-12', title: 'Login', url: 'https://linear.app/x/issue/ENG-12' });
    });

    test('a linked guest issue is sent as context', () => {
        const result = buildOutgoingMessage(input({
            composerText: 'fix it',
            references: [{
                kind: 'guest',
                providerId: 'hello',
                id: 'HELLO-1',
                title: 'Sample ticket',
                url: 'https://example.com/HELLO-1',
                contextText: 'guest body',
            }],
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
            references: [{
                kind: 'guest',
                providerId: 'hello',
                id: 'HELLO-1',
                title: 'Sample ticket',
                url: 'https://example.com/HELLO-1',
                contextText: 'guest body',
                data,
            }],
        }), deps());
        expect(result.additionalParts[0].text).toBe('guest body');
        expect(result.additionalParts[0].metadata?.[CONTEXT_METADATA_KEY]).toMatchObject({ kind: 'guest-issue', data });
    });

    test('a linked guest pull is sent as guest-pr context', () => {
        const result = buildOutgoingMessage(input({
            composerText: 'fix it',
            references: [{
                kind: 'guest',
                providerId: 'gitlab',
                id: '!12',
                title: 'Fix login',
                url: 'https://gitlab.com/acme/app/-/merge_requests/12',
                contextText: 'guest pr body',
                thread: 'pull',
            }],
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
            syntheticTexts: ['conflict note'],
            references: [{ kind: 'repository-issue', number: 3, title: 'Bug', url: 'https://x/issues/3', contextText: 'issue body' }],
        }), deps());
        expect(result.additionalParts.map((p) => p.text))
            .toEqual(['conflict note', 'issue body']);
    });

    // Skills are attached to the prompt by the send, not written into it.
    test('skills named inline are reported, not turned into a part', () => {
        const result = buildOutgoingMessage(input({ composerText: 'use /deploy now' }), deps());
        expect(result.skillNames).toEqual(['deploy']);
        expect(result.additionalParts).toEqual([]);
    });

    test('skills named in the composer are collected in order without duplicates', () => {
        const result = buildOutgoingMessage(input({
            composerText: '/deploy and /audit and /deploy',
        }), deps());
        expect(result.skillNames).toEqual(['deploy', 'audit']);
    });

    test('context alone is still worth sending', () => {
        const result = buildOutgoingMessage(input({
            references: [{ kind: 'repository-issue', number: 3, title: 'Bug', url: 'https://x/issues/3', contextText: 'issue body' }],
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
});

describe('several references', () => {
    test('each becomes its own context part, in the order they were attached', () => {
        const result = buildOutgoingMessage(input({
            composerText: 'compare',
            references: [
                { kind: 'linear-issue', identifier: 'ENG-1', title: 'A', url: 'https://linear.app/x/issue/ENG-1', contextText: 'linear' },
                { kind: 'repository-issue', number: 3, title: 'Bug', url: 'https://x/issues/3', contextText: 'issue 3' },
                { kind: 'repository-issue', number: 4, title: 'Bug', url: 'https://x/issues/4', contextText: 'issue 4' },
                { kind: 'guest', providerId: 'jira', id: 'OPS-2', title: 'Ops', url: 'https://jira/OPS-2', contextText: 'jira' },
            ],
        }), deps());
        expect(result.additionalParts.map((p) => p.text)).toEqual(['linear', 'issue 3', 'issue 4', 'jira']);
    });
});

describe('full assembly order', () => {
    test('synthetic context, then references, with skills reported separately', () => {
        const result = buildOutgoingMessage(input({
            composerText: 'typed /deploy',
            syntheticTexts: ['synthetic'],
            references: [
                { kind: 'repository-issue', number: 3, title: 'Bug', url: 'https://x/issues/3', contextText: 'issue' },
                { kind: 'change-request', provider: 'github', number: 7, title: 'PR', url: 'https://x/pr/7', context: 'pr-diff' },
                { kind: 'linear-issue', identifier: 'ENG-12', title: 'Login', url: 'https://linear.app/x/issue/ENG-12', contextText: 'linear' },
            ],
        }), deps());

        expect(result.primaryText).toBe('typed /deploy');
        expect(result.additionalParts.map((p) => p.text)).toEqual([
            'synthetic',
            'issue',
            'pr-diff',
            'linear',
        ]);
        expect(result.skillNames).toEqual(['deploy']);
    });

    test('deduplicates skill instructions collected from the composer body', () => {
        const result = buildOutgoingMessage(
            input({ composerText: '/deploy then /deploy and /audit' }),
            deps(),
        );

        expect(result.skillNames).toEqual(['deploy', 'audit']);
        expect(result.additionalParts).toEqual([]);
    });

    test('context without visible text is still sendable', () => {
        const result = buildOutgoingMessage(input({
            references: [{ kind: 'repository-issue', number: 3, title: 'Bug', url: 'https://x/issues/3', contextText: 'issue body' }],
        }), deps());

        expect(result.isEmpty).toBe(false);
    });
});

describe('capturing composer context for the queue', () => {
    const contextInput = (overrides: Partial<ComposerContextInput> = {}): ComposerContextInput => ({
        inlineComments: [],
        syntheticTexts: [],
        references: [],
        ...overrides,
    });

    test('captures everything attached, in send order, with the skill instruction last', () => {
        const context = buildComposerContext(contextInput({
            inlineComments: [commentDraft()],
            syntheticTexts: ['conflict note'],
            references: [
                { kind: 'repository-issue', number: 3, title: 'Bug', url: 'https://x/issues/3', contextText: 'issue' },
                { kind: 'change-request', provider: 'github', number: 7, title: 'PR', url: 'https://x/pr/7', context: 'pr-diff' },
                { kind: 'linear-issue', identifier: 'ENG-12', title: 'Login', url: 'https://linear.app/x/issue/ENG-12', contextText: 'linear' },
            ],
        }), 'use: deploy');

        expect(context.map((part) => part.kind)).toEqual(['context', 'synthetic', 'context', 'context', 'context', 'instruction']);
        expect(context[0]?.kind).toBe('context');
        expect(context[0]?.text).toContain('Comment on `src/app.ts` lines 3-5 (modified):');
        expect(context[0]?.kind === 'context' ? context[0].metadata[CONTEXT_METADATA_KEY] : null)
            .toEqual(contextPayloadFromDraft(commentDraft()));
        expect(context[3]).toEqual({
            kind: 'context',
            text: 'pr-diff',
            metadata: { [CONTEXT_METADATA_KEY]: { kind: 'change-request', provider: 'github', number: 7, title: 'PR', url: 'https://x/pr/7' } },
        });
        expect(context.at(-1)).toEqual({ kind: 'instruction', text: 'use: deploy' });
    });

    test('a message queued with instructions before they were dropped still delivers them first', () => {
        const metadata = { [CONTEXT_METADATA_KEY]: { kind: 'change-request' as const, provider: 'github' as const, number: 7, title: 'PR', url: 'https://x/pr/7' } };
        expect(queuedContextToParts([{ kind: 'context', text: 'pr-diff', instructions: 'pr-how', metadata }])).toEqual([
            { text: 'pr-how', synthetic: true },
            { text: 'pr-diff', synthetic: true, metadata },
        ]);
    });

    test('nothing attached captures nothing', () => {
        expect(buildComposerContext(contextInput(), null)).toEqual([]);
    });

    test('delivering captured context reproduces the composer parts exactly', () => {
        const input = contextInput({
            inlineComments: [commentDraft()],
            syntheticTexts: ['conflict note'],
            references: [{ kind: 'change-request', provider: 'github', number: 7, title: 'PR', url: 'https://x/pr/7', context: 'pr-diff' }],
        });
        // The skill instruction is the one intended difference: a direct send
        // attaches the skill to the prompt, a queued one carries the instruction.
        const captured: QueuedContextPart[] = buildComposerContext(input, null);
        const direct = buildOutgoingMessage({ ...input, composerText: 'use /deploy', composerAttachments: [] }, deps());
        expect(queuedContextToParts(captured)).toEqual(direct.additionalParts);
    });
});

const chatInputSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'ChatInput.tsx'), 'utf-8');

const LINKED_REFERENCE_KINDS = ['linkedReferences'];

/** Lift one predicate out of the composer source: the code under test is the parameter source. */
const gateExpression = (pattern: RegExp, what: string): string => {
    const match = pattern.exec(chatInputSource);
    if (!match) throw new Error('ChatInput.tsx no longer holds ' + what);
    return match[1];
};

/** Every value in the file that is derived from the linked references. */
const linkedReferenceValues = (): string[] => {
    const names: string[] = [];
    for (const match of chatInputSource.matchAll(/const (\w+) = ([^;\n]*);/g)) {
        const [, name, expression] = match;
        if (LINKED_REFERENCE_KINDS.every((kind) => expression.includes(kind))) names.push(name);
    }
    return names;
};

/**
 * True when a predicate counts a linked reference: it names the reference list
 * directly, or it reads a value derived from it. The assertion follows that
 * intent rather than one variable name, so inlining the value back into the
 * predicates stays green while a predicate that stops counting stays red.
 */
const countsLinkedReference = (predicate: string): boolean =>
    LINKED_REFERENCE_KINDS.some((kind) => predicate.includes(kind))
    || linkedReferenceValues().some((name) => predicate.includes(name));

/** The condition the builder strips linked references with, read from the builder call itself. */
const builderStripGuard = gateExpression(/references: (\w+) \? \[\] : linkedReferences/, 'the builder strip on linked references');

describe('the composer send gate counts what the submission builder counts', () => {
    // ChatInput cannot be mounted in bun test: its import graph pulls the composer editor,
    // Vite worker URLs and every runtime store. The gate is guarded at the source, the way
    // the neighbouring composer regression tests guard theirs.
    test('queue counts use the ordinary-only projection', () => {
        expect(gateExpression(/const composerQueuedMessages = ([^;\n]*);/, 'the manual queue projection'))
            .toBe('selectComposerQueue(queuedMessages)');
        expect(gateExpression(/const hasQueuedMessages = ([^;\n]*);/, 'the manual queue content gate'))
            .toContain('composerQueuedMessages.length > 0');
    });

    test('every predicate the composer sends with counts a linked reference', () => {
        const gates = [
            gateExpression(/const hasContent = ([^;\n]*);/, 'the send-button gate'),
            gateExpression(/hasContent: (currentMessage\.trim\(\)[^,\n]*),/, 'the submit guard predicate'),
            gateExpression(/hasContent: (options\.presetText\.trim\(\)[^,\n]*),/, 'the preset snapshot predicate'),
        ];

        for (const gate of gates) {
            expect(countsLinkedReference(gate)).toBe(true);
            // The builder drops the linked context in that mode, so the gate must too.
            expect(gate).toContain(builderStripGuard);
        }
    });

    test('the submit guard recomputes when a linked reference changes', () => {
        expect(countsLinkedReference(gateExpression(
            /const getCurrentInputSnapshot = React\.useCallback\(\(\) => \{([\s\S]*?)\n {4}\}, \[/,
            'the submit guard body',
        ))).toBe(true);
        expect(countsLinkedReference(gateExpression(
            /const getCurrentInputSnapshot = React\.useCallback\(\(\) => \{[\s\S]*?\n {4}\}, ([^)]*)\);/,
            'the submit guard dependencies',
        ))).toBe(true);
    });

    test('a linked reference on its own is a message, and nothing at all is still empty', () => {
        expect(buildOutgoingMessage(input(), deps()).isEmpty).toBe(true);

        const onlyLinked: Partial<OutgoingMessageInput>[] = [
            { references: [{ kind: 'repository-issue', number: 12, title: 'Attached', url: 'https://github.com/acme/app/issues/12', contextText: 'body' }] },
            { references: [{ kind: 'change-request', provider: 'github', number: 34, title: 'Attached', url: 'https://github.com/acme/app/pull/34', context: 'body' }] },
            { references: [{ kind: 'linear-issue', identifier: 'ENG-1', title: 'Attached', url: 'https://linear.app/acme/issue/ENG-1', contextText: 'body' }] },
            { references: [{ kind: 'guest', providerId: 'guest.example', id: 'guest-1', title: 'Attached', url: 'https://example.com/issues/1', contextText: 'body' }] },
        ];

        for (const linked of onlyLinked) {
            const built = buildOutgoingMessage(input(linked), deps());
            expect(built.isEmpty).toBe(false);
            expect(built.additionalParts.map((part) => part.text)).toContain('body');
        }
    });
});


describe('expandCommentSnippets', () => {
    const draft = (text: string, code = 'see #review here'): InlineCommentDraft => ({
        id: text,
        sessionKey: 's',
        source: 'chat-quote',
        fileLabel: 'm1',
        startLine: 1,
        endLine: 1,
        code,
        language: '',
        text,
        createdAt: 0,
    });
    const expandText = async (text: string) => text.replace('#review', 'Review this carefully.');

    test('expands the comment words and leaves the quote verbatim', async () => {
        const [expanded] = await expandCommentSnippets([draft('#review please')], expandText);
        expect(expanded.text).toBe('Review this carefully. please');
        expect(expanded.code).toBe('see #review here');
    });

    test('keeps a comment as written when expansion fails', async () => {
        const original = draft('#review please');
        const [kept] = await expandCommentSnippets([original], async () => {
            throw new Error('offline');
        });
        expect(kept).toBe(original);
    });
});
