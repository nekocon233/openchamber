import { describe, expect, test } from 'bun:test';
import type { Metadata, ReasoningPart, ToolPart } from '@/lib/opencode/model';

import { filterVisibleParts } from './partUtils';

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
