import { describe, expect, it } from 'vitest';
import { createAntigravitySubagents } from './subagents.js';
import { createNativeEventPublisher } from '../publisher.js';
import { buildSessionRecord } from '../records.js';

const rootId = 'f1033b7a-88c5-4b77-bbec-6d63ec3a1188';
const childId = '01a0d2a6-b55b-7162-a837-c62053537e00';
const siblingId = '01a0d2a6-b55b-7162-a837-c62053537e01';
const nestedId = '01a0d2a6-b55b-7162-a837-c62053537e02';
const reference = (id) => ({ conversation_id: id, type_name: 'explorer', role: 'Inspect files', initial_prompt: 'Read only' });
const step = (id, body) => ({ event: 'step_update', step_update: { conversation_id: id, step_index: 0, state: 'DONE', step_type: 'subagent', text_delta: '', tool_info: null, ...body } });

describe('Antigravity live subagents', () => {
  it('joins multiple and nested children by live identity and keeps unobserved completion unknown', async () => {
    const events = [];
    let time = 100;
    const publisher = createNativeEventPublisher({ publishNativeEvent: (event) => events.push(event) });
    const controller = createAntigravitySubagents({ publisher, now: () => ++time });
    const process = {};
    const record = buildSessionRecord({ id: `nag_${rootId}`, backend: 'antigravity', directory: '/repo', title: 'Root', created: 1, updated: 1 });
    const owner = { id: record.id, nativeId: rootId, directory: '/repo', record, turn: { process, send: { modelID: 'gemini-4-argon-high' } } };
    await controller.handle(owner, process, step(rootId, { subagent_info: { subagents: [reference(childId), reference(siblingId), reference(rootId), reference('invalid')] } }));
    expect(controller.childrenOf(record.id)).toHaveLength(2);
    expect(controller.session(`nag_${childId}`).metadata.openchamber.native.activityKnown).toBe(false);
    await controller.handle(owner, process, step(childId, { step_type: 'user_input' }));
    await controller.handle(owner, process, step(childId, { step_index: 1, step_type: 'agent_response', state: 'ACTIVE', text_delta: 'Partial' }));
    expect(controller.busyIds('/repo')).toEqual([`nag_${childId}`]);
    await controller.handle(owner, process, step(childId, { step_index: 2, subagent_info: { subagents: [reference(nestedId)] } }));
    expect(controller.childrenOf(`nag_${childId}`)).toMatchObject([{ id: `nag_${nestedId}`, parentID: `nag_${childId}` }]);
    await controller.handle(owner, process, { event: 'result', result: { conversation_id: childId, status: 'SUCCESS', response: 'Partial with tail' } });
    expect(controller.records(`nag_${childId}`).flatMap((r) => r.parts).find((p) => p.type === 'text' && p.text === 'Partial with tail')).toBeDefined();
    controller.release(record.id, process);
    expect(controller.session(`nag_${childId}`).metadata.openchamber.native.activityKnown).toBe(true);
    expect(controller.session(`nag_${siblingId}`).metadata.openchamber.native.activityKnown).toBe(false);
    expect(controller.busyIds('/repo')).toEqual([]);
    const count = controller.records(`nag_${childId}`).length;
    await controller.handle(owner, {}, step(childId, { step_index: 10, step_type: 'agent_response', text_delta: 'stale' }));
    expect(controller.records(`nag_${childId}`)).toHaveLength(count);
    expect(events.some((e) => e.payload.type === 'session.status' && e.payload.properties.sessionID === `nag_${childId}` && e.payload.properties.status.type === 'busy')).toBe(true);
    await controller.handle(owner, process, step('unrelated', { step_type: 'agent_response', text_delta: 'foreign' }));
    expect(controller.session('nag_unrelated')).toBeNull();
  });
});
