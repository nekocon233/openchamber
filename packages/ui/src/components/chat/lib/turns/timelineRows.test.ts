import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, Part, TextPart, ToolPart } from '@/lib/opencode/model';
import { answerChunkCuts } from './answerChunks';
import { projectTurnRecords } from './projectTurnRecords';
import { buildTimelineRows, type TimelineRowsOptions } from './timelineRows';
import type { TimelineEntry } from './timelineEntries';
import type { ChatMessageEntry } from './types';
import { sliceMessageParts } from '../../message/messageSliceContext';

const paragraph = (index: number) => `Paragraph ${index} explains one more step of the call sequence in plain words, long enough to wrap.\n\n`;
const longAnswer = Array.from({ length: 60 }, (_, index) => paragraph(index)).join('');

const textPart = (id: string, text: string, ended = true): Part => {
    const part: TextPart = { type: 'text', id, text, sessionID: 'session', messageID: 'message' };
    if (ended) part.time = { start: 1, end: 2 };
    return part;
};
const readPart: ToolPart = {
    type: 'tool', tool: 'read', id: 'read', callID: 'read', sessionID: 'session', messageID: 'step',
    state: { status: 'completed', input: { filePath: '/project/a.ts' }, output: 'code', metadata: {}, time: { start: 1, end: 2 } },
};

const assistant = (id: string, parts: Part[], finish?: AssistantMessage['finish']): ChatMessageEntry => {
    const info: AssistantMessage = {
        id, sessionID: 'session', role: 'assistant', time: { created: 2, completed: finish ? 3 : undefined },
        modelID: 'model', providerID: 'provider', agent: 'build',
        cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, finish,
    };
    return { info, parts };
};

const turnEntry = (messages: ChatMessageEntry[]): TimelineEntry => {
    const turn = projectTurnRecords([
        { info: { id: 'user', sessionID: 'session', role: 'user', time: { created: 1 } }, parts: [textPart('prompt', 'Explain')] },
        ...messages,
    ]).turns[0]!;
    return { kind: 'turn', key: `turn:${turn.turnId}`, turn, isLastTurn: true };
};

const summary: TimelineRowsOptions = { collapsedActivity: false, expandedTurns: new Map(), showReasoningTraces: true };
const collapsed: TimelineRowsOptions = { collapsedActivity: true, expandedTurns: new Map(), showReasoningTraces: true };

describe('answerChunkCuts', () => {
    test('leaves a short text whole', () => {
        expect(answerChunkCuts(paragraph(1).repeat(10))).toEqual([]);
    });

    test('cuts a long text only where a paragraph starts, into pieces that join back', () => {
        const cuts = answerChunkCuts(longAnswer);
        expect(cuts.length).toBeGreaterThan(1);
        for (const cut of cuts) expect(longAnswer.slice(cut).startsWith('Paragraph ')).toBe(true);
        const pieces = [0, ...cuts].map((start, index) => longAnswer.slice(start, cuts[index]));
        expect(pieces.join('')).toBe(longAnswer);
    });

    test('never starts a piece at a list, a code block or a table', () => {
        const text = Array.from({ length: 40 }, (_, index) => `${paragraph(index)}- item ${index}\n- next\n\n\`\`\`ts\nconst a = ${index};\n\`\`\`\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n`).join('');
        const cuts = answerChunkCuts(text);
        expect(cuts.length).toBeGreaterThan(0);
        for (const cut of cuts) expect(text.slice(cut).startsWith('Paragraph ')).toBe(true);
    });

    test('leaves a text with footnotes or link definitions whole', () => {
        expect(answerChunkCuts(`${longAnswer}[^1]: The note.\n`)).toEqual([]);
        expect(answerChunkCuts(`${longAnswer}[docs]: https://example.com\n`)).toEqual([]);
    });
});

describe('buildTimelineRows', () => {
    test('draws a turn as its prompt row and a row per step', () => {
        const rows = buildTimelineRows([turnEntry([
            assistant('step', [readPart, textPart('note', 'Reading')], 'tool-calls'),
            assistant('answer', [textPart('final', 'Done')], 'stop'),
        ])], summary, []);
        expect(rows.map((row) => row.key)).toEqual(['turn:user', 'step:step', 'step:answer']);
        expect(rows.map((row) => row.kind !== 'ungrouped' && row.gapBelow)).toEqual([false, false, true]);
    });

    test('cuts a finished long answer into rows that name their slice', () => {
        const rows = buildTimelineRows([turnEntry([assistant('answer', [textPart('final', longAnswer)], 'stop')])], summary, []);
        const cuts = answerChunkCuts(longAnswer);
        expect(rows.map((row) => row.key)).toEqual([
            'turn:user', 'step:answer', ...cuts.map((cut) => `step:answer:final:${cut}`),
        ]);
        const slices = rows.flatMap((row) => (row.kind === 'turn-message' ? [row.slice] : []));
        expect(slices[0]).toEqual({ to: { partId: 'final', offset: cuts[0] }, index: 0, count: cuts.length + 1 });
        expect(slices.at(-1)).toEqual({ from: { partId: 'final', offset: cuts.at(-1)! }, index: cuts.length, count: cuts.length + 1 });
    });

    test('cuts a step that ran dozens of calls into rows of parts, while it still runs', () => {
        const calls: Part[] = Array.from({ length: 30 }, (_, index) => ({ ...readPart, id: `read-${index}`, callID: `read-${index}` }));
        const rows = buildTimelineRows([turnEntry([assistant('step', calls)])], summary, []);
        expect(rows.map((row) => row.key)).toEqual(['turn:user', 'step:step', 'step:step:read-24:0']);
        expect(rows[1]?.kind === 'turn-message' && rows[1].slice).toEqual({ to: { partId: 'read-24', offset: 0 }, index: 0, count: 2 });
    });

    test('keeps an answer still being written in one row', () => {
        const rows = buildTimelineRows([turnEntry([assistant('answer', [textPart('final', longAnswer, false)])])], summary, []);
        expect(rows.map((row) => row.key)).toEqual(['turn:user', 'step:answer']);
    });

    test('under a closed fold, the steps are the fold row and the answer follows it', () => {
        const entry = turnEntry([
            assistant('step', [readPart], 'tool-calls'),
            assistant('answer', [textPart('final', 'Done')], 'stop'),
        ]);
        const rows = buildTimelineRows([entry], collapsed, []);
        expect(rows.map((row) => row.key)).toEqual(['turn:user', 'fold:user', 'step:answer']);
        expect(rows.every((row) => row.kind === 'ungrouped' || row.underFold)).toBe(true);
        // The fold leaves out the answer these rows name, not one it finds on its own.
        expect(rows.every((row) => row.kind === 'ungrouped' || row.finalMessageId === 'answer')).toBe(true);
        expect(rows.at(-1)?.kind === 'turn-message' && rows.at(-1)).toMatchObject({ final: true });

        const opened = buildTimelineRows([entry], { ...collapsed, expandedTurns: new Map([['user', true]]) }, []);
        expect(opened.map((row) => row.key)).toEqual(['turn:user', 'fold:user', 'step:step', 'step:answer']);
    });

    test('keeps the row objects that did not change', () => {
        const entry = turnEntry([assistant('answer', [textPart('final', 'Done')], 'stop')]);
        const first = buildTimelineRows([entry], summary, []);
        expect(buildTimelineRows([entry], summary, first)).toBe(first);
        const opened = buildTimelineRows([entry], { ...summary, collapsedActivity: true }, first);
        expect(opened[0]).toBe(first[0]);
    });
});

describe('message slice content', () => {
    test('joins text cuts back into the complete answer and keeps tools once', () => {
        const parts = [readPart, textPart('long', longAnswer), textPart('last', 'The last paragraph.')];
        const rows = buildTimelineRows([turnEntry([assistant('answer', parts, 'stop')])], summary, [])
            .filter((row) => row.kind === 'turn-message');
        expect(rows.length).toBeGreaterThan(1);
        const drawn = rows.flatMap((row) => sliceMessageParts(parts, row.slice));
        expect(drawn.filter((part) => part.type === 'tool').map((part) => part.id)).toEqual(['read']);
        expect(drawn.flatMap((part) => part.type === 'text' ? [part.text] : []).join(''))
            .toBe(`${longAnswer}The last paragraph.`);
        expect(parts[1]).toEqual(textPart('long', longAnswer));
    });

    test('draws a 236-part native reply once across its ten rows', () => {
        const parts: Part[] = Array.from({ length: 236 }, (_, index) => ({ ...readPart, id: `call-${index}`, callID: `call-${index}` }));
        const rows = buildTimelineRows([turnEntry([assistant('answer', parts, 'stop')])], summary, [])
            .filter((row) => row.kind === 'turn-message');
        expect(rows.length).toBe(10);
        const drawn = rows.flatMap((row) => sliceMessageParts(parts, row.slice));
        expect(drawn.map((part) => part.id)).toEqual(parts.map((part) => part.id));
    });

    test('keeps streaming text whole until completion introduces text cuts', () => {
        const streaming = [textPart('long', longAnswer, false)];
        const liveRows = buildTimelineRows([turnEntry([assistant('answer', streaming)])], summary, [])
            .filter((row) => row.kind === 'turn-message');
        expect(liveRows.length).toBe(1);
        expect(sliceMessageParts(streaming, liveRows[0].slice)).toBe(streaming);
        const completed = [textPart('long', longAnswer)];
        const finishedRows = buildTimelineRows([turnEntry([assistant('answer', completed, 'stop')])], summary, [])
            .filter((row) => row.kind === 'turn-message');
        expect(finishedRows.length).toBeGreaterThan(1);
        expect(finishedRows.flatMap((row) => sliceMessageParts(completed, row.slice))
            .map((part) => part.type === 'text' ? part.text : '').join('')).toBe(longAnswer);
    });

    test('does not draw the whole message when a stale row names an absent boundary', () => {
        expect(sliceMessageParts([readPart], { from: { partId: 'missing', offset: 0 }, index: 1, count: 2 })).toEqual([]);
        expect(sliceMessageParts([readPart], { to: { partId: 'missing', offset: 0 }, index: 0, count: 2 })).toEqual([]);
    });
});
