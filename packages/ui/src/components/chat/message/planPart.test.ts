import { expect, test } from 'bun:test';
import type { AssistantMessage, Metadata, ToolInput, ToolPart } from '@/lib/opencode/model';
import { projectTurnRecords } from '../lib/turns/projectTurnRecords';
import { hasLiveActivity } from '../lib/turns/liveActivity';
import { findFinalPlan, readPlanPart } from './planPart';
import { filterVisibleParts } from './partUtils';

const tool = (id: string, name: string, input: ToolInput, metadata?: Metadata): ToolPart => ({
    id, callID: id, type: 'tool', tool: name, messageID: 'message', sessionID: 'session',
    state: { status: 'completed', input, metadata, output: '', time: { start: 1, end: 2 } },
});
const message = (id: string, parts: ToolPart[]) => ({ info: {
    id, sessionID: 'session', role: 'assistant', time: { created: 2, completed: 3 },
    providerID: 'provider', modelID: 'model', agent: 'plan',
} satisfies AssistantMessage, parts });
const plan = (id: string) => tool(id, 'plan_exit', { plan: `# ${id}` });
const question = (id: string, callID: string) => tool(id, 'question', { questions: [{ question: '# Plan', options: [] }] }, {
    nativeQuestionKind: 'claude-plan-exit', nativePlanCallID: callID, questionAnswers: [['plan']], questionStatus: 'answered',
});
const user = (id: string) => ({ info: { id, role: 'user' as const, sessionID: 'session', time: { created: 1 } }, parts: [] });

test('uses the last proposal within each turn independently', () => {
    const turns = projectTurnRecords([user('u1'), message('first', [plan('old'), plan('latest')]), user('u2'), message('second', [plan('next')])]).turns;
    expect(turns.map((turn) => turn.finalPlan?.part.id)).toEqual(['latest', 'next']);
    expect(turns[0].finalPlan?.callID).toBe('latest');
});

test('restored questions reuse the original plan identity and render it once', () => {
    const original = plan('call');
    const answered = question('answer', original.callID);
    const result = findFinalPlan([message('message', [original, answered])]);
    expect(result?.part).toBe(answered);
    expect(result?.callID).toBe(original.callID);
    expect([...result!.sourcePartIDs]).toEqual(['answer', 'call']);
    expect(filterVisibleParts([original, answered]).map((part) => part.id)).toEqual(['answer']);
});

test('a late answer to an older call cannot replace the newer final proposal', () => {
    const original = plan('old');
    const latest = plan('new');
    const answered = question('answer', original.callID);
    expect(findFinalPlan([message('message', [original, latest, answered])])?.part).toBe(latest);
    expect(filterVisibleParts([original, latest, answered]).map((part) => part.id)).toEqual(['new', 'answer']);
});

test('does not treat ordinary questions, empty plans or MCP names as final plans', () => {
    const parts = [tool('q', 'question', { questions: [{ question: 'Choose a plan' }] }),
        tool('empty', 'plan_exit', { plan: '  ' }), tool('mcp', 'plan_exit', { plan: '# External' }, { openchamberToolSource: 'mcp' })];
    expect(findFinalPlan([message('message', parts)])).toBeUndefined();
    expect(readPlanPart(tool('unknown', 'question', { questions: [{ question: '# Plan' }] }, { nativeQuestionKind: 'plugin-plan-exit' }))).toBeNull();
});

test('a plan-only turn gets no empty activity fold after either representation arrives', () => {
    const original = plan('call');
    for (const parts of [[original], [original, question('answer', original.callID)]]) {
        const turn = projectTurnRecords([user('u'), message('message', parts)]).turns[0];
        expect(hasLiveActivity(turn, false)).toBe(false);
    }
});

test('plan selection remains lazy for long histories and is reused within a turn', () => {
    let reads = 0;
    const input = { get plan() { reads += 1; return '# Final'; } };
    const records = Array.from({ length: 1000 }, (_, index) => [user(`u${index}`), message(`a${index}`, [tool(`p${index}`, 'plan_exit', input)])]).flat();
    const turns = projectTurnRecords(records).turns;
    expect(reads).toBe(0);
    const final = turns[999].finalPlan;
    expect(reads).toBe(1);
    expect(turns[999].finalPlan).toBe(final);
    expect(reads).toBe(1);
});
