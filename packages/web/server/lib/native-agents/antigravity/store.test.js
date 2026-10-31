import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { encodeAntigravitySessionId } from '../ids.js';
import { antigravityPromptFingerprint } from '../prompt-parts.js';
import { createNativeRegistry } from '../registry.js';
import { createAntigravityStore } from './store.js';

const NATIVE_ID = 'f1033b7a-88c5-4b77-bbec-6d63ec3a1188';
const SESSION_ID = encodeAntigravitySessionId(NATIVE_ID);
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const setup = ({ confirmed = true } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-agy-store-'));
  roots.push(root);
  const home = path.join(root, 'home');
  const directory = path.join(root, 'project');
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(root, 'registry.json');
  const registry = createNativeRegistry({ filePath });
  const entry = {
    backend: 'antigravity', nativeId: NATIVE_ID, directory,
    origin: 'openchamber', createdAt: 1,
    ...(confirmed ? { confirmedAt: 2 } : {}),
  };
  const writeSummary = (nativeId = NATIVE_ID, cwd = directory, parentId = '') => {
    fs.mkdirSync(home, { recursive: true });
    const db = new DatabaseSync(path.join(home, 'conversation_summaries.db'));
    db.exec(`create table if not exists conversation_summaries (
      conversation_id text primary key, title text, preview text,
      last_modified_time text, workspace_uris text, parent_conversation_id text default ''
    )`);
    db.prepare('insert or replace into conversation_summaries values (?, ?, ?, ?, ?, ?)')
      .run(nativeId, 'Native title', 'Preview', '2026-10-01 12:00:00+00:00', JSON.stringify([pathToFileURL(cwd).href]), parentId);
    db.close();
  };
  const writeTranscript = (lines, nativeId = NATIVE_ID, trailingNewline = true, name = 'transcript.jsonl') => {
    const target = path.join(home, 'brain', nativeId, '.system_generated', 'logs');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, name), `${lines.join('\n')}${trailingNewline ? '\n' : ''}`);
  };
  return { root, home, directory, registry, entry, filePath, writeSummary, writeTranscript };
};

const step = (value) => JSON.stringify({ created_at: '2026-10-01T12:00:00Z', status: 'DONE', ...value });

describe('Antigravity native store', () => {
  it('withholds decision authority when a transcript loses a complete record', async () => {
    const { home, directory, registry, entry, writeSummary, writeTranscript } = setup();
    writeSummary();
    await registry.registerSession(SESSION_ID, entry);
    await registry.recordSend(SESSION_ID, { messageId: 'nag_u_question', providerID: 'antigravity-native', modelID: 'gemini-test', agent: 'plan', sentAt: 1, antigravity: { stepIndex: 0, completion: { outcome: 'success', time: 2 } } });
    const rows = [
      step({ step_index: 0, type: 'USER_INPUT', content: 'Ask a question' }),
      step({ step_index: 1, type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'ask_question', args: { questions: [{ question: 'Scope?', options: ['File', 'Module'], is_multi_select: false }] } }] }),
      step({ step_index: 2, type: 'GENERIC', content: 'A1: User Skipped' }),
      step({ step_index: 3, type: 'PLANNER_RESPONSE', content: 'Waiting for your answer.' }),
    ];
    writeTranscript(rows, NATIVE_ID, true, 'transcript_full.jsonl');
    const store = createAntigravityStore({ registry, home });
    expect((await store.loadHistory(SESSION_ID, NATIVE_ID, directory)).interactionProposal?.questions[0].question).toBe('Scope?');
    writeTranscript([...rows, '{invalid-record}'], NATIVE_ID, true, 'transcript_full.jsonl');
    const partial = await store.loadHistory(SESSION_ID, NATIVE_ID, directory);
    expect(partial.interactionSourceComplete).toBe(false);
    expect(partial.interactionProposal).toBeNull();
    expect(partial.records.some((record) => record.parts.some((part) => part.type === 'tool' && part.tool === 'question'))).toBe(true);
    expect(partial.metadataComplete).toBe(false);
  });
  it.each(['true', 'null', '"quoted"', '{"setting":false}'])('reads literal %s identically from native full and encoded preview arguments', async (value) => {
    const { home, directory, registry, writeSummary, writeTranscript } = setup();
    writeSummary();
    const args = { Path: path.join(directory, 'file.txt'), Target: value, Replacement: value };
    const lines = (input) => [
      step({ step_index: 0, type: 'USER_INPUT', content: 'Edit' }),
      step({ step_index: 1, type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'edit_file', args: input }] }),
      step({ step_index: 2, type: 'GENERIC', content: 'Made one replacement' }),
    ];
    writeTranscript(lines(args), NATIVE_ID, true, 'transcript_full.jsonl');
    writeTranscript(lines(Object.fromEntries(Object.entries(args).map(([key, value]) => [key, JSON.stringify(value)]))));
    const store = createAntigravityStore({ registry, home });
    const full = await store.loadHistory(SESSION_ID, NATIVE_ID, directory);
    expect(full.records[1].parts[0].state.input).toEqual({ filePath: args.Path, oldString: value, newString: value });
    fs.rmSync(path.join(home, 'brain', NATIVE_ID, '.system_generated', 'logs', 'transcript_full.jsonl'));
    const preview = await store.loadHistory(SESSION_ID, NATIVE_ID, directory);
    expect(preview.records[1].parts[0].state.input).toEqual(full.records[1].parts[0].state.input);
  });

  it('restores read-only background outcomes and reads bounded native output after a restart', async () => {
    const { home, directory, registry, writeSummary, writeTranscript } = setup();
    writeSummary();
    writeTranscript([
      step({ step_index: 0, type: 'USER_INPUT', content: 'Build' }),
      step({ step_index: 1, type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'run_command', args: { CommandLine: '"build"', toolSummary: '"Build the app"' } }] }),
      step({ step_index: 2, type: 'GENERIC', status: 'RUNNING', content: `Tool is running as a background task with task id: ${NATIVE_ID}/task-2\nTask Description: build` }),
      step({ step_index: 3, type: 'SYSTEM_MESSAGE', content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-10-31T02:01:00Z sender=${NATIVE_ID}/task-2 priority=MESSAGE_PRIORITY_HIGH content=Task id "${NATIVE_ID}/task-2" finished with result:\nCommand exited with code 2.\nShort output\nLog: file:///ignored/path\n</SYSTEM_MESSAGE>`, truncated_fields: ['content'] }),
      step({ step_index: 4, type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'run_command', args: { CommandLine: '"test"' } }] }),
      step({ step_index: 5, type: 'GENERIC', status: 'RUNNING', created_at: undefined, content: `Tool is running as a background task with task id: ${NATIVE_ID}/task-5\nTask Description: test` }),
    ]);
    const store = createAntigravityStore({ registry, home });
    const snapshot = await store.taskSnapshot(SESSION_ID, NATIVE_ID, directory);
    expect(snapshot).toMatchObject({ state: 'history', tasks: [
      { description: 'Build the app', status: 'failed', active: false, canStop: false },
      { description: 'test', status: 'unknown', active: false, canStop: false },
    ] });
    const id = `${NATIVE_ID}_task-2`;
    expect(snapshot.tasks[1].startedAt).toBeUndefined();
    expect(await store.taskOutput(SESSION_ID, NATIVE_ID, directory, id, snapshot.generation)).toMatchObject({ state: 'ready', truncated: true });
    const taskRoot = path.join(home, 'brain', NATIVE_ID, '.system_generated', 'tasks');
    fs.mkdirSync(taskRoot, { recursive: true });
    fs.writeFileSync(path.join(taskRoot, 'task-2.log'), `${'x'.repeat(300_000)}\nfull result`);
    const restarted = createAntigravityStore({ registry, home });
    const output = await restarted.taskOutput(SESSION_ID, NATIVE_ID, directory, id, snapshot.generation);
    expect(output.state).toBe('ready');
    expect(output.truncated).toBe(true);
    expect(Buffer.byteLength(output.text)).toBe(256 * 1024);
    expect(output.text.endsWith('full result')).toBe(true);
    expect(await restarted.taskOutput(SESSION_ID, NATIVE_ID, directory, '../private', snapshot.generation)).toEqual({ state: 'unavailable', reason: 'not_recorded' });
    expect(await restarted.taskOutput(SESSION_ID, NATIVE_ID, directory, id, 'another-session')).toEqual({ state: 'unavailable', reason: 'query_closed' });
    expect(await restarted.taskSnapshot(SESSION_ID, NATIVE_ID, path.join(directory, 'other'))).toBeNull();
    fs.rmSync(path.join(taskRoot, 'task-2.log'));
    const outside = path.join(home, 'private-output');
    fs.writeFileSync(outside, 'must stay outside the task response');
    fs.symlinkSync(outside, path.join(taskRoot, 'task-2.log'));
    expect(await restarted.taskOutput(SESSION_ID, NATIVE_ID, directory, id, snapshot.generation)).toEqual({ state: 'unavailable', reason: 'unreadable' });
  });

  it('restores complete text, arguments and compaction from the full native log', async () => {
    const { home, directory, registry, writeSummary, writeTranscript } = setup();
    writeSummary();
    const user = step({ step_index: 0, type: 'USER_INPUT', content: 'Review the project' });
    writeTranscript([
      user,
      step({ step_index: 1, type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'edit_file', args: { Replacement: 'short preview' } }], truncated_fields: ['tool_calls'] }),
      step({ step_index: 2, type: 'GENERIC', content: 'short preview', truncated_fields: ['content'] }),
      step({ step_index: 3, type: 'CHECKPOINT', content: 'short summary', truncated_fields: ['content'] }),
      step({ step_index: 4, type: 'PLANNER_RESPONSE', content: 'short answer', truncated_fields: ['content'] }),
    ]);
    writeTranscript([
      user,
      step({ step_index: 1, type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'edit_file', args: { Replacement: 'complete replacement' } }] }),
      step({ step_index: 2, type: 'GENERIC', content: 'Complete edit output' }),
      step({ step_index: 3, type: 'CHECKPOINT', content: 'Complete compaction summary' }),
      step({ step_index: 4, type: 'PLANNER_RESPONSE', content: 'Complete final answer', input_tokens: 15, output_tokens: 8 }),
    ], NATIVE_ID, true, 'transcript_full.jsonl');
    const store = createAntigravityStore({ registry, home });
    const history = await store.loadHistory(SESSION_ID, NATIVE_ID, directory);
    expect(history.records[1].parts[0].state).toMatchObject({ input: { Replacement: 'complete replacement' }, output: 'Complete edit output' });
    expect(history.records[1].parts[0].state.metadata.nativeOutputTruncated).toBeUndefined();
    expect(history.records[2].info.summary).toBe('Complete compaction summary');
    expect(history.records[3].parts[0]).toMatchObject({ text: 'Complete final answer' });
    expect(history.records[3].parts[0].metadata).toBeUndefined();
    expect(store.finalResponse(NATIVE_ID, 0)).toMatchObject({ content: 'Complete final answer', usage: { input_tokens: 15, output_tokens: 8 } });
  });

  it('fills malformed and still-appending full steps from the preview without losing complete full steps', async () => {
    const { home, directory, registry, writeSummary, writeTranscript } = setup();
    writeSummary();
    const user = step({ step_index: 0, type: 'USER_INPUT', content: 'hello' });
    writeTranscript([
      user,
      step({ step_index: 1, type: 'PLANNER_RESPONSE', content: 'short', truncated_fields: ['content'] }),
      step({ step_index: 2, type: 'PLANNER_RESPONSE', content: 'Preview recovery' }),
      step({ step_index: 3, type: 'PLANNER_RESPONSE', content: 'Latest preview', truncated_fields: ['content'] }),
    ]);
    writeTranscript([
      user, step({ step_index: 1, type: 'PLANNER_RESPONSE', content: 'Complete earlier answer' }),
      'not-json', '{"step_index":3',
    ], NATIVE_ID, false, 'transcript_full.jsonl');
    const history = await createAntigravityStore({ registry, home }).loadHistory(SESSION_ID, NATIVE_ID, directory);
    expect(history.records.map((record) => record.parts[0].text)).toEqual(['hello', 'Complete earlier answer', 'Preview recovery', 'Latest preview']);
    expect(history.records.at(-1).parts[0].metadata.nativeOutputTruncated).toBe(true);
    expect(history.metadataComplete).toBe(false);
  });

  it('reads a full-only session and reports an unreadable full log instead of silently using its preview', async () => {
    const { home, directory, registry, writeSummary, writeTranscript } = setup();
    writeSummary();
    const entries = [step({ step_index: 0, type: 'USER_INPUT', content: 'hello' }), step({ step_index: 1, type: 'PLANNER_RESPONSE', content: 'Full answer' })];
    writeTranscript(entries, NATIVE_ID, true, 'transcript_full.jsonl');
    const store = createAntigravityStore({ registry, home });
    expect((await store.loadHistory(SESSION_ID, NATIVE_ID, directory)).records.at(-1).parts[0].text).toBe('Full answer');
    writeTranscript(entries);
    const target = path.join(home, 'brain', NATIVE_ID, '.system_generated', 'logs', 'transcript_full.jsonl');
    fs.rmSync(target);
    fs.mkdirSync(target);
    await expect(store.loadHistory(SESSION_ID, NATIVE_ID, directory)).rejects.toMatchObject({ code: 'NATIVE_ANTIGRAVITY_HISTORY_UNAVAILABLE' });
  });

  it('keeps readable records when another transcript line is malformed or unknown', async () => {
    const { home, directory, registry, entry, writeSummary, writeTranscript } = setup();
    await registry.registerSession(SESSION_ID, entry);
    writeSummary();
    writeTranscript([
      step({ step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>hello</USER_REQUEST>' }),
      step({ step_index: 1, type: 'PLANNER_RESPONSE', content: 'world', tool_calls: [] }),
      'not-json',
      step({ step_index: 2, type: 'FUTURE_STEP' }),
      '{"step_index":',
    ], NATIVE_ID, false);
    const store = createAntigravityStore({ registry, home, now: () => 1000 });
    const history = await store.loadHistory(SESSION_ID, NATIVE_ID, directory);
    expect(history.records.map((record) => record.info.role)).toEqual(['user', 'assistant']);
    expect(history.records[0].info.id).toBe(`nag_u_${NATIVE_ID.replaceAll('-', '')}_0`);
    expect(history.records[1].parts[0].text).toBe('world');
    expect(history.metadataComplete).toBe(false);
    expect((await store.listRootSessions(directory)).map((record) => record.id)).toEqual([SESSION_ID]);
  });

  it('recovers a client id from an accepted send once, then persists the binding', async () => {
    const { home, directory, registry, entry, filePath, writeSummary, writeTranscript } = setup();
    await registry.registerSession(SESSION_ID, entry);
    const content = '<USER_REQUEST>\nhello\n\n<openchamber-instructions>\nrules\n</openchamber-instructions>\n</USER_REQUEST>';
    const messageId = 'nag_u_00112233-4455-4677-8899-aabbccddeeff';
    await registry.recordSend(SESSION_ID, {
      messageId, providerID: 'antigravity-native', modelID: 'gemini-test-high', agent: 'build', sentAt: 3,
      antigravity: { fingerprint: antigravityPromptFingerprint(content) },
    });
    writeSummary();
    writeTranscript([
      step({ step_index: 0, type: 'USER_INPUT', content }),
      step({ step_index: 1, type: 'PLANNER_RESPONSE', content: 'reply', tool_calls: [] }),
    ]);
    const first = createAntigravityStore({ registry: createNativeRegistry({ filePath }), home });
    const history = await first.loadHistory(SESSION_ID, NATIVE_ID, directory);
    expect(history.records[0].info.id).toBe(messageId);
    expect(history.records[0].parts[0].text).toBe('hello');
    const second = createAntigravityStore({ registry: createNativeRegistry({ filePath }), home });
    expect((await second.loadHistory(SESSION_ID, NATIVE_ID, directory)).records[0].info.id).toBe(messageId);
    expect((await createNativeRegistry({ filePath }).sendRecords(SESSION_ID)).get(messageId).antigravity.stepIndex).toBe(0);
  });

  it('distinguishes an unwritten new session from a missing confirmed transcript', async () => {
    const { home, directory, registry, entry, writeSummary } = setup({ confirmed: false });
    await registry.registerSession(SESSION_ID, entry);
    writeSummary();
    const store = createAntigravityStore({ registry, home });
    expect((await store.loadHistory(SESSION_ID, NATIVE_ID, directory)).records).toEqual([]);
    await registry.confirmSession(SESSION_ID);
    await expect(store.loadHistory(SESSION_ID, NATIVE_ID, directory)).rejects.toMatchObject({ code: 'NATIVE_ANTIGRAVITY_HISTORY_UNAVAILABLE' });
  });

  it('filters native roots to their own workspace', async () => {
    const { home, directory, registry, writeSummary } = setup();
    writeSummary();
    writeSummary('01a0d2a6-b55b-7162-a837-c62053537e00', path.join(directory, 'other'));
    const store = createAntigravityStore({ registry, home });
    expect((await store.listRootSessions(directory)).map((record) => record.id)).toEqual([SESSION_ID]);
    expect(await store.getSession(SESSION_ID, NATIVE_ID, path.join(directory, 'other'))).toBeNull();
  });

  it('reads children and nested children in the root workspace without listing them as roots', async () => {
    const { home, directory, registry, writeSummary, writeTranscript } = setup();
    const childId = '01a0d2a6-b55b-7162-a837-c62053537e00';
    const nestedId = '01a0d2a6-b55b-7162-a837-c62053537e01';
    writeSummary();
    writeSummary(childId, path.join(directory, 'worktree'), NATIVE_ID);
    writeSummary(nestedId, path.join(directory, 'nested'), childId);
    for (const id of [NATIVE_ID, childId, nestedId]) writeTranscript([
      step({ step_index: 0, type: 'USER_INPUT', content: 'Inspect files' }),
      step({ step_index: 1, type: 'PLANNER_RESPONSE', content: 'Findings' }),
    ], id);
    const store = createAntigravityStore({ registry, home });
    const first = await store.loadHistory(SESSION_ID, NATIVE_ID, directory);
    expect(first.childSessions).toMatchObject([{ id: `nag_${childId}`, parentID: SESSION_ID, directory }]);
    expect((await store.listRootSessions(directory)).map((r) => r.id)).toEqual([SESSION_ID]);
    expect((await store.loadHistory(`nag_${childId}`, childId, directory)).childSessions).toMatchObject([
      { id: `nag_${nestedId}`, parentID: `nag_${childId}`, directory },
    ]);
    expect(await store.getSession(`nag_${childId}`, childId, path.join(directory, 'unrelated'))).toBeNull();
    expect((await store.getSession(`nag_${nestedId}`, nestedId, directory)).metadata.openchamber.native.activityKnown).toBe(false);
    writeSummary(childId, directory, nestedId);
    await expect(store.getSession(`nag_${childId}`, childId, directory)).rejects.toMatchObject({ code: 'NATIVE_ANTIGRAVITY_HISTORY_UNAVAILABLE' });
  });

  it('keeps current transcript usage and exposes native tool truncation without dropping the output', async () => {
    const { home, directory, registry, writeSummary, writeTranscript } = setup();
    writeSummary();
    writeTranscript([
      step({ step_index: 0, type: 'USER_INPUT', content: 'read' }),
      step({ step_index: 1, type: 'PLANNER_RESPONSE', input_tokens: 20, output_tokens: 3, cache_read_tokens: 7,
        tool_calls: [{ name: 'read_file', args: {} }] }),
      step({ step_index: 2, type: 'GENERIC', content: 'Retained output', truncated_fields: ['content'] }),
      step({ step_index: 3, type: 'CHECKPOINT', content: 'Native summary' }),
      step({ step_index: 4, type: 'PLANNER_RESPONSE', content: 'Final answer', usage: { input_tokens: 5, output_tokens: 2 } }),
    ]);
    const history = await createAntigravityStore({ registry, home }).loadHistory(SESSION_ID, NATIVE_ID, directory);
    expect(history.records[1].info.tokens).toMatchObject({ input: 20, output: 3, cache: { read: 7 }, total: 23 });
    expect(history.records[1].parts[0].state).toMatchObject({ output: 'Retained output', metadata: { nativeOutputTruncated: true } });
    expect(history.records[2].info).toMatchObject({ role: 'compaction', summary: 'Native summary' });
    expect(history.records[3].info.tokens).toMatchObject({ input: 5, output: 2 });
  });
});
