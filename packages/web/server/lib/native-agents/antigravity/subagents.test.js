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
  it('publishes a completed child generation thinking while the child remains busy', async () => {
    const events = [];
    const publisher = createNativeEventPublisher({ publishNativeEvent: (event) => events.push(event) });
    const controller = createAntigravitySubagents({ publisher, now: () => 100, loadHistory: async () => null,
      readReasoning: (nativeId) => nativeId === childId ? [{ step_index: 1, status: 'DONE', type: 'PLANNER_RESPONSE', thinking: 'Inspect the child inputs.' }] : [],
    });
    const process = {};
    const record = buildSessionRecord({ id: 'nag_' + rootId, backend: 'antigravity', directory: '/repo', title: 'Root', created: 1, updated: 1 });
    const owner = { id: record.id, nativeId: rootId, directory: '/repo', record, turn: { process } };
    await controller.handle(owner, process, step(rootId, { subagent_info: { subagents: [reference(childId)] } }));
    await controller.handle(owner, process, step(childId, { step_index: 1, step_type: 'agent_response', state: 'DONE', text_delta: 'Working' }));
    expect(controller.busyIds('/repo')).toContain('nag_' + childId);
    expect(controller.records('nag_' + childId)[1].parts.map((part) => part.type)).toEqual(['reasoning', 'text']);
    expect(events.some((event) => event.payload.type === 'message.part.updated' && event.payload.properties.part.type === 'reasoning')).toBe(true);
    expect(events.some((event) => event.payload.type === 'session.idle')).toBe(false);
  });

  it('recovers completed child write content and bounds retry reads when preview input stays truncated', async () => {
    const publisher = createNativeEventPublisher({ publishNativeEvent: () => {} });
    let reads = 0;
    const controller = createAntigravitySubagents({ publisher, now: () => 100, loadHistory: async () => null,
      readReasoning: (nativeId) => {
        reads += 1;
        return nativeId === childId ? [{ step_index: 1, status: 'DONE', type: 'PLANNER_RESPONSE',
          truncated_fields: reads < 4 ? ['tool_calls'] : [],
          tool_calls: [
            { name: 'write_file', args: { Path: '/repo/child.ts', Content: 'export const child = 1;\n' }, argumentsEncoded: false },
            { name: 'run_command', args: { CommandLine: 'first' }, argumentsEncoded: false },
            { name: 'run_command', args: { CommandLine: 'second' }, argumentsEncoded: false },
          ] }] : [];
      },
    });
    const process = {};
    const record = buildSessionRecord({ id: 'nag_' + rootId, backend: 'antigravity', directory: '/repo', title: 'Root', created: 1, updated: 1 });
    const owner = { id: record.id, nativeId: rootId, directory: '/repo', record, turn: { process } };
    await controller.handle(owner, process, step(rootId, { subagent_info: { subagents: [reference(childId)] } }));
    await controller.handle(owner, process, step(childId, { step_index: 1, step_type: 'agent_response', state: 'DONE', text_delta: '' }));
    await controller.handle(owner, process, step(childId, { step_index: 2, step_type: 'tool', state: 'DONE',
      tool_info: { name: 'write_file', parameters: { Path: '/repo/child.ts' }, output: '', error: null } }));
    await controller.handle(owner, process, step(childId, { step_index: 3, step_type: 'tool', state: 'DONE',
      tool_info: { name: 'run_command', parameters: { CommandLine: 'first' }, output: 'Command exited with code 0.\nok', error: null } }));
    expect(reads).toBe(3);
    // Retry was spent on step 3, so step 4 does not re-read the transcript.
    await controller.handle(owner, process, step(childId, { step_index: 4, step_type: 'tool', state: 'DONE',
      tool_info: { name: 'run_command', parameters: { CommandLine: 'second' }, output: 'Command exited with code 0.\nok', error: null } }));
    expect(reads).toBe(3);
    controller.refreshReasoning('nag_' + childId);
    const write = controller.records('nag_' + childId)[1].parts.find((part) => part.type === 'tool');
    expect(write.state.input).toEqual({ filePath: '/repo/child.ts', content: 'export const child = 1;\n' });
  });

  it('joins multiple and nested children by live identity and keeps unobserved completion unknown', async () => {
    const events = [];
    let time = 100;
    const publisher = createNativeEventPublisher({ publishNativeEvent: (event) => events.push(event) });
    const controller = createAntigravitySubagents({ publisher, now: () => ++time, loadHistory: async () => null, readReasoning: () => [] });
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
