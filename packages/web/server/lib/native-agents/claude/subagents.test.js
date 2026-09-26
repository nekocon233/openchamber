import { describe, expect, it } from 'vitest';

import { translateNativeEvent } from '@openchamber/ui/lib/native-agents/events';
import { createNativeEventPublisher } from '../publisher.js';
import { createClaudeProjection, claudeAbortedError } from './projector.js';
import { createClaudeSubagents } from './subagents.js';

const UUID = 'f1033b7a-88c5-4b77-bbec-6d63ec3a1188';
const PARENT = `ncl_${UUID}`;
const DIRECTORY = '/work/project';
const at = (second) => `2026-09-27T00:00:${String(second).padStart(2, '0')}.000Z`;
const childId = (tool) => `${PARENT}_t_${tool}`;
const user = (tool, id, content) => ({ type: 'user', uuid: id, timestamp: at(1), parent_tool_use_id: tool, message: { role: 'user', content } });
const assistant = (tool, id, content, stopReason = 'end_turn') => ({
  type: 'assistant', uuid: `${id}-entry`, timestamp: at(2), parent_tool_use_id: tool,
  message: { id, model: 'claude-haiku-4-5', content, stop_reason: stopReason },
});
const stream = (tool, event) => ({ type: 'stream_event', parent_tool_use_id: tool, event });
const started = (tool, background = false) => ({ type: 'system', subtype: 'task_started', task_id: `agent-${tool}`, tool_use_id: tool, is_backgrounded: background });

const fixture = () => {
  const events = [];
  const publisher = createNativeEventPublisher({ publishNativeEvent: (event) => events.push(event) });
  const children = createClaudeSubagents({ sessionUuid: UUID, directory: DIRECTORY, publisher, now: () => Date.parse(at(3)) });
  const parent = createClaudeProjection({ sessionId: PARENT, cwd: DIRECTORY, live: true });
  parent.applyEntry(user(null, 'parent-user', 'Research three topics'));
  const changed = parent.applyEntry(assistant(null, 'parent-answer', ['tool-a', 'tool-b', 'tool-c'].map((id) => ({
    type: 'tool_use', id, name: 'Agent', input: { description: id, subagent_type: 'general-purpose', prompt: 'Research' },
  })), 'tool_use'));
  children.announce(PARENT, parent, changed);
  return { events, children, parent };
};

const statuses = (events, sessionId) => events.filter((event) => event.payload.type === 'session.status'
  && event.payload.properties.sessionID === sessionId).map((event) => event.payload.properties.status.type);

describe('Claude child conversations', () => {
  it('routes interleaved replies, thinking and deltas to three independent child sessions', () => {
    const { events, children, parent } = fixture();
    for (const tool of ['tool-a', 'tool-b', 'tool-c']) {
      children.handleFrame(started(tool));
      children.handleFrame(user(tool, `${tool}-user`, `Question for ${tool}`));
      children.handleFrame(stream(tool, { type: 'message_start', message: { id: `msg-${tool}`, model: 'claude-haiku-4-5', content: [] } }));
      children.handleFrame(stream(tool, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
    }
    for (const tool of ['tool-c', 'tool-a', 'tool-b']) {
      children.handleFrame(stream(tool, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `Answer for ${tool}` } }));
      children.handleFrame(assistant(tool, `msg-${tool}`, [{ type: 'text', text: `Answer for ${tool}` }]));
    }
    expect(children.busySessionIds()).toEqual(['tool-a', 'tool-b', 'tool-c'].map(childId));
    for (const tool of ['tool-a', 'tool-b', 'tool-c']) {
      const records = children.records(childId(tool));
      expect(records.map((record) => record.info.role)).toEqual(['user', 'assistant']);
      expect(records[1].info.parentID).toBe(records[0].info.id);
      expect(records[1].parts[0].text).toBe(`Answer for ${tool}`);
      expect(records.every((record) => record.info.sessionID === childId(tool))).toBe(true);
      expect(statuses(events, childId(tool))).toEqual(['busy']);
    }
    expect(parent.records().flatMap((record) => record.parts).some((part) => part.text?.startsWith('Answer for'))).toBe(false);
    expect(events.filter((event) => event.payload.type === 'message.part.delta')).toHaveLength(3);
    expect(events.every((event) => translateNativeEvent(event.payload) !== null)).toBe(true);
  });

  it('keeps a background child running after its launch result and settles only that child on completion', () => {
    const { events, children } = fixture();
    children.handleFrame(started('tool-a', true));
    children.handleFrame(started('tool-b'));
    children.handleFrame(user('tool-a', 'child-user', 'Research'));
    const answer = assistant('tool-a', 'child-answer', [{ type: 'thinking', thinking: 'Check the source.' }]);
    children.handleFrame(answer);
    children.handleFrame(answer);
    children.handleFrame({ ...user(null, 'launch-result', [{ type: 'tool_result', tool_use_id: 'tool-a', content: 'Launched' }]), tool_use_result: { isAsync: true } });
    expect(children.isRunning(childId('tool-a'))).toBe(true);
    expect(children.records(childId('tool-a'))[1].parts).toHaveLength(1);

    const completion = { type: 'system', subtype: 'task_notification', task_id: 'agent-tool-a', status: 'completed' };
    children.handleFrame(completion);
    expect(children.busySessionIds()).toEqual([childId('tool-b')]);
    expect(children.records(childId('tool-a'))[1].info).toMatchObject({ finish: 'stop', time: { completed: expect.any(Number) } });
    expect(statuses(events, childId('tool-a'))).toEqual(['busy', 'idle']);
    const count = events.length;
    children.handleFrame(completion);
    children.handleFrame(assistant('tool-a', 'late-answer', [{ type: 'text', text: 'Late' }]));
    expect(events).toHaveLength(count);
  });

  it('finishes a foreground child from its parent tool result without closing its sibling', () => {
    const { events, children } = fixture();
    children.handleFrame(started('tool-a'));
    children.handleFrame(started('tool-b'));
    children.handleFrame(user('tool-a', 'child-user', 'Research'));
    children.handleFrame(assistant('tool-a', 'child-answer', [{ type: 'text', text: 'Result' }]));
    children.handleFrame(user(null, 'finished', [{ type: 'tool_result', tool_use_id: 'tool-a', content: 'Result' }]));
    expect(children.busySessionIds()).toEqual([childId('tool-b')]);
    expect(statuses(events, childId('tool-a'))).toEqual(['busy', 'idle']);
  });

  it('reports one child failure without erasing the replies or activity of its sibling', () => {
    const { events, children } = fixture();
    for (const tool of ['tool-a', 'tool-b']) {
      children.handleFrame(started(tool, true));
      children.handleFrame(user(tool, `${tool}-user`, 'Research'));
      children.handleFrame(assistant(tool, `${tool}-answer`, [{ type: 'text', text: `Progress from ${tool}` }]));
    }
    children.handleFrame({ type: 'system', subtype: 'task_notification', task_id: 'agent-tool-a', status: 'failed', summary: 'The task failed' });
    expect(children.records(childId('tool-a'))[1].info.error).toMatchObject({ name: 'UnknownError', data: { message: 'The task failed' } });
    expect(children.records(childId('tool-b'))[1].parts[0].text).toBe('Progress from tool-b');
    expect(children.busySessionIds()).toEqual([childId('tool-b')]);
    expect(events.filter((event) => event.payload.type === 'session.error').map((event) => event.payload.properties.sessionID)).toEqual([childId('tool-a')]);
  });

  it('settles unfinished child tools and clears activity when the parent query exits', () => {
    const { events, children } = fixture();
    children.handleFrame(started('tool-a'));
    children.handleFrame(user('tool-a', 'child-user', 'Research'));
    children.handleFrame(assistant('tool-a', 'child-answer', [{ type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/work/project/notes.txt' } }], 'tool_use'));
    children.dispose(claudeAbortedError());
    expect(children.busySessionIds()).toEqual([]);
    expect(children.records(childId('tool-a'))).toBeNull();
    const tools = events.filter((event) => event.payload.type === 'message.part.updated').map((event) => event.payload.properties.part).filter((part) => part.type === 'tool');
    expect(tools.at(-1).state).toMatchObject({ status: 'error', error: 'Interrupted', time: { end: expect.any(Number) } });
    expect(statuses(events, childId('tool-a'))).toEqual(['busy', 'idle']);
  });
});
