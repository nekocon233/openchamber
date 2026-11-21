import { describe, expect, test } from 'bun:test';

import { CONTEXT_METADATA_KEY } from '@/lib/messages/contextParts';
import type { Metadata, Part, ReasoningPart, ToolPart } from '@/lib/opencode/model';
import { contextPartsPastCollapse, filterVisibleParts } from './partUtils';

const planExit = (): ToolPart => ({
    id: 'ncx_p_plan', sessionID: 'ncx_s', messageID: 'ncx_a_1', type: 'tool', callID: 'plan-1', tool: 'plan_exit',
    state: { status: 'completed', input: { plan: '# Ship it' }, output: '', title: 'Plan', time: { start: 1, end: 2 } },
});

const question = (kind?: 'claude-plan-exit' | 'codex-plan-exit'): ToolPart => {
    const metadata: Metadata = { questionAnswers: [['build']] };
    if (kind) metadata.nativeQuestionKind = kind;
    return {
        id: 'nci_q', sessionID: 'ncx_s', messageID: 'ncx_a_1', type: 'tool', callID: 'ncq_1', tool: 'question',
        state: {
            status: 'completed',
            input: { questions: [{ question: '# Ship it', header: 'Plan', options: [] }] },
            output: '',
            title: 'Plan',
            metadata,
            time: { start: 1, end: 2 },
        },
    };
};

const reasoning = (): ReasoningPart => ({
    id: 'ncx_r_1', sessionID: 'ncx_s', messageID: 'ncx_a_1', type: 'reasoning', text: 'thinking', time: { start: 1, end: 2 },
});

describe('filterVisibleParts', () => {
    test('shows an answered plan exit once, as the question that kept the answer', () => {
        for (const kind of ['claude-plan-exit', 'codex-plan-exit'] as const) {
            const visible = filterVisibleParts([planExit(), question(kind)]);
            expect(visible.map((part) => part.id)).toEqual(['nci_q']);
        }
    });

    test('keeps the plan exit when nothing recorded an answer for it', () => {
        expect(filterVisibleParts([planExit()]).map((part) => part.id)).toEqual(['ncx_p_plan']);
        expect(filterVisibleParts([planExit(), question()]).map((part) => part.id)).toEqual(['ncx_p_plan', 'nci_q']);
    });

    test('still drops reasoning when it is off, and keeps every other part', () => {
        expect(filterVisibleParts([reasoning(), planExit(), question('codex-plan-exit')], { includeReasoning: false }).map((part) => part.id))
            .toEqual(['nci_q']);
    });
});

const textPart = (id: string, metadata?: Metadata): Part => ({
    id,
    sessionID: 'session',
    messageID: 'message',
    type: 'text',
    text: id,
    metadata,
});

const quote = (id: string, comment = '') => textPart(id, {
    [CONTEXT_METADATA_KEY]: { kind: 'chat-quote', quote: id, text: comment },
});

const sessionMention = (id: string) => textPart(id, {
    [CONTEXT_METADATA_KEY]: { kind: 'session', sessionId: 'ses_other', title: 'Other' },
});

const hiddenIds = (parts: Part[], textLines: number) => [...contextPartsPastCollapse(parts, textLines)].map((part) => part.id);

describe('contextPartsPastCollapse', () => {
    const quotes = [quote('a'), quote('b'), quote('c')];

    test('without text, two context rows stay', () => {
        expect(hiddenIds(quotes, 0)).toEqual(['c']);
    });

    test('one line of text leaves room for one context row', () => {
        expect(hiddenIds([...quotes, textPart('prompt')], 1)).toEqual(['b', 'c']);
    });

    test('two lines of text leave no context rows and never hide the text', () => {
        expect(hiddenIds([...quotes, textPart('prompt')], 2)).toEqual(['a', 'b', 'c']);
    });

    test('a quote with a comment takes two lines', () => {
        expect(hiddenIds([quote('a', 'why?'), quote('b', 'and this?')], 0)).toEqual(['b']);
    });

    test('a quote with a comment that does not fit whole hides it and what follows', () => {
        expect(hiddenIds([quote('a', 'why?'), quote('b'), textPart('prompt')], 1)).toEqual(['a', 'b']);
    });

    test('a session mention draws no row, so it takes no line', () => {
        expect(hiddenIds([sessionMention('m1'), sessionMention('m2'), quote('a'), quote('b')], 0)).toEqual([]);
    });
});
