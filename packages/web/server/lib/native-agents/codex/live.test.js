import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

import { createNativeEventPublisher } from '../publisher.js';
import { createQuestionRegistry } from '../questions.js';
import { createCodexLiveThreads } from './live.js';
import { projectCodexTurns } from './projector.js';
import { JsonRpcError } from './rpc.js';

const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const DIRECTORY = '/work/project';
const THREAD_ID = '01a0d2a6-b55b-7162-a837-c62053537e00';
const SESSION_ID = `ncx_${THREAD_ID}`;
const TURN_ID = '01a0d2a6-b5a1-7672-908a-eedff3ad5fa9';
const MESSAGE_ID = 'ncx_u_5b0e1c52-2f1f-4c3a-9d8e-0a7b6c5d4e3f';
const CONFIG = { model: 'gpt-5.5', effort: 'low', mode: 'default' };

const notifications = fixture('gpt55-tools.notifications.json');

const createHarness = ({ replay = true, failures = {}, onIdle, instructions = null } = {}) => {
  const events = [];
  const requests = [];
  const publisher = createNativeEventPublisher({ publishNativeEvent: (event) => events.push(event) });
  const questions = createQuestionRegistry({ publish: (directory, payload) => events.push({ directory, payload }) });
  let live = null;
  const request = async (method, params) => {
    requests.push({ method, params });
    if (failures[method]) throw failures[method];
    if (method !== 'turn/start') return {};
    if (replay) {
      setTimeout(() => {
        for (const notification of notifications) live.handleNotification(notification.method, notification.params);
      }, 0);
    }
    return { turn: { id: TURN_ID, status: 'inProgress', items: [] } };
  };
  live = createCodexLiveThreads({ request, publisher, questions, onIdle, readGlobalInstructions: async () => instructions });
  return { live, events, requests, questions };
};

const payloads = (events, type) => events.map((event) => event.payload).filter((payload) => payload.type === type);

const waitFor = async (condition) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = condition();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('condition never became true');
};

const sendPrompt = (live, overrides = {}) => live.prompt({
  sessionId: SESSION_ID,
  directory: DIRECTORY,
  messageId: MESSAGE_ID,
  input: [{ type: 'text', text: 'Do these steps in order' }],
  config: CONFIG,
  send: { modelID: 'gpt-5.5', variant: 'low', agent: 'build' },
  ...overrides,
});

describe('Codex live threads', () => {
  it('gives the global instructions to Codex as developer instructions when it loads the thread', async () => {
    const { live, requests } = createHarness({ replay: false, instructions: 'Instructions from: /home/ada/.config/opencode/AGENTS.md\nAnswer in English.' });
    await sendPrompt(live);

    expect(requests[0]).toMatchObject({
      method: 'thread/resume',
      params: { developerInstructions: 'Instructions from: /home/ada/.config/opencode/AGENTS.md\nAnswer in English.' },
    });
  });

  it('adds no developer instructions when there are no global ones', async () => {
    const { live, requests } = createHarness({ replay: false });
    await sendPrompt(live);

    expect(requests[0].method).toBe('thread/resume');
    expect(requests[0].params.developerInstructions).toBeUndefined();
  });

  it('resumes the thread and starts a fully auto-approved turn', async () => {
    const { live, requests } = createHarness({ replay: false });
    await sendPrompt(live);
    expect(requests.map((entry) => entry.method)).toEqual(['thread/resume', 'turn/start']);
    expect(requests[0].params).toEqual({ threadId: THREAD_ID, excludeTurns: true, approvalPolicy: 'never', sandbox: 'danger-full-access' });
    expect(requests[1].params).toEqual({
      threadId: THREAD_ID,
      input: [{ type: 'text', text: 'Do these steps in order' }],
      clientUserMessageId: MESSAGE_ID,
      cwd: DIRECTORY,
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
      model: 'gpt-5.5',
      effort: 'low',
      collaborationMode: { mode: 'default', settings: { model: 'gpt-5.5', reasoning_effort: 'low', developer_instructions: null } },
    });
    expect(live.busySessionIds(DIRECTORY)).toEqual([SESSION_ID]);
  });

  it('streams the turn and names records the way a later history read does', async () => {
    const { live, events } = createHarness();
    await sendPrompt(live);
    await waitFor(() => payloads(events, 'session.idle').length > 0);

    const types = events.map((event) => event.payload.type);
    expect(types[0]).toBe('session.status');
    expect(types.slice(-2)).toEqual(['session.status', 'session.idle']);

    const finalParts = new Map(payloads(events, 'message.part.updated').map((payload) => [payload.properties.part.id, payload.properties.part]));
    const streamed = new Map();
    for (const payload of payloads(events, 'message.part.delta')) {
      streamed.set(payload.properties.partID, (streamed.get(payload.properties.partID) ?? '') + payload.properties.delta);
    }
    expect(streamed.size).toBe(4);
    for (const [partId, text] of streamed) expect(finalParts.get(partId).text).toBe(text);

    const published = new Map();
    for (const payload of payloads(events, 'message.updated')) published.set(payload.properties.info.id, []);
    for (const part of finalParts.values()) published.get(part.messageID).push(part.id);
    const history = projectCodexTurns({
      sessionId: SESSION_ID,
      threadId: THREAD_ID,
      cwd: DIRECTORY,
      turns: fixture('gpt55-tools.turns.json').data,
      threadModel: 'gpt-5.5',
    });
    expect([...published]).toEqual(history.map((record) => [record.info.id, record.parts.map((part) => part.id)]));
    expect(published.has(MESSAGE_ID)).toBe(true);

    const assistant = payloads(events, 'message.updated').filter((payload) => payload.properties.info.role === 'assistant').at(-1);
    expect(assistant.properties.info).toMatchObject({ finish: 'stop', variant: 'low', time: { completed: expect.any(Number) } });
    expect(live.liveRecords(SESSION_ID)).toBeNull();
    expect(live.busySessionIds(DIRECTORY)).toEqual([]);
  });

  it('starts the first turn of a thread it just created without resuming it', async () => {
    const { live, requests } = createHarness({ replay: false });
    live.threadStarted(SESSION_ID, DIRECTORY);
    await sendPrompt(live);
    expect(requests.map((entry) => entry.method)).toEqual(['turn/start']);
  });

  it('steers a prompt sent while the turn runs, and resumes again after the thread unloads', async () => {
    const { live, requests, events } = createHarness({ replay: false });
    await sendPrompt(live);
    await sendPrompt(live, { messageId: 'ncx_u_6c1f2d63-3a2a-4d5b-8e9f-1b2c3d4e5f60' });
    expect(requests.at(-1)).toEqual({
      method: 'turn/steer',
      params: {
        threadId: THREAD_ID,
        expectedTurnId: TURN_ID,
        input: [{ type: 'text', text: 'Do these steps in order' }],
        clientUserMessageId: 'ncx_u_6c1f2d63-3a2a-4d5b-8e9f-1b2c3d4e5f60',
      },
    });

    live.handleNotification('turn/completed', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'completed', startedAt: 1, completedAt: 2 } });
    live.handleNotification('thread/status/changed', { threadId: THREAD_ID, status: { type: 'notLoaded' } });
    await sendPrompt(live, { messageId: 'ncx_u_7d2f3e74-4b3b-4e6c-9f0a-2c3d4e5f6071' });
    expect(requests.filter((entry) => entry.method === 'thread/resume')).toHaveLength(2);
    expect(payloads(events, 'session.idle')).toHaveLength(1);
  });

  it('interrupts the running turn and settles it as aborted without an error event', async () => {
    const { live, requests, events } = createHarness({ replay: false });
    await sendPrompt(live);
    expect(await live.abort(SESSION_ID)).toBe(true);
    expect(requests.at(-1)).toEqual({ method: 'turn/interrupt', params: { threadId: THREAD_ID, turnId: TURN_ID } });

    live.handleNotification('turn/completed', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'interrupted', startedAt: 1, completedAt: 2 } });
    expect(payloads(events, 'session.idle')).toHaveLength(1);
    expect(payloads(events, 'session.error')).toEqual([]);
    expect(await live.abort(SESSION_ID)).toBe(false);
  });

  it('asks the question UI for user input and accepts approvals', async () => {
    const { live, events, questions } = createHarness({ replay: false });
    await sendPrompt(live);
    const answer = live.handleServerRequest('item/tool/requestUserInput', {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: 'call_ask',
      isBlocking: true,
      questions: [{ id: 'color', header: 'Color', question: 'Which color?', options: [{ label: 'red', description: 'Red' }, { label: 'blue', description: 'Blue' }] }],
    });
    const asked = await waitFor(() => payloads(events, 'question.asked')[0]);
    expect(asked.properties).toMatchObject({ sessionID: SESSION_ID, questions: [{ question: 'Which color?', header: 'Color', multiple: false }] });
    questions.reply(asked.properties.id, [['blue']]);
    expect(await answer).toEqual({ answers: { color: { answers: ['blue'] } } });

    expect(await live.handleServerRequest('item/commandExecution/requestApproval', {})).toEqual({ decision: 'accept' });
    expect(await live.handleServerRequest('item/fileChange/requestApproval', {})).toEqual({ decision: 'accept' });
    await expect(live.handleServerRequest('item/tool/call', {})).rejects.toThrow('Unsupported app-server request');
    await expect(live.handleServerRequest('constructor', {})).rejects.toThrow('Unsupported app-server request');
  });

  it('fails running turns when the app-server stops', async () => {
    const { live, events } = createHarness({ replay: false });
    await sendPrompt(live);
    live.handleExit('exit code 1');
    expect(payloads(events, 'session.error')[0].properties).toMatchObject({
      sessionID: SESSION_ID,
      error: { name: 'UnknownError', data: { message: 'Codex app-server stopped: exit code 1' } },
    });
    expect(live.busySessionIds(DIRECTORY)).toEqual([]);
  });

  it('turns the plan into todos and ignores notifications for threads it does not drive', async () => {
    const { live, events } = createHarness({ replay: false });
    live.handleNotification('turn/plan/updated', { threadId: 'someone-else', plan: [] });
    live.handleNotification('toString', {});
    expect(events).toEqual([]);

    await sendPrompt(live);
    live.handleNotification('turn/plan/updated', {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      plan: [{ step: 'Read notes', status: 'completed' }, { step: 'Write greeting', status: 'inProgress' }],
    });
    expect(payloads(events, 'todo.updated')[0].properties.todos).toEqual([
      { id: `${THREAD_ID}_plan_0`, content: 'Read notes', status: 'completed', priority: 'medium' },
      { id: `${THREAD_ID}_plan_1`, content: 'Write greeting', status: 'in_progress', priority: 'medium' },
    ]);
  });

  it('reports when a thread goes idle', async () => {
    const idle = [];
    const { live } = createHarness({ replay: false, onIdle: (sessionId, directory) => idle.push([sessionId, directory]) });
    await expect(live.whenIdle(SESSION_ID)).resolves.toBeUndefined();
    await sendPrompt(live);
    const waiting = live.whenIdle(SESSION_ID);
    live.handleNotification('turn/completed', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'completed', startedAt: 1, completedAt: 2 } });
    await waiting;
    expect(idle).toEqual([[SESSION_ID, DIRECTORY]]);
  });

  it('rewinds the thread before a turn, and accepts a turn that is gone already', async () => {
    const { live, requests } = createHarness({ replay: false });
    await live.revertThread(SESSION_ID, TURN_ID);
    expect(requests).toEqual([{ method: 'thread/revert', params: { threadId: THREAD_ID, beforeTurnId: TURN_ID } }]);

    const gone = createHarness({ replay: false, failures: { 'thread/revert': new JsonRpcError(`turn not found: ${TURN_ID}`, -32600) } });
    await expect(gone.live.revertThread(SESSION_ID, TURN_ID)).resolves.toBeUndefined();

    const broken = createHarness({ replay: false, failures: { 'thread/revert': new JsonRpcError('thread not loaded', -32600) } });
    await expect(broken.live.revertThread(SESSION_ID, TURN_ID)).rejects.toThrow('thread not loaded');
  });

  it('compacts through the thread it resumes, and streams the compaction in as a turn', async () => {
    const { live, requests, events } = createHarness({ replay: false });
    await live.compact(SESSION_ID, DIRECTORY);
    expect(requests.map((entry) => entry.method)).toEqual(['thread/resume', 'thread/compact/start']);
    expect(requests[1].params).toEqual({ threadId: THREAD_ID });

    live.handleNotification('turn/started', { threadId: THREAD_ID, turn: { id: 'turn-compact', status: 'inProgress', startedAt: 1 } });
    live.handleNotification('item/completed', { threadId: THREAD_ID, turnId: 'turn-compact', item: { type: 'contextCompaction', id: 'item-compact' } });
    live.handleNotification('turn/completed', { threadId: THREAD_ID, turn: { id: 'turn-compact', status: 'completed', startedAt: 1, completedAt: 2 } });
    const statuses = payloads(events, 'session.status').map((payload) => payload.properties.status.type);
    expect(statuses).toEqual(['busy', 'idle']);
    const compaction = payloads(events, 'message.part.updated').map((payload) => payload.properties.part);
    expect(compaction).toEqual([expect.objectContaining({ type: 'compaction', messageID: `ncx_k_${THREAD_ID.replaceAll('-', '')}_item-compact` })]);
  });

  it('refuses a message id Codex cannot echo', async () => {
    const { live, requests } = createHarness({ replay: false });
    await expect(sendPrompt(live, { messageId: 'msg_1' })).rejects.toMatchObject({ code: 'NATIVE_INVALID_REQUEST' });
    expect(requests).toEqual([]);
  });
});
