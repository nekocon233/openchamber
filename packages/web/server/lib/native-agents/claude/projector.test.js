import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { createClaudeProjection } from './projector.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const SESSION_ID = 'ncl_f1033b7a-88c5-4b77-bbec-6d63ec3a1188';
const USER_ID = 'ncl_u_a22f0a7a-a88c-4093-a5e3-6653ff44f6d3';
const TASK_TOOL_USE = 'toolu_01VAnMEDHHeuo92ZtfbaNtwQ';
const CHILD_ID = `${SESSION_ID}_t_${TASK_TOOL_USE}`;

const projectHistory = (entries, options = {}) => {
  const projection = createClaudeProjection({
    sessionId: SESSION_ID,
    cwd: '/work/project',
    childSessionIdForToolUse: (toolUseId) => (toolUseId === TASK_TOOL_USE ? CHILD_ID : null),
    ...options,
  });
  for (const entry of entries) projection.applyEntry(entry);
  projection.settleOpenTools('The turn ended before this tool finished.');
  return projection.records();
};

const toolParts = (records) => records.flatMap((record) => record.parts).filter((part) => part.type === 'tool');

describe('Claude history projection', () => {
  const records = projectHistory(fixture('haiku-tools.session-messages.json'));

  it('starts with the user message OpenChamber sent, keyed by the uuid it chose', () => {
    const [first] = records;
    expect(first.info).toMatchObject({ id: USER_ID, role: 'user', sessionID: SESSION_ID, agent: 'build' });
    expect(first.parts).toHaveLength(1);
    expect(first.parts[0]).toMatchObject({ type: 'text', sessionID: SESSION_ID, messageID: USER_ID });
    expect(first.parts[0].text).toContain('Do these steps in order');
  });

  it('makes one assistant message per API message, each answering the user message', () => {
    const assistants = records.filter((record) => record.info.role === 'assistant');
    expect(assistants.map((record) => record.info.finish)).toEqual(['tool-calls', 'tool-calls', 'tool-calls', 'stop']);
    for (const record of assistants) {
      expect(record.info.parentID).toBe(USER_ID);
      expect(record.info.providerID).toBe('claude-native');
      expect(record.info.modelID).toBe('claude-haiku-4-5');
      expect(record.info.time.completed).toBeGreaterThanOrEqual(record.info.time.created);
      expect(record.info.tokens.total).toBeGreaterThan(0);
    }
    expect(assistants[0].parts.map((part) => part.type)).toEqual(['reasoning', 'text', 'tool', 'tool']);
  });

  it('keeps message creation times in chain order', () => {
    const created = records.map((record) => record.info.time.created);
    expect(created).toEqual([...created].sort((left, right) => left - right));
  });

  it('maps Claude tools onto the OpenCode renderers and finishes them from their results', () => {
    const byTool = new Map(toolParts(records).map((part) => [part.tool, part]));
    expect([...byTool.keys()]).toEqual(['write', 'read', 'edit', 'bash', 'task', 'question']);

    expect(byTool.get('write').state).toMatchObject({
      status: 'completed',
      input: { filePath: '/work/project/hello.txt', content: 'hello' },
    });
    expect(byTool.get('edit').state).toMatchObject({
      status: 'completed',
      input: { filePath: '/work/project/hello.txt', oldString: 'hello', newString: 'hello world' },
    });
    expect(byTool.get('bash').state).toMatchObject({
      status: 'completed',
      input: { command: 'cat /work/project/hello.txt' },
      output: 'hello world',
    });
    expect(byTool.get('task').state.metadata).toEqual({ sessionId: CHILD_ID });
    expect(byTool.get('question').state.output).toMatch(/^User has answered your questions: "Which color do you prefer\?"="blue"\. You can now/);
    expect(byTool.get('question').state.input.questions[0]).toMatchObject({
      question: 'Which color do you prefer?',
      multiple: false,
      options: [{ label: 'red' }, { label: 'blue' }],
    });
  });

  it('emits parts the renderers accept: session ids, finished times', () => {
    for (const record of records) {
      for (const part of record.parts) {
        expect(part.sessionID).toBe(SESSION_ID);
        expect(part.messageID).toBe(record.info.id);
        if (part.type === 'text' || part.type === 'reasoning') expect(part.time.end).toBeGreaterThanOrEqual(part.time.start);
        if (part.type === 'tool') expect(part.state.time.end).toBeGreaterThanOrEqual(part.state.time.start);
      }
    }
  });

  it('uses the model and effort OpenChamber sent when it has a send record', () => {
    const withRecords = projectHistory(fixture('haiku-tools.session-messages.json'), {
      sendRecordFor: (messageId) => (messageId === USER_ID ? { modelID: 'haiku', variant: 'low', agent: 'plan' } : null),
    });
    expect(withRecords[0].info.model).toEqual({ providerID: 'claude-native', modelID: 'haiku', variant: 'low' });
    expect(withRecords[0].info.agent).toBe('plan');
    expect(withRecords[1].info).toMatchObject({ agent: 'plan', variant: 'low' });
  });
});

describe('Claude compaction projection', () => {
  const at = (seconds) => new Date(Date.UTC(2026, 8, 16, 20, 0, seconds)).toISOString();
  // A system entry as the SDK's history read returns it: the type, nothing of its kind.
  const systemEntry = (uuid, seconds) => ({ type: 'system', uuid, timestamp: at(seconds), message: undefined, parent_tool_use_id: null, parent_agent_id: null });
  const entries = [
    systemEntry('boundary-1', 30),
    {
      type: 'user',
      uuid: 'summary-1',
      timestamp: at(29),
      isCompactSummary: true,
      is_meta: true,
      message: { role: 'user', content: 'This session is being continued from a previous conversation.' },
    },
    {
      type: 'assistant',
      uuid: 'preserved-1',
      timestamp: at(10),
      message: { id: 'msg_preserved', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'earlier answer' }], stop_reason: 'end_turn' },
    },
  ];
  const records = projectHistory(entries);

  it('shows the boundary as a compaction turn answered by the summary', () => {
    const [boundary, summary, preserved] = records;
    expect(boundary.info).toMatchObject({ id: 'ncl_k_boundary-1', role: 'user' });
    // The history read does not say what started it, so the marker makes no claim.
    expect(boundary.parts).toEqual([expect.objectContaining({ type: 'compaction', auto: false })]);
    expect(summary.info).toMatchObject({ role: 'assistant', summary: true, finish: 'stop', parentID: 'ncl_k_boundary-1' });
    expect(summary.parts[0].text).toContain('continued from a previous conversation');
    expect(preserved.info.parentID).toBe('ncl_k_boundary-1');
  });

  it('keeps preserved messages after the boundary even though their timestamps are older', () => {
    const created = records.map((record) => record.info.time.created);
    expect(created).toEqual([...created].sort((left, right) => left - right));
  });

  it('shows nothing for the other system entries a history read returns', () => {
    const prompt = (uuid, seconds, text) => ({ type: 'user', uuid, timestamp: at(seconds), message: { role: 'user', content: text } });
    const projected = projectHistory([
      prompt('5f0a4d1e-2b8c-4c1a-9e6f-0d2b3c4a5e61', 1, 'first'),
      {
        type: 'assistant',
        uuid: 'answer-1',
        timestamp: at(2),
        message: { id: 'msg_answer', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
      },
      // A turn duration, an away summary, and the two entries of a local command.
      systemEntry('turn-duration', 3),
      systemEntry('away-summary', 4),
      systemEntry('local-command-1', 5),
      systemEntry('local-command-2', 5),
      prompt('7c9e2f3a-4b5d-4e6f-8a1b-2c3d4e5f6a7b', 6, 'second'),
      systemEntry('notice', 7),
    ]);
    expect(projected.flatMap((record) => record.parts).filter((part) => part.type === 'compaction')).toEqual([]);
    expect(projected.map((record) => record.info.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('tells a /compact the user asked for from one the CLI made to free the context when the entry names its trigger', () => {
    const manual = projectHistory([{ type: 'system', subtype: 'compact_boundary', uuid: 'boundary-2', timestamp: at(40), compact_metadata: { trigger: 'manual', pre_tokens: 9000 } }]);
    const auto = projectHistory([{ type: 'system', subtype: 'compact_boundary', uuid: 'boundary-3', timestamp: at(40), compactMetadata: { trigger: 'auto', preTokens: 190000 } }]);
    const other = projectHistory([{ type: 'system', subtype: 'turn_duration', uuid: 'duration-1', timestamp: at(40) }]);
    expect(manual[0].parts).toEqual([expect.objectContaining({ type: 'compaction', auto: false })]);
    expect(auto[0].parts).toEqual([expect.objectContaining({ type: 'compaction', auto: true })]);
    expect(other).toEqual([]);
  });
});

describe('Claude tools the renderers do not know', () => {
  const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });

  it('keeps the tool name as the CLI wrote it and titles the call with what its input is about', () => {
    const records = projectHistory([
      { type: 'user', uuid: 'a22f0a7a-a88c-4093-a5e3-6653ff44f6d3', timestamp: '2026-09-24T10:00:00.000Z', message: { role: 'user', content: 'Plan it' } },
      {
        type: 'assistant',
        uuid: 'a-1',
        timestamp: '2026-09-24T10:00:01.000Z',
        message: {
          id: 'msg_1',
          model: 'claude-haiku-4-5',
          content: [
            toolUse('toolu_task', 'TaskCreate', { subject: 'alpha', description: 'First task\nwith detail' }),
            toolUse('toolu_mcp', 'mcp__github__create_issue', { title: 'Broken link', body: 'The docs link 404s.' }),
            toolUse('toolu_bare', 'TaskList', {}),
          ],
        },
      },
      {
        type: 'user',
        uuid: 'r-1',
        timestamp: '2026-09-24T10:00:02.000Z',
        message: {
          role: 'user',
          content: ['toolu_task', 'toolu_mcp', 'toolu_bare'].map((id) => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })),
        },
      },
    ]);
    expect(toolParts(records).map((part) => [part.tool, part.state.title])).toEqual([
      ['TaskCreate', 'alpha'],
      ['github_create_issue', 'Broken link'],
      ['TaskList', ''],
    ]);
  });
});

describe('Claude background subagents', () => {
  it('leaves out the notice the CLI sends the model when a background subagent finishes', () => {
    const records = projectHistory([
      { type: 'user', uuid: 'a22f0a7a-a88c-4093-a5e3-6653ff44f6d3', timestamp: '2026-09-24T10:00:00.000Z', origin: { kind: 'human' }, message: { role: 'user', content: 'Survey the project' } },
      { type: 'assistant', uuid: 'a-1', timestamp: '2026-09-24T10:00:01.000Z', message: { id: 'msg_1', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'Started a subagent.' }], stop_reason: 'end_turn' } },
      { type: 'user', uuid: 'n-1', timestamp: '2026-09-24T10:00:05.000Z', origin: { kind: 'task-notification' }, message: { role: 'user', content: '<task-notification>\n<task-id>a4065</task-id>\n</task-notification>' } },
      { type: 'assistant', uuid: 'a-2', timestamp: '2026-09-24T10:00:06.000Z', message: { id: 'msg_2', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'The subagent found three files.' }], stop_reason: 'end_turn' } },
    ]);
    expect(records.map((record) => [record.info.role, record.parts.map((part) => part.text).join('')])).toEqual([
      ['user', 'Survey the project'],
      ['assistant', 'Started a subagent.'],
      ['assistant', 'The subagent found three files.'],
    ]);
  });
});

describe('Claude feature instructions', () => {
  it("leaves a feature's instructions out of the user message, keeping the user's part ids", () => {
    const records = projectHistory([
      {
        type: 'user',
        uuid: 'a22f0a7a-a88c-4093-a5e3-6653ff44f6d3',
        timestamp: '2026-09-24T10:00:00.000Z',
        message: { role: 'user', content: [
          { type: 'text', text: 'what is this file?' },
          { type: 'text', text: '<openchamber-instructions>\nAnswer the side question only.\n</openchamber-instructions>' },
        ] },
      },
    ]);
    expect(records.map((record) => record.parts.map((part) => [part.id, part.text]))).toEqual([
      [[`${USER_ID}_p0`, 'what is this file?']],
    ]);
  });
});

describe('Claude stops', () => {
  const userEntry = (uuid, content, timestamp) => ({ type: 'user', uuid, timestamp, message: { role: 'user', content } });
  const toolUse = { type: 'assistant', uuid: 'a-1', timestamp: '2026-09-24T10:00:01.000Z', message: { id: 'msg_1', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_sleep', name: 'Bash', input: { command: 'sleep 30' } }] } };

  it('leaves the CLI stop marker out of the conversation', () => {
    const records = projectHistory([
      userEntry('a22f0a7a-a88c-4093-a5e3-6653ff44f6d3', 'Run sleep', '2026-09-24T10:00:00.000Z'),
      toolUse,
      userEntry('b33f0a7a-a88c-4093-a5e3-6653ff44f6d3', [{ type: 'text', text: '[Request interrupted by user for tool use]' }], '2026-09-24T10:00:02.000Z'),
      userEntry('c44f0a7a-a88c-4093-a5e3-6653ff44f6d3', '[Request interrupted by user]', '2026-09-24T10:00:03.000Z'),
    ]);
    expect(records.map((record) => record.info.role)).toEqual(['user', 'assistant']);
  });

  it('marks a stopped turn the way the UI marks one it settles itself', () => {
    const projection = createClaudeProjection({ sessionId: SESSION_ID, cwd: '/work/project', live: true, now: () => 5 });
    projection.startUserPrompt(USER_ID, { kind: 'text', text: 'Run sleep' });
    projection.applyEntry(toolUse);
    const changed = projection.finishTurn({ error: { name: 'MessageAbortedError', data: { message: 'aborted' } } });
    const assistant = projection.record(changed.at(-1));
    expect(assistant.info.error).toEqual({ name: 'MessageAbortedError', data: { message: 'aborted' } });
    expect(assistant.parts[0].state).toMatchObject({ status: 'error', error: 'Interrupted' });
  });
});

describe('Claude slash commands', () => {
  const command = (uuid, name, args = '') => ({
    type: 'user',
    uuid,
    timestamp: '2026-09-24T10:00:00.000Z',
    isCompletedLocalCommand: true,
    message: { role: 'user', content: `<command-name>${name}</command-name>\n            <command-message>${name.slice(1)}</command-message>\n            <command-args>${args}</command-args>` },
  });
  const output = (uuid, text) => ({
    type: 'user',
    uuid,
    timestamp: '2026-09-24T10:00:01.000Z',
    isCompletedLocalCommand: true,
    message: { role: 'user', content: `<local-command-stdout>${text}</local-command-stdout>` },
  });

  it('shows a command as the user typed it under the prompt it came with, and leaves its output out', () => {
    const records = projectHistory([
      command('a22f0a7a-a88c-4093-a5e3-6653ff44f6d3', '/cost'),
      output('out-1', 'Total cost: $0.01'),
      command('b33f0a7a-a88c-4093-a5e3-6653ff44f6d3', '/review-code', 'src/app.ts'),
    ]);
    expect(records.map((record) => [record.info.id, record.parts.map((part) => part.text)])).toEqual([
      [USER_ID, ['/cost']],
      ['ncl_u_b33f0a7a-a88c-4093-a5e3-6653ff44f6d3', ['/review-code src/app.ts']],
    ]);
  });

  it('leaves out a command the CLI ran on its own, like the /model a model switch records', () => {
    const records = projectHistory([
      { type: 'user', uuid: 'caveat-1', timestamp: '2026-09-24T10:00:00.000Z', isMeta: true, message: { role: 'user', content: '<local-command-caveat>Caveat: generated by local commands.</local-command-caveat>' } },
      { ...command('model-1', '/model', 'haiku'), isCompletedLocalCommand: undefined },
      { ...output('out-1', 'Set model to haiku'), isCompletedLocalCommand: undefined },
      { type: 'user', uuid: 'a22f0a7a-a88c-4093-a5e3-6653ff44f6d3', timestamp: '2026-09-24T10:00:02.000Z', message: { role: 'user', content: 'Reply with one word.' } },
    ]);
    expect(records.map((record) => [record.info.id, record.parts.map((part) => part.text)])).toEqual([
      [USER_ID, ['Reply with one word.']],
    ]);
  });

  it('shows /compact only as its compaction', () => {
    const records = projectHistory([
      { type: 'system', uuid: 'boundary-1', timestamp: '2026-09-24T10:00:02.000Z' },
      {
        type: 'user',
        uuid: 'summary-1',
        timestamp: '2026-09-24T10:00:02.000Z',
        isCompactSummary: true,
        is_meta: true,
        message: { role: 'user', content: 'This session is being continued from a previous conversation.' },
      },
      command('a22f0a7a-a88c-4093-a5e3-6653ff44f6d3', '/compact'),
      output('out-1', 'Compacted '),
    ]);
    expect(records.map((record) => record.info.id)).toEqual(['ncl_k_boundary-1', 'ncl_k_boundary-1_summary']);
  });
});
