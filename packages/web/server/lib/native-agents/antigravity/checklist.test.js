import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { antigravityChecklistSnapshot, AGY_CHECKLIST_PART_TOOL } from './checklist.js';
import { parseChecklistInput, checklistReceipt } from './checklist-protocol.mjs';
import { parseAgyTranscript } from './protocol.js';
import { projectAntigravityHistory, createAntigravityLiveProjection } from './projector.js';
import { createNativeEventPublisher } from '../publisher.js';

const nativeId = 'f1033b7a-88c5-4b77-bbec-6d63ec3a1188';
const sessionId = `nag_${nativeId}`;
const input = (status = 'pending') => ({ todos: [{ id: 'verify', content: 'Verify checklist integration', status }] });
const call = (value) => ({ name: 'call_mcp_tool', argumentsEncoded: false,
  args: { ServerName: 'openchamber_checklist', ToolName: 'update_checklist', Arguments: value } });
const project = (value, index = 1, output = checklistReceipt(value), extra = {}) => projectAntigravityHistory({
  sessionId, nativeId, directory: '/repo', bindings: new Map(), entries: [
    { step_index: 0, type: 'USER_INPUT', content: 'Work', created_at: '2026-11-05T00:00:00Z' },
    { step_index: index, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [call(value)], truncated_fields: [] },
    { step_index: index + 1, type: 'GENERIC', status: 'DONE', content: output, ...extra },
  ],
});
const snapshot = (records, complete = true) => antigravityChecklistSnapshot({ sessionId, records, complete, observedAt: 1 });

describe('Antigravity transcript-owned checklist', () => {
  it('distinguishes an absent list, committed progress and an explicit empty write', () => {
    expect(snapshot([])).toEqual({ state: 'unavailable', reason: 'source_unknown' });
    expect(snapshot(project(input()))).toMatchObject({ state: 'ready', revision: 3, complete: true,
      items: [{ id: 'verify', subject: 'Verify checklist integration', status: 'pending' }] });
    const records = [...project(input()), ...project(input('completed'), 4), ...project({ todos: [] }, 7)];
    expect(snapshot(records)).toMatchObject({ state: 'ready', revision: 9, items: [], complete: true });
    expect(snapshot([...records, ...project(input())])).toMatchObject({ revision: 9, items: [] });
  });

  it('never commits a failed, truncated or unconfirmed list over an earlier valid list', () => {
    const records = project(input());
    expect(snapshot([...records, ...project(input('completed'), 4, 'Denied', { status: 'ERROR' })]))
      .toMatchObject({ complete: true, items: [{ status: 'pending' }] });
    const partial = project(input('completed'), 4, 'Native output was cut');
    expect(snapshot([...records, ...partial])).toMatchObject({ complete: false, unreadable: 1, items: [{ status: 'pending' }] });
    expect(() => snapshot(partial)).toThrow('incomplete');
    expect(snapshot(records, false)).toMatchObject({ complete: false, items: [{ status: 'pending' }] });
  });

  it('recovers the real CLI wrapper and receipt from JSON-encoded preview logs', () => {
    const args = Object.fromEntries(Object.entries(call(input()).args).map(([key, value]) => [key, JSON.stringify(value)]));
    const entries = parseAgyTranscript([
      { step_index: 0, type: 'USER_INPUT', content: 'Work' },
      { step_index: 1, type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'call_mcp_tool', args }] },
      { step_index: 2, type: 'GENERIC', content: `Created At: recorded\nCompleted At: recorded\n${checklistReceipt(input())}` },
    ].map((entry) => JSON.stringify({ status: 'DONE', ...entry })).join('\n') + '\n').entries;
    const records = projectAntigravityHistory({ sessionId, nativeId, directory: '/repo', bindings: new Map(), entries });
    expect(snapshot(records)).toMatchObject({ complete: true, items: [{ status: 'pending' }] });
    records[1].parts[0].state.metadata.nativeInputTruncated = true;
    expect(() => snapshot(records)).toThrow('incomplete');
  });

  it('publishes a completed live update once and isolates another MCP server', async () => {
    const events = [];
    const publisher = createNativeEventPublisher({ publishNativeEvent: (event) => events.push(event) });
    const projection = createAntigravityLiveProjection({ sessionId, nativeId, directory: '/repo', publisher,
      request: { messageID: 'accepted', sentAt: 1, model: { providerID: 'antigravity-native', modelID: 'test' }, agent: 'build', parts: [] } });
    const step = { step_index: 2, step_type: 'tool', state: 'DONE',
      tool_info: { name: 'call_mcp_tool', parameters: call(input()).args, output: checklistReceipt(input()), error: null } };
    await projection.applyStep(step, 3, async () => {});
    await projection.applyStep(step, 4, async () => {});
    expect(events.filter((event) => event.payload.type === 'session.checklist.updated')).toHaveLength(1);
    const part = projection.records().flatMap((record) => record.parts).find((candidate) => candidate.tool === AGY_CHECKLIST_PART_TOOL);
    expect(part.state.metadata.openchamberToolSource).toBe('mcp');
    const other = project(input());
    other[1].parts[0].tool = 'other_update_checklist';
    expect(snapshot(other).state).toBe('unavailable');
  });

  it('replaces a partial MCP wrapper when complete history restores its normalized input', async () => {
    const publisher = createNativeEventPublisher({ publishNativeEvent: () => {} });
    const request = { messageID: 'accepted', sentAt: 1, model: { providerID: 'antigravity-native', modelID: 'test' }, agent: 'build', parts: [] };
    const projection = createAntigravityLiveProjection({ sessionId, nativeId, directory: '/repo', publisher, request });
    await projection.applyStep({ step_index: 2, step_type: 'tool', state: 'DONE', tool_info: {
      name: 'call_mcp_tool', parameters: { ServerName: 'openchamber_checklist', ToolName: 'update_checklist' },
      output: checklistReceipt(input()), error: null,
    } }, 3, async () => {});
    projection.finish({ outcome: 'success', response: '', error: '', time: 4 });
    const history = project(input());
    history[0].info.id = 'accepted';
    history[1].info.parentID = 'accepted';
    projection.restoreMissingHistory(history);
    expect(snapshot(projection.records())).toMatchObject({ state: 'ready', items: [{ id: 'verify' }] });
    const restored = projection.records().flatMap((record) => record.parts).find((part) => part.type === 'tool');
    expect(restored.state.input).toEqual(input());
  });

  it('keeps malformed and duplicate task ids out of both helper and host', () => {
    expect(parseChecklistInput({ todos: [input().todos[0], input().todos[0]] })).toBeNull();
    expect(parseChecklistInput(input('failed'))).toBeNull();
    expect(parseChecklistInput({ todos: [{ id: '1', content: '', status: 'pending' }] })).toBeNull();
    expect(parseChecklistInput({ todos: [], sessionId: 'another-session' })).toBeNull();
    expect(parseChecklistInput({ todos: [{ id: '1', content: 'a'.repeat(256 * 1024), status: 'pending' }] })).toBeNull();
  });

  it('runs the packaged-compatible helper without network, credentials or a task store', () => {
    const requests = [
      { id: 1, method: 'tools/list' },
      { id: 2, method: 'tools/call', params: { name: 'update_checklist', arguments: input() } },
      { id: 3, method: 'tools/call', params: { name: 'update_checklist', arguments: input('unknown') } },
      { id: 4, method: 'tools/call', params: { name: 'update_checklist', arguments: { todos: [{ id: '1', content: 'x'.repeat(270 * 1024), status: 'pending' }] } } },
    ].map((request) => JSON.stringify(request)).join('\n') + '\n';
    const run = (enabled) => spawnSync(process.execPath, [fileURLToPath(new URL('./checklist-mcp.mjs', import.meta.url))], {
      input: requests, encoding: 'utf8', env: { OPENCHAMBER_AGY_CHECKLIST: enabled ? '1' : '0' },
    });
    const active = run(true);
    expect(active.status).toBe(0);
    const responses = active.stdout.trim().split('\n').map((line) => JSON.parse(line).result);
    expect(responses[0].tools[0].name).toBe('update_checklist');
    expect(responses[1]).toMatchObject({ isError: false, content: [{ text: checklistReceipt(input()) }] });
    expect(responses[2].isError).toBe(true);
    expect(responses[3].isError).toBe(true);
    expect(JSON.parse(run(false).stdout.split('\n')[0]).result.tools).toEqual([]);
  });
});
