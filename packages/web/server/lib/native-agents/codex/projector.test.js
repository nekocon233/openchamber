import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { parseCodexUserMessageItem } from './items.js';
import { projectCodexTurns } from './projector.js';
import { materializeSessionSnapshots } from '@openchamber/ui/sync/materialization';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const THREAD_ID = '01a0d2a6-b55b-7162-a837-c62053537e00';
const SESSION_ID = `ncx_${THREAD_ID}`;
const CLIENT_MESSAGE_ID = 'ncx_u_5b0e1c52-2f1f-4c3a-9d8e-0a7b6c5d4e3f';

const project = (turns, options = {}) => projectCodexTurns({
  sessionId: SESSION_ID,
  threadId: THREAD_ID,
  cwd: '/work/project',
  turns,
  threadModel: 'gpt-5.5',
  ...options,
});

describe('Codex history projection', () => {
  const records = project(fixture('gpt55-tools.turns.json').data);

  it('keeps the user message id OpenChamber sent and answers it with one assistant message', () => {
    expect(records.map((record) => record.info.role)).toEqual(['user', 'assistant']);
    const [user, assistant] = records;
    expect(user.info).toMatchObject({
      id: CLIENT_MESSAGE_ID,
      sessionID: SESSION_ID,
      model: { providerID: 'codex-native', modelID: 'gpt-5.5' },
    });
    expect(user.parts[0].text).toContain('Do these steps in order');
    expect(assistant.info).toMatchObject({
      role: 'assistant',
      parentID: CLIENT_MESSAGE_ID,
      providerID: 'codex-native',
      modelID: 'gpt-5.5',
      finish: 'stop',
    });
    expect(assistant.info.time.completed).toBeGreaterThan(assistant.info.time.created);
    expect(user.info.time.created).toBeLessThan(assistant.info.time.created);
  });

  it('interleaves the agent text with its commands and file edits in item order', () => {
    const [, assistant] = records;
    expect(assistant.parts.map((part) => (part.type === 'tool' ? part.tool : part.type))).toEqual([
      'text', 'bash', 'text', 'apply_patch', 'text', 'apply_patch', 'text',
    ]);
  });

  it('shows the command the model asked for, with its output and exit code', () => {
    const bash = records[1].parts.find((part) => part.type === 'tool' && part.tool === 'bash');
    expect(bash.state).toMatchObject({
      status: 'completed',
      input: { command: 'cat notes.txt', workdir: '/work/project' },
      output: 'line one\nline two\n',
      metadata: { exit: 0 },
    });
  });

  it('turns file changes into unified diffs the patch renderer reads', () => {
    const patches = records[1].parts.filter((part) => part.type === 'tool' && part.tool === 'apply_patch');
    expect(patches[0].state.metadata.files).toEqual([{
      filePath: '/work/project/greeting.txt',
      type: 'add',
      diff: '--- /dev/null\n+++ /work/project/greeting.txt\n@@ -0,0 +1,1 @@\n+hi\n',
      additions: 1,
      deletions: 0,
    }]);
    expect(patches[1].state.metadata.files[0]).toMatchObject({
      type: 'update',
      diff: '--- /work/project/greeting.txt\n+++ /work/project/greeting.txt\n@@ -1 +1 @@\n-hi\n+hi there\n',
      additions: 1,
      deletions: 1,
    });
  });

  it('marks failed and interrupted turns as errors, and leaves running turns open', () => {
    const turn = (id, status, extra = {}) => ({
      id,
      status,
      startedAt: 1790240535,
      completedAt: status === 'inProgress' ? null : 1790240540,
      items: [
        { type: 'userMessage', id: `u-${id}`, content: [{ type: 'text', text: id }] },
        { type: 'agentMessage', id: `a-${id}`, text: 'partial' },
      ],
      ...extra,
    });
    const projected = project([
      turn('failed', 'failed', { error: { message: 'boom' } }),
      turn('interrupted', 'interrupted'),
      turn('running', 'inProgress'),
    ]);
    const assistants = projected.filter((record) => record.info.role === 'assistant');
    expect(assistants[0].info.error).toEqual({ name: 'UnknownError', data: { message: 'boom' } });
    expect(assistants[1].info.error.name).toBe('MessageAbortedError');
    expect(assistants[2].info.time.completed).toBeUndefined();
    expect(assistants[2].parts[0].time.end).toBeUndefined();
    expect(projected[0].info.id).toBe(`ncx_u_${THREAD_ID.replaceAll('-', '')}_u-failed`);
  });

  it('starts a new assistant segment after a message steered into a running turn', () => {
    const projected = project([{
      id: 'turn-1',
      status: 'completed',
      startedAt: 1790240535,
      completedAt: 1790240545,
      items: [
        { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'first' }] },
        { type: 'agentMessage', id: 'a1', text: 'working' },
        { type: 'userMessage', id: 'u2', content: [{ type: 'text', text: 'steer' }] },
        { type: 'agentMessage', id: 'a2', text: 'done' },
      ],
    }]);
    expect(projected.map((record) => record.info.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(projected[3].info.parentID).toBe(projected[2].info.id);
    expect(projected[1].info.id).not.toBe(projected[3].info.id);
    const created = projected.map((record) => record.info.time.created);
    expect(created).toEqual([...created].sort((left, right) => left - right));
  });
});

describe('Codex compaction projection', () => {
  const turnWithCompactions = {
    id: 'turn-with-compactions', status: 'inProgress', startedAt: 10,
    items: [
      { type: 'userMessage', id: 'prompt', clientId: CLIENT_MESSAGE_ID, content: [{ type: 'text', text: 'Continue' }] },
      { type: 'agentMessage', id: 'before', text: 'Before compaction' },
      { type: 'contextCompaction', id: 'compact-one' },
      { type: 'agentMessage', id: 'middle', text: 'After first compaction' },
      { type: 'contextCompaction', id: 'compact-two' },
      { type: 'agentMessage', id: 'after', text: 'After second compaction' },
    ],
  };

  const transcript = (state) => state.messages.map((message) =>
    state.part[message.id].map((part) => part.type === 'compaction' ? 'COMPACT' : part.text).join(''),
  );

  it('keeps every reply on its own side of repeated compactions after history materialization', () => {
    const records = project([turnWithCompactions]);
    expect(new Set(records.map((record) => record.info.id)).size).toBe(records.length);
    const state = materializeSessionSnapshots({ message: {}, part: {} }, SESSION_ID, records);
    expect(transcript(state)).toEqual([
      'Continue', 'Before compaction', 'COMPACT', 'After first compaction', 'COMPACT', 'After second compaction',
    ]);
  });

  it('preserves already-rendered replies when a compaction and its continuation arrive', () => {
    const initial = project([{ ...turnWithCompactions, items: turnWithCompactions.items.slice(0, 2) }]);
    const state = materializeSessionSnapshots({ message: {}, part: {} }, SESSION_ID, initial);
    const records = project([turnWithCompactions]);
    const next = materializeSessionSnapshots(state, SESSION_ID, records);
    expect(next.messages[1]).toBe(state.messages[1]);
    expect(transcript(next)).toEqual([
      'Continue', 'Before compaction', 'COMPACT', 'After first compaction', 'COMPACT', 'After second compaction',
    ]);
    expect(records.slice(0, 2).map((record) => record.info.id)).toEqual(initial.map((record) => record.info.id));
  });

  it('shows a compaction turn as the compaction marker, with no empty reply', () => {
    const records = project([
      { id: 'turn-1', status: 'completed', startedAt: 10, completedAt: 11, items: [
        { type: 'userMessage', id: 'item-1', clientId: CLIENT_MESSAGE_ID, content: [{ type: 'text', text: 'Hi' }] },
        { type: 'agentMessage', id: 'item-2', text: 'Hello' },
      ] },
      { id: 'turn-2', status: 'completed', startedAt: 20, completedAt: 21, items: [{ type: 'contextCompaction', id: 'item-3' }] },
    ]);
    const compaction = records.at(-1);
    expect(records.map((record) => record.info.role)).toEqual(['user', 'assistant', 'user']);
    expect(compaction.info.id).toBe(`ncx_k_${THREAD_ID.replaceAll('-', '')}_item-3`);
    // A turn of its own is the /compact the user asked for.
    expect(compaction.parts).toEqual([expect.objectContaining({ type: 'compaction', messageID: compaction.info.id, auto: false })]);
  });

  it('marks a compaction inside a prompted turn as Codex freeing the context', () => {
    const records = project([
      { id: 'turn-1', status: 'completed', startedAt: 10, completedAt: 11, items: [
        { type: 'userMessage', id: 'item-1', clientId: CLIENT_MESSAGE_ID, content: [{ type: 'text', text: 'Refactor it' }] },
        { type: 'contextCompaction', id: 'item-2' },
        { type: 'agentMessage', id: 'item-3', text: 'Done' },
      ] },
    ]);
    const compaction = records.find((record) => record.parts.some((part) => part.type === 'compaction'));
    expect(compaction.parts).toEqual([expect.objectContaining({ type: 'compaction', auto: true })]);
  });
});

describe('Codex feature instructions', () => {
  it("leaves a feature's instructions out of the user message", () => {
    expect(parseCodexUserMessageItem({
      type: 'userMessage',
      id: 'item-1',
      clientId: 'ncx_u_1',
      content: [
        { type: 'text', text: 'what is this file?' },
        { type: 'text', text: '<openchamber-instructions>\nAnswer the side question only.\n</openchamber-instructions>' },
      ],
    })).toEqual({ id: 'item-1', clientId: 'ncx_u_1', texts: ['what is this file?'], images: [] });
  });
});
