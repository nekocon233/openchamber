import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNativeEventPublisher } from '../publisher.js';
import { createQuestionRegistry } from '../questions.js';
import { createClaudeSessionStore } from './store.js';
import { createClaudeLiveSessions } from './live.js';
import { createClaudeProjection } from './projector.js';

const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const DIRECTORY = '/work/project';
const SESSION_UUID = 'f1033b7a-88c5-4b77-bbec-6d63ec3a1188';
const SESSION_ID = `ncl_${SESSION_UUID}`;
const USER_MESSAGE_ID = 'ncl_u_a22f0a7a-a88c-4093-a5e3-6653ff44f6d3';
const ASK_TOOL_ID = 'toolu_014Xcz9vrMxMqg2EMycAspPn';
const PROMPT = 'Do these steps in order, using the named tools:';

const frames = fixture('haiku-tools.live-frames.json');
const askInput = frames
  .flatMap((frame) => (frame.type === 'assistant' ? frame.message.content : []))
  .find((block) => block.type === 'tool_use' && block.id === ASK_TOOL_ID).input;

// Replays the recorded frames once the first prompt arrives, asking the
// recorded question through canUseTool right before its answer frame, the
// way the CLI asks before the tool runs. Then waits for more input, and
// exits `exitDelayMs` after its input ends.
const createFakeSdk = ({ failAfter = null, exitDelayMs = 0 } = {}) => {
  const calls = { queries: [], setModel: [], applyFlagSettings: [], setPermissionMode: [], interrupt: 0 };
  const sdk = {
    query: ({ prompt, options }) => {
      const previous = calls.queries.at(-1);
      const record = { options, inputs: [], closed: false, decision: null, previousClosed: previous ? previous.closed : null };
      calls.queries.push(record);
      const input = prompt[Symbol.asyncIterator]();
      async function* run() {
        const first = await input.next();
        if (first.done) {
          record.closed = true;
          return;
        }
        record.inputs.push(first.value);
        for (const [index, frame] of frames.entries()) {
          if (failAfter !== null && index === failAfter) throw new Error('claude exited with code 1');
          const answersQuestion = frame.type === 'user'
            && frame.message.content.some((block) => block.tool_use_id === ASK_TOOL_ID);
          if (answersQuestion) {
            record.decision = await options.canUseTool('AskUserQuestion', askInput, {
              signal: new AbortController().signal,
              toolUseID: ASK_TOOL_ID,
            });
          }
          yield frame;
        }
        while (true) {
          const next = await input.next();
          if (next.done) {
            await new Promise((resolve) => setTimeout(resolve, exitDelayMs));
            record.closed = true;
            return;
          }
          record.inputs.push(next.value);
        }
      }
      return Object.assign(run(), {
        setModel: async (model) => { calls.setModel.push(model); },
        applyFlagSettings: async (settings) => { calls.applyFlagSettings.push(settings); },
        setPermissionMode: async (mode) => { calls.setPermissionMode.push(mode); },
        interrupt: async () => { calls.interrupt += 1; },
        supportedCommands: async () => {
          record.listedCommands = true;
          return [{ name: 'compact', description: 'Free up context', argumentHint: '<instructions>', builtin: true }, { name: 'review-code', description: 'Review', argumentHint: '' }, { description: 'nameless' }];
        },
      });
    },
  };
  return { sdk, calls };
};

const createHarness = ({ failAfter = null, exitDelayMs = 0, hasTranscript = false, idleTimeoutMs = 60_000, onIdle, executable = '/usr/local/bin/claude', platform = 'darwin', instructions = null } = {}) => {
  const events = [];
  const publisher = createNativeEventPublisher({ publishNativeEvent: (event) => events.push(event) });
  const questions = createQuestionRegistry({
    publish: (directory, payload) => events.push({ directory, payload }),
  });
  const { sdk, calls } = createFakeSdk({ failAfter, exitDelayMs });
  const live = createClaudeLiveSessions({
    loadSdk: async () => sdk,
    resolveExecutable: async () => executable,
    buildEnv: () => ({ PATH: '/usr/bin' }),
    hasTranscript: async () => hasTranscript,
    publisher,
    questions,
    readGlobalInstructions: async () => instructions,
    onIdle,
    idleTimeoutMs,
    platform,
  });
  return { live, events, questions, calls };
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
  messageId: USER_MESSAGE_ID,
  content: { kind: 'text', text: PROMPT },
  sdkContent: [{ type: 'text', text: PROMPT }],
  config: { model: 'haiku', effort: null, permissionMode: 'bypassPermissions' },
  send: { modelID: 'haiku', agent: 'build' },
  ...overrides,
});

const answerQuestion = async ({ events, questions }) => {
  const asked = await waitFor(() => payloads(events, 'question.asked')[0]);
  questions.reply(asked.properties.id, [['blue']]);
  return asked;
};

afterEach(() => {
  vi.useRealTimers();
});

describe('Claude live sessions', () => {
  it('appends the global instructions to the system prompt of the query it starts', async () => {
    const harness = createHarness({ instructions: 'Instructions from: /home/ada/.config/opencode/AGENTS.md\nAnswer in English.' });
    await sendPrompt(harness.live);
    await answerQuestion(harness);
    await waitFor(() => payloads(harness.events, 'session.idle').length > 0);

    expect(harness.calls.queries[0].options.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'Instructions from: /home/ada/.config/opencode/AGENTS.md\nAnswer in English.',
    });
  });

  it('streams a turn as the events the UI reducer handles', async () => {
    const harness = createHarness();
    await sendPrompt(harness.live);
    const asked = await answerQuestion(harness);
    await waitFor(() => payloads(harness.events, 'session.idle').length > 0);

    const { calls, events } = harness;
    expect(calls.queries[0].options).toMatchObject({
      cwd: DIRECTORY,
      sessionId: SESSION_UUID,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      model: 'haiku',
    });
    expect(calls.queries[0].inputs[0]).toMatchObject({ uuid: USER_MESSAGE_ID.slice('ncl_u_'.length), priority: 'next' });

    const types = events.map((event) => event.payload.type);
    expect(types[0]).toBe('message.updated');
    expect(types.indexOf('session.status')).toBeLessThan(types.indexOf('message.part.delta'));
    expect(types.slice(-2)).toEqual(['session.status', 'session.idle']);
    expect(events.every((event) => event.directory === DIRECTORY)).toBe(true);

    // Streamed text adds up to the finished part.
    const finalParts = new Map(payloads(events, 'message.part.updated').map((payload) => [payload.properties.part.id, payload.properties.part]));
    const streamed = new Map();
    for (const payload of payloads(events, 'message.part.delta')) {
      const { partID, delta } = payload.properties;
      streamed.set(partID, (streamed.get(partID) ?? '') + delta);
    }
    expect(streamed.size).toBeGreaterThan(0);
    for (const [partId, text] of streamed) expect(finalParts.get(partId).text).toBe(text);

    // An assistant message completes on message_stop, after its tools ran.
    const firstAssistant = payloads(events, 'message.updated').find((payload) => payload.properties.info.role === 'assistant');
    expect(firstAssistant.properties.info.time.completed).toBeUndefined();
    const lastUpdate = payloads(events, 'message.updated').filter((payload) => payload.properties.info.id === firstAssistant.properties.info.id).at(-1);
    expect(lastUpdate.properties.info).toMatchObject({ finish: 'tool-calls', time: { completed: expect.any(Number) } });

    // The question reaches the UI and its answer reaches the CLI.
    expect(asked.properties).toMatchObject({
      sessionID: SESSION_ID,
      questions: [{ question: 'Which color do you prefer?', header: 'Color', multiple: false }],
      tool: { callID: ASK_TOOL_ID },
    });
    expect(payloads(events, 'question.replied')[0].properties).toMatchObject({ requestID: asked.properties.id, answers: [['blue']] });
    expect(calls.queries[0].decision).toEqual({
      behavior: 'allow',
      updatedInput: { ...askInput, answers: { 'Which color do you prefer?': 'blue' } },
    });

    // The Task tool call announces its subagent session.
    expect(payloads(events, 'session.created').map((payload) => payload.properties.info)).toEqual([
      expect.objectContaining({ parentID: SESSION_ID, id: expect.stringMatching(new RegExp(`^${SESSION_ID}_t_toolu_`)) }),
    ]);
    expect(harness.live.busySessionIds(DIRECTORY)).toEqual([]);
  });

  it('names every message and part the way a later history read does', async () => {
    const harness = createHarness();
    await sendPrompt(harness.live);
    await answerQuestion(harness);
    await waitFor(() => payloads(harness.events, 'session.idle').length > 0);

    const history = createClaudeProjection({ sessionId: SESSION_ID, cwd: DIRECTORY });
    for (const entry of fixture('haiku-tools.session-messages.json')) history.applyEntry(entry);
    const idsOf = (records) => records.map((record) => [record.info.id, record.parts.map((part) => part.id)]);
    expect(idsOf(harness.live.liveRecords(SESSION_ID))).toEqual(idsOf(history.records()));
  });

  it('resumes a session that has a transcript and switches model, effort and plan mode in place', async () => {
    const harness = createHarness({ hasTranscript: true });
    await sendPrompt(harness.live);
    await answerQuestion(harness);
    await waitFor(() => payloads(harness.events, 'session.idle').length > 0);
    expect(harness.calls.queries[0].options).toMatchObject({ resume: SESSION_UUID });
    expect(harness.calls.queries[0].options.sessionId).toBeUndefined();

    await sendPrompt(harness.live, {
      messageId: 'ncl_u_b33f0a7a-a88c-4093-a5e3-6653ff44f6d3',
      config: { model: 'opus', effort: 'high', permissionMode: 'plan' },
      send: { modelID: 'opus', variant: 'high', agent: 'plan' },
    });
    expect(harness.calls.queries).toHaveLength(1);
    expect(harness.calls.setModel).toEqual(['opus']);
    expect(harness.calls.applyFlagSettings).toEqual([{ effortLevel: 'high' }]);
    expect(harness.calls.setPermissionMode).toEqual(['plan']);
    await waitFor(() => harness.calls.queries[0].inputs.length === 2);
  });

  it('declines ExitPlanMode in plan mode so the plan stays on screen', async () => {
    const harness = createHarness();
    await sendPrompt(harness.live, { config: { model: 'haiku', effort: null, permissionMode: 'plan' } });
    const { canUseTool } = harness.calls.queries[0].options;
    expect(await canUseTool('ExitPlanMode', { plan: 'Do it' }, { signal: new AbortController().signal, toolUseID: 'toolu_x' }))
      .toMatchObject({ behavior: 'deny' });
    expect(await canUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 'toolu_y' }))
      .toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
  });

  it('interrupts a running turn and rejects the questions it waits on', async () => {
    const harness = createHarness();
    await sendPrompt(harness.live);
    const asked = await waitFor(() => payloads(harness.events, 'question.asked')[0]);
    expect(await harness.live.abort(SESSION_ID)).toBe(true);
    expect(harness.calls.interrupt).toBe(1);
    expect(payloads(harness.events, 'question.rejected')[0].properties.requestID).toBe(asked.properties.id);
    expect(harness.questions.list(DIRECTORY)).toEqual([]);
  });

  it('settles the turn with an error when the CLI exits mid-turn', async () => {
    const harness = createHarness({ failAfter: 40 });
    await sendPrompt(harness.live);
    await waitFor(() => payloads(harness.events, 'session.idle').length > 0);

    const error = payloads(harness.events, 'session.error')[0];
    expect(error.properties).toMatchObject({ sessionID: SESSION_ID, error: { name: 'UnknownError', data: { message: 'claude exited with code 1' } } });
    const assistants = payloads(harness.events, 'message.updated').filter((payload) => payload.properties.info.role === 'assistant');
    expect(assistants.at(-1).properties.info).toMatchObject({ error: { name: 'UnknownError' }, time: { completed: expect.any(Number) } });
    expect(harness.live.liveRecords(SESSION_ID)).toBeNull();
  });

  it('closes an idle query, and the next prompt opens a new one', async () => {
    const harness = createHarness({ idleTimeoutMs: 5 });
    await sendPrompt(harness.live);
    await answerQuestion(harness);
    await waitFor(() => harness.calls.queries[0].closed);
    await waitFor(() => harness.live.liveRecords(SESSION_ID) === null);

    await sendPrompt(harness.live, { messageId: 'ncl_u_c44f0a7a-a88c-4093-a5e3-6653ff44f6d3' });
    expect(harness.calls.queries).toHaveLength(2);
  });

  it('rewinds by replacing the open query with one resumed at the entry, once it exited', async () => {
    const harness = createHarness({ hasTranscript: true, exitDelayMs: 20 });
    await sendPrompt(harness.live);
    await answerQuestion(harness);
    await waitFor(() => payloads(harness.events, 'session.idle').length > 0);

    const rewind = { messageId: 'ncl_u_b33f0a7a-a88c-4093-a5e3-6653ff44f6d3', resumeAt: 'entry-7' };
    await sendPrompt(harness.live, { messageId: 'ncl_u_d55f0a7a-a88c-4093-a5e3-6653ff44f6d3', rewind });
    expect(harness.calls.queries).toHaveLength(2);
    expect(harness.calls.queries[1].previousClosed).toBe(true);
    expect(harness.calls.queries[1].options).toMatchObject({ resume: SESSION_UUID, resumeSessionAt: 'entry-7' });

    // Another prompt for the same rewind joins the query that performs it.
    const asked = await waitFor(() => payloads(harness.events, 'question.asked')[1]);
    await sendPrompt(harness.live, { messageId: 'ncl_u_e66f0a7a-a88c-4093-a5e3-6653ff44f6d3', rewind });
    harness.questions.reply(asked.properties.id, [['blue']]);
    await waitFor(() => harness.calls.queries[1].inputs.length === 2);
    expect(harness.calls.queries).toHaveLength(2);

    // A later revert that resumes at the same entry still needs a fresh query.
    await waitFor(() => payloads(harness.events, 'session.idle').length > 1);
    await sendPrompt(harness.live, {
      messageId: 'ncl_u_f77f0a7a-a88c-4093-a5e3-6653ff44f6d3',
      rewind: { messageId: 'ncl_u_d55f0a7a-a88c-4093-a5e3-6653ff44f6d3', resumeAt: 'entry-7' },
    });
    expect(harness.calls.queries).toHaveLength(3);
    expect(harness.calls.queries[2].options).toMatchObject({ resumeSessionAt: 'entry-7' });
  });

  it('reports when a session goes idle', async () => {
    const idle = [];
    const harness = createHarness({ onIdle: (sessionId, directory) => idle.push([sessionId, directory]) });
    await expect(harness.live.whenIdle(SESSION_ID)).resolves.toBeUndefined();
    await sendPrompt(harness.live);
    let settled = false;
    const waiting = harness.live.whenIdle(SESSION_ID).then(() => {
      settled = true;
    });
    await waitFor(() => payloads(harness.events, 'question.asked')[0]);
    expect(settled).toBe(false);
    await answerQuestion(harness);
    await waiting;
    expect(harness.live.busySessionIds(DIRECTORY)).toEqual([]);
    expect(idle).toEqual([[SESSION_ID, DIRECTORY]]);
  });

  it('lists commands from a query running in the directory, or from one opened just to ask', async () => {
    const harness = createHarness({ exitDelayMs: 1 });
    const expected = [
      { name: 'compact', description: 'Free up context', argumentHint: '<instructions>' },
      { name: 'review-code', description: 'Review', argumentHint: '' },
    ];
    expect(await harness.live.commands(DIRECTORY)).toEqual(expected);
    expect(harness.calls.queries).toHaveLength(1);
    expect(harness.calls.queries[0].options).toMatchObject({ cwd: DIRECTORY });
    expect(harness.calls.queries[0].inputs).toEqual([]);
    await waitFor(() => harness.calls.queries[0].closed);

    await sendPrompt(harness.live);
    await answerQuestion(harness);
    expect(await harness.live.commands(DIRECTORY)).toEqual(expected);
    expect(harness.calls.queries).toHaveLength(2);
    expect(harness.calls.queries[1].listedCommands).toBe(true);
  });

  it('refuses a Windows npm shim with a clear error before the SDK starts anything', async () => {
    const harness = createHarness({ executable: 'C:\\Users\\ada\\AppData\\Roaming\\npm\\claude.cmd', platform: 'win32' });
    await expect(sendPrompt(harness.live)).rejects.toMatchObject({ code: 'NATIVE_CLI_SHIM', status: 503 });
    await expect(harness.live.commands(DIRECTORY)).rejects.toMatchObject({ code: 'NATIVE_CLI_SHIM' });
    expect(harness.calls.queries).toEqual([]);

    const native = createHarness({ executable: 'C:\\Users\\ada\\.local\\bin\\claude.exe', platform: 'win32' });
    await sendPrompt(native.live);
    expect(native.calls.queries[0].options.pathToClaudeCodeExecutable).toBe('C:\\Users\\ada\\.local\\bin\\claude.exe');
  });

  it('refuses a message id the CLI cannot record', async () => {
    const harness = createHarness();
    await expect(sendPrompt(harness.live, { messageId: 'msg_opencode' })).rejects.toMatchObject({ code: 'NATIVE_INVALID_REQUEST' });
    expect(harness.calls.queries).toHaveLength(0);
  });
});

describe('Claude live compaction', () => {
  // The frames Claude Code sends for a /compact, recorded from a real run.
  const compactFrames = [
    { type: 'system', subtype: 'status', status: 'compacting', uuid: 'status-1' },
    { type: 'system', subtype: 'compact_boundary', uuid: '63ff2b53-e3c4-4ba7-a8ce-fbf9d4faa62b', compact_metadata: { trigger: 'manual' } },
    { type: 'user', uuid: '824d60fd-5fb1-44e4-859c-3aeff0ada30f', timestamp: '2026-09-24T14:04:48.857Z', isSynthetic: true, isReplay: false, parent_tool_use_id: null, message: { role: 'user', content: 'This session is being continued from a previous conversation.' } },
    { type: 'user', uuid: '7fb774ff-ade9-40b3-bd25-1559129e17db', timestamp: '2026-09-24T14:04:48.967Z', isReplay: true, parent_tool_use_id: null, message: { role: 'user', content: '<local-command-stdout>Compacted </local-command-stdout>' } },
    { type: 'result', subtype: 'success', is_error: false, num_turns: 0, queued_turn_count: 0 },
  ];

  it('shows a compaction as its marker and summary, named as a history read names them', async () => {
    const events = [];
    const inputs = [];
    const sdk = {
      query: ({ prompt }) => {
        const input = prompt[Symbol.asyncIterator]();
        async function* run() {
          const first = await input.next();
          inputs.push(first.value);
          for (const frame of compactFrames) yield frame;
          await input.next();
        }
        return Object.assign(run(), { interrupt: async () => {}, setModel: async () => {}, applyFlagSettings: async () => {}, setPermissionMode: async () => {} });
      },
    };
    const live = createClaudeLiveSessions({
      loadSdk: async () => sdk,
      resolveExecutable: async () => '/usr/local/bin/claude',
      buildEnv: () => ({}),
      hasTranscript: async () => true,
      publisher: createNativeEventPublisher({ publishNativeEvent: (event) => events.push(event) }),
      questions: createQuestionRegistry({ publish: () => {} }),
    });
    await sendPrompt(live, { content: null, sdkContent: [{ type: 'text', text: '/compact' }] });
    await waitFor(() => payloads(events, 'session.idle').length > 0);

    expect(inputs[0].message.content).toEqual([{ type: 'text', text: '/compact' }]);
    const published = [...new Set(payloads(events, 'message.updated').map((payload) => payload.properties.info.id))];
    const history = createClaudeProjection({ sessionId: SESSION_ID, cwd: DIRECTORY });
    history.applyEntry({ type: 'system', uuid: '63ff2b53-e3c4-4ba7-a8ce-fbf9d4faa62b', timestamp: '2026-09-24T14:04:48.860Z' });
    history.applyEntry({ ...compactFrames[2], isCompactSummary: true, is_meta: true });
    expect(published).toEqual(history.records().map((record) => record.info.id));
    expect(published).toEqual(['ncl_k_63ff2b53-e3c4-4ba7-a8ce-fbf9d4faa62b', 'ncl_k_63ff2b53-e3c4-4ba7-a8ce-fbf9d4faa62b_summary']);
    expect(payloads(events, 'session.error')).toEqual([]);
    await live.shutdown();
  });
});

describe('Claude live task list', () => {
  const assistant = (id, content) => ({ type: 'assistant', uuid: `${id}-entry`, parent_tool_use_id: null, message: { id, model: 'claude-haiku-4-5', content } });
  const toolResult = (toolUseId) => ({ type: 'user', uuid: `${toolUseId}-result`, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'done' }] } });

  it('publishes the task list after a task tool finished, and the list a TodoWrite sets', async () => {
    const events = [];
    const reads = [];
    const frames = [
      assistant('msg_1', [{ type: 'tool_use', id: 'toolu_create', name: 'TaskCreate', input: { subject: 'alpha', description: 'Task alpha' } }]),
      toolResult('toolu_create'),
      assistant('msg_2', [{ type: 'tool_use', id: 'toolu_todo', name: 'TodoWrite', input: { todos: [{ content: 'Plan', status: 'pending', activeForm: 'Planning' }] } }]),
      toolResult('toolu_todo'),
      { type: 'result', subtype: 'success', is_error: false, queued_turn_count: 0 },
    ];
    const sdk = {
      query: ({ prompt }) => {
        const input = prompt[Symbol.asyncIterator]();
        async function* run() {
          await input.next();
          for (const frame of frames) yield frame;
          await input.next();
        }
        return Object.assign(run(), { interrupt: async () => {}, setModel: async () => {}, applyFlagSettings: async () => {}, setPermissionMode: async () => {} });
      },
    };
    const live = createClaudeLiveSessions({
      loadSdk: async () => sdk,
      resolveExecutable: async () => '/usr/local/bin/claude',
      buildEnv: () => ({}),
      hasTranscript: async () => true,
      publisher: createNativeEventPublisher({ publishNativeEvent: (event) => events.push(event) }),
      questions: createQuestionRegistry({ publish: () => {} }),
      readTaskList: async (sessionUuid) => {
        reads.push(sessionUuid);
        return [{ id: '1', content: 'alpha', status: 'pending', priority: 'medium' }];
      },
    });
    await sendPrompt(live);
    await waitFor(() => payloads(events, 'todo.updated').length === 2);
    expect(reads).toEqual([SESSION_UUID]);
    expect(payloads(events, 'todo.updated').map((payload) => payload.properties)).toEqual([
      { sessionID: SESSION_ID, todos: [{ id: '1', content: 'alpha', status: 'pending', priority: 'medium' }] },
      { sessionID: SESSION_ID, todos: [{ id: 'todo-1', content: 'Plan', status: 'pending', priority: 'medium' }] },
    ]);
    await live.shutdown();
  });
});

describe('Claude session store', () => {
  it('reports whether a session has a transcript to resume', async () => {
    const sdk = { getSessionInfo: async (uuid) => (uuid === SESSION_UUID ? { sessionId: uuid, summary: '', lastModified: 1 } : undefined) };
    const registry = { listSessions: async () => [], getSession: async () => null, sendRecords: async () => new Map() };
    const store = createClaudeSessionStore({ loadSdk: async () => sdk, registry });
    expect(await store.hasTranscript(SESSION_UUID, DIRECTORY)).toBe(true);
    expect(await store.hasTranscript('22222222-2222-4222-8222-222222222222', DIRECTORY)).toBe(false);
  });
});
