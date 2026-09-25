// Live Claude Code sessions: one streaming-input query per session that
// OpenChamber is driving. The query stays open between turns, so a prompt
// sent while a turn runs joins that turn at its next tool boundary, and model,
// effort and plan mode change in place without starting a new session.
//
// A query that has been idle for `idleTimeoutMs` is closed; its CLI process
// exits and the next prompt resumes the session from its transcript. At most
// `maxLiveSessions` queries run at once; opening another closes the least
// recently used idle one, and fails when all of them are busy. A new query
// for a session starts only after the previous one has exited, so two CLI
// processes never write one transcript.
//
// The session's task list goes out as OpenCode's todos: TodoWrite sets it in
// its input, and after TaskCreate or TaskUpdate the list is read again from
// the files Claude Code keeps it in.
//
// A prompt that commits a revert carries the rewind: the reverted message and
// the chain entry to resume at. The open query holds the whole conversation,
// so it is replaced by one that resumes at that entry; later prompts for the
// same revert join that query.

import { z } from 'zod';

import { claudeShimError, cliMissingError, invalidRequestError, NativeAgentError } from '../errors.js';
import { isWindowsShim } from '../executables.js';
import { decodeNativeSessionId, encodeClaudeChildSessionId } from '../ids.js';
import { buildSessionRecord } from '../records.js';
import { claudeAbortedError, claudeTurnError, createClaudeProjection } from './projector.js';
import { todosFromTodoWrite } from './tasks.js';

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
const COMMANDS_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_LIVE_SESSIONS = 6;
const STDERR_TAIL_CHARS = 4000;
const USER_MESSAGE_ID = /^ncl_u_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

const PLAN_DECLINED = 'The user did not approve implementation. Keep the session in plan mode.';
const QUESTION_DISMISSED = 'The user dismissed the question without answering.';

const exitPlanInput = z.object({ plan: z.string().optional() });

const askUserQuestionInput = z.object({
  questions: z.array(z.object({
    question: z.string(),
    header: z.string().catch(''),
    options: z.array(z.object({ label: z.string(), description: z.string().catch('') }).passthrough()).catch([]),
    multiSelect: z.boolean().optional(),
  }).passthrough()).min(1),
}).passthrough();

const slashCommandSchema = z.object({
  name: z.string().min(1),
  description: z.string().catch(''),
  argumentHint: z.string().catch(''),
}).passthrough();

const resultFrameSchema = z.object({
  type: z.literal('result'),
  subtype: z.string(),
  is_error: z.boolean().catch(false),
  result: z.string().optional(),
  errors: z.array(z.string()).optional(),
  terminal_reason: z.string().nullish(),
  queued_turn_count: z.number().optional(),
}).passthrough();

const taskToolUse = z.object({ description: z.string().optional(), subagent_type: z.string().optional() }).passthrough();

// Tools that change the task list Claude Code keeps in files.
const TASK_LIST_TOOLS = new Set(['TaskCreate', 'TaskUpdate']);
const frameBlocksSchema = z.object({
  message: z.object({
    content: z.array(z.object({
      type: z.string(),
      id: z.string().optional(),
      name: z.string().optional(),
      input: z.unknown().optional(),
      tool_use_id: z.string().optional(),
    }).passthrough()).catch([]),
  }).passthrough(),
}).passthrough();

const createInputQueue = () => {
  const items = [];
  let wake = null;
  let closed = false;
  return {
    push(message) {
      items.push(message);
      wake?.();
      wake = null;
    },
    close() {
      closed = true;
      wake?.();
      wake = null;
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (items.length > 0) {
          yield items.shift();
          continue;
        }
        if (closed) return;
        await new Promise((resolve) => {
          wake = resolve;
        });
      }
    },
  };
};

const turnErrorOf = (frame) => {
  if (frame.terminal_reason === 'aborted_streaming' || frame.terminal_reason === 'aborted_tools') return claudeAbortedError();
  if (frame.subtype === 'success' && !frame.is_error) return null;
  const message = [frame.result, ...(frame.errors ?? [])].filter((text) => text).join('\n') || frame.subtype;
  return claudeTurnError(message);
};

/**
 * @typedef {{ model: string | null, effort: string | null, permissionMode: 'bypassPermissions' | 'plan' }} LiveConfig
 * @typedef {{ kind: 'text', text: string } | { kind: 'blocks', blocks: object[] }} PromptContent
 * @typedef {{ messageId: string, resumeAt: string }} Rewind the reverted message, and the entry before it
 */

/**
 * @param {object} options
 * @param {() => Promise<import('@anthropic-ai/claude-agent-sdk')>} options.loadSdk
 * @param {() => Promise<string | null>} options.resolveExecutable path of the user's `claude`
 * @param {() => Record<string, string>} options.buildEnv
 * @param {(sessionUuid: string, directory: string) => Promise<boolean>} options.hasTranscript
 * @param {ReturnType<typeof import('../publisher.js').createNativeEventPublisher>} options.publisher
 * @param {ReturnType<typeof import('../questions.js').createQuestionRegistry>} options.questions
 * @param {(sessionId: string, directory: string) => void} [options.onTurnFinished] the CLI finished a turn and wrote it to the transcript
 * @param {(sessionId: string, directory: string) => void} [options.onIdle] the session stopped running turns
 * @param {(sessionUuid: string) => Promise<Array<{ id: string, content: string, status: string, priority: string }>>} [options.readTaskList]
 *   the session's task list as todos
 * @param {() => number} [options.now]
 * @param {number} [options.idleTimeoutMs]
 * @param {number} [options.maxLiveSessions]
 * @param {NodeJS.Platform} [options.platform]
 */
export const createClaudeLiveSessions = ({
  loadSdk,
  resolveExecutable,
  buildEnv,
  hasTranscript,
  publisher,
  questions,
  // Appended to Claude Code's system prompt, which the CLI records with the
  // conversation's first request.
  readGlobalInstructions = async () => null,
  onTurnFinished = () => {},
  onIdle = () => {},
  readTaskList = async () => [],
  now = Date.now,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  maxLiveSessions = DEFAULT_MAX_LIVE_SESSIONS,
  platform = process.platform,
}) => {
  /** @type {Map<string, object>} */
  const sessions = new Map();

  // The Agent SDK starts `claude` without a shell, which a Windows npm shim
  // needs; the shim's arguments are JSON that `cmd.exe` would mangle.
  const launchableExecutable = async () => {
    const executable = await resolveExecutable();
    if (!executable) throw cliMissingError('claude');
    if (isWindowsShim(executable, platform)) throw claudeShimError(executable);
    return executable;
  };
  /** @type {Map<string, Promise<void>>} session id → exit of its closed query */
  const exits = new Map();

  const publishRecords = (live, messageIds) => {
    const records = [];
    for (const id of new Set(messageIds)) {
      const record = live.projection.record(id);
      if (record) records.push(record);
    }
    publisher.records(live.directory, live.sessionId, records);
  };

  // A Task tool call opens a subagent session the UI can navigate to.
  const announceSubagents = (live, messageIds) => {
    for (const id of new Set(messageIds)) {
      const record = live.projection.record(id);
      for (const part of record?.parts ?? []) {
        if (part.type !== 'tool' || part.tool !== 'task' || live.subagents.has(part.callID)) continue;
        live.subagents.add(part.callID);
        const input = taskToolUse.safeParse(part.state.input);
        publisher.session(live.directory, buildSessionRecord({
          id: encodeClaudeChildSessionId(live.sessionUuid, part.callID),
          backend: 'claude',
          directory: live.directory,
          title: input.data?.description ?? input.data?.subagent_type ?? 'Subagent',
          created: part.state.time.start,
          updated: part.state.time.start,
          parentID: live.sessionId,
        }), { created: true });
      }
    }
  };

  // Task lists go out one at a time per session, in the order the CLI changed them.
  const publishTodos = (live, todosOf) => {
    live.todoUpdates = live.todoUpdates.then(async () => {
      try {
        publisher.todos(live.directory, live.sessionId, await todosOf());
      } catch (error) {
        console.warn('[native-agents] could not read the Claude Code task list:', live.sessionId, error instanceof Error ? error.message : error);
      }
    });
  };

  const trackTaskList = (live, frame) => {
    const blocks = frameBlocksSchema.safeParse(frame).data?.message.content ?? [];
    let changed = false;
    for (const block of blocks) {
      if (block.type === 'tool_use' && block.name === 'TodoWrite') {
        const todos = todosFromTodoWrite(block.input);
        if (todos) publishTodos(live, async () => todos);
      } else if (block.type === 'tool_use' && block.id && block.name && TASK_LIST_TOOLS.has(block.name)) {
        live.taskToolUses.add(block.id);
      } else if (block.type === 'tool_result' && block.tool_use_id && live.taskToolUses.delete(block.tool_use_id)) {
        changed = true;
      }
    }
    if (changed) publishTodos(live, () => readTaskList(live.sessionUuid));
  };

  const clearIdleTimer = (live) => {
    if (live.idleTimer) clearTimeout(live.idleTimer);
    live.idleTimer = null;
  };

  const close = (live) => {
    clearIdleTimer(live);
    if (live.closing) return;
    live.closing = true;
    questions.rejectSession(live.sessionId);
    exits.set(live.sessionId, live.exited);
    live.input.close();
    // The CLI exits once its input ends; the abort is the backstop.
    setTimeout(() => live.abortController.abort(), 5_000).unref?.();
  };

  const scheduleIdleClose = (live) => {
    clearIdleTimer(live);
    live.idleTimer = setTimeout(() => close(live), idleTimeoutMs);
    live.idleTimer.unref?.();
  };

  const settleIdle = (live, error) => {
    live.busy = false;
    live.lastActive = now();
    questions.rejectSession(live.sessionId);
    publisher.status(live.directory, live.sessionId, 'idle');
    if (error !== null && error.name !== 'MessageAbortedError') publisher.error(live.directory, live.sessionId, error);
    onIdle(live.sessionId, live.directory);
    for (const resolve of live.idleWaiters.splice(0)) resolve();
  };

  const finishTurn = (live, frame) => {
    const error = turnErrorOf(frame);
    publishRecords(live, live.projection.finishTurn({ error }));
    onTurnFinished(live.sessionId, live.directory);
    if ((frame.queued_turn_count ?? 0) > 0) return;
    settleIdle(live, error);
    scheduleIdleClose(live);
  };

  const handleFrame = (live, frame) => {
    if (frame.type === 'stream_event') {
      const { changed, delta } = live.projection.applyStreamEvent(frame);
      if (changed.length > 0) publishRecords(live, changed);
      if (delta) publisher.delta(live.directory, delta);
      return;
    }
    if (frame.type === 'system') {
      // A compaction's boundary opens its marker, as in the transcript; the
      // summary follows as a synthetic user frame. Other system frames report
      // state the records already show.
      if (frame.subtype !== 'compact_boundary') return;
      live.compactSummaryNext = true;
      publishRecords(live, live.projection.applyEntry(frame));
      return;
    }
    if (frame.type === 'assistant' || frame.type === 'user') {
      // Subagent frames belong to the subagent's own session.
      if (frame.parent_tool_use_id) return;
      // A replay echoes a local command's output, which the transcript keeps out of the conversation.
      if (frame.type === 'user' && frame.isReplay === true) return;
      const summary = frame.type === 'user' && live.compactSummaryNext && frame.isSynthetic === true;
      live.compactSummaryNext = false;
      const changed = live.projection.applyEntry(summary ? { ...frame, isCompactSummary: true } : frame);
      publishRecords(live, changed);
      announceSubagents(live, changed);
      trackTaskList(live, frame);
      return;
    }
    if (frame.type === 'result') {
      const parsed = resultFrameSchema.safeParse(frame);
      if (parsed.success) finishTurn(live, parsed.data);
    }
  };

  const ended = (live, failure) => {
    clearIdleTimer(live);
    if (sessions.get(live.sessionId) === live) sessions.delete(live.sessionId);
    if (live.busy) {
      const reason = live.closing
        ? claudeAbortedError()
        : claudeTurnError(failure ?? (live.stderrTail.trim() || 'Claude Code exited before the turn finished.'));
      publishRecords(live, live.projection.finishTurn({ error: reason }));
      settleIdle(live, reason);
    }
    publisher.forget(live.sessionId);
    if (exits.get(live.sessionId) === live.exited) exits.delete(live.sessionId);
    live.markExited();
  };

  const consume = async (live) => {
    try {
      for await (const frame of live.query) handleFrame(live, frame);
      ended(live, null);
    } catch (error) {
      ended(live, error instanceof Error ? error.message : String(error));
    }
  };

  const canUseTool = async (live, toolName, input, context) => {
    if (toolName === 'ExitPlanMode') {
      const messageID = live.projection.openAssistantId();
      const outcome = await questions.ask({
        directory: live.directory,
        sessionID: live.sessionId,
        kind: 'claude-plan-exit',
        questions: [{
          question: exitPlanInput.safeParse(input).data?.plan ?? '',
          header: 'ExitPlanMode',
          options: [{ label: 'build', description: '' }, { label: 'plan', description: '' }],
          multiple: false,
        }],
        tool: messageID && context.toolUseID ? { messageID, callID: context.toolUseID } : undefined,
        signal: context.signal,
      });
      if (outcome.status === 'rejected' || context.signal.aborted || live.closing) {
        return { behavior: 'deny', message: PLAN_DECLINED, interrupt: true };
      }
      const answer = outcome.answers.length === 1 && outcome.answers[0].length === 1 ? outcome.answers[0][0] : '';
      if (answer !== 'build') {
        return answer && answer !== 'plan'
          ? { behavior: 'deny', message: `The user requested changes to the plan: ${answer}` }
          : { behavior: 'deny', message: PLAN_DECLINED, interrupt: true };
      }
      live.config = { ...live.config, permissionMode: 'bypassPermissions' };
      return {
        behavior: 'allow',
        updatedInput: input,
        updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }],
      };
    }
    if (toolName !== 'AskUserQuestion') return { behavior: 'allow', updatedInput: input };
    const parsed = askUserQuestionInput.safeParse(input);
    if (!parsed.success) return { behavior: 'allow', updatedInput: input };
    const messageID = live.projection.openAssistantId();
    const outcome = await questions.ask({
      directory: live.directory,
      sessionID: live.sessionId,
      questions: parsed.data.questions.map((question) => ({
        question: question.question,
        header: question.header,
        options: question.options.map((option) => ({ label: option.label, description: option.description })),
        multiple: question.multiSelect === true,
      })),
      tool: messageID && context.toolUseID ? { messageID, callID: context.toolUseID } : undefined,
      signal: context.signal,
    });
    if (outcome.status === 'rejected') return { behavior: 'deny', message: QUESTION_DISMISSED };
    const answers = Object.fromEntries(parsed.data.questions.map((question, index) => [
      question.question,
      (outcome.answers[index] ?? []).join(', '),
    ]));
    return { behavior: 'allow', updatedInput: { ...input, answers } };
  };

  const makeRoom = () => {
    if (sessions.size < maxLiveSessions) return;
    const idle = Array.from(sessions.values()).filter((live) => !live.busy && !live.closing);
    if (idle.length === 0) {
      throw new NativeAgentError(
        `${maxLiveSessions} Claude Code sessions are already running`,
        { code: 'NATIVE_TOO_MANY_SESSIONS', status: 429 },
      );
    }
    idle.sort((left, right) => left.lastActive - right.lastActive);
    const oldest = idle[0];
    sessions.delete(oldest.sessionId);
    close(oldest);
  };

  /** @param {{ sessionId: string, sessionUuid: string, directory: string, config: LiveConfig, rewind: Rewind | null }} input */
  const start = async ({ sessionId, sessionUuid, directory, config, rewind }) => {
    makeRoom();
    const [sdk, executable, resume, instructions] = await Promise.all([
      loadSdk(),
      launchableExecutable(),
      rewind === null ? hasTranscript(sessionUuid, directory) : true,
      readGlobalInstructions(),
    ]);
    let markExited = () => {};
    const exited = new Promise((resolve) => {
      markExited = resolve;
    });
    const live = {
      sessionId,
      sessionUuid,
      directory,
      config,
      rewind,
      input: createInputQueue(),
      abortController: new AbortController(),
      sends: new Map(),
      subagents: new Set(),
      busy: false,
      closing: false,
      idleTimer: null,
      idleWaiters: [],
      compactSummaryNext: false,
      taskToolUses: new Set(),
      todoUpdates: Promise.resolve(),
      exited,
      markExited,
      lastActive: now(),
      stderrTail: '',
      query: null,
      projection: null,
    };
    live.projection = createClaudeProjection({
      sessionId,
      cwd: directory,
      live: true,
      now,
      sendRecordFor: (messageId) => live.sends.get(messageId) ?? null,
      childSessionIdForToolUse: (toolUseId) => encodeClaudeChildSessionId(sessionUuid, toolUseId),
    });
    const options = {
      cwd: directory,
      pathToClaudeCodeExecutable: executable,
      env: buildEnv(),
      systemPrompt: instructions === null
        ? { type: 'preset', preset: 'claude_code' }
        : { type: 'preset', preset: 'claude_code', append: instructions },
      permissionMode: config.permissionMode,
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      abortController: live.abortController,
      canUseTool: (toolName, input, context) => canUseTool(live, toolName, input, context),
      stderr: (data) => {
        live.stderrTail = (live.stderrTail + data).slice(-STDERR_TAIL_CHARS);
      },
    };
    if (config.model !== null) options.model = config.model;
    if (config.effort !== null) options.effort = config.effort;
    if (resume) options.resume = sessionUuid;
    else options.sessionId = sessionUuid;
    if (rewind !== null) options.resumeSessionAt = rewind.resumeAt;
    live.query = sdk.query({ prompt: live.input, options });
    sessions.set(sessionId, live);
    void consume(live);
    return live;
  };

  const applyConfig = async (live, config) => {
    if (config.model !== live.config.model) await live.query.setModel(config.model ?? undefined);
    if (config.effort !== live.config.effort) await live.query.applyFlagSettings({ effortLevel: config.effort });
    if (config.permissionMode !== live.config.permissionMode) await live.query.setPermissionMode(config.permissionMode);
    live.config = config;
  };

  return {
    /**
     * Sends a prompt. Opens the session's query when none is running; while
     * a turn runs, the prompt joins it at its next tool boundary.
     * @param {object} input
     * @param {string} input.sessionId
     * @param {string} input.directory
     * @param {string} input.messageId `ncl_u_<uuid>`, recorded by the CLI as the entry uuid
     * @param {PromptContent | null} input.content projected user content; null for a
     *   command whose effect shows instead, such as `/compact`
     * @param {object[]} input.sdkContent content blocks sent to the CLI
     * @param {LiveConfig} input.config
     * @param {{ modelID: string, variant?: string, agent: string }} input.send what the user message shows
     * @param {Rewind | null} [input.rewind] a revert this prompt commits
     */
    async prompt({ sessionId, directory, messageId, content, sdkContent, config, send, rewind = null }) {
      const decoded = decodeNativeSessionId(sessionId);
      if (!decoded || decoded.backend !== 'claude' || decoded.toolUseId !== null) {
        throw invalidRequestError('Prompts go to a Claude Code session, not a subagent');
      }
      const uuid = USER_MESSAGE_ID.exec(messageId)?.[1];
      if (!uuid) throw invalidRequestError(`Not a Claude user message id: ${messageId}`);
      let live = sessions.get(sessionId);
      // A query started for this revert has rewound already; another prompt joins it.
      if (live && (live.closing || (rewind !== null && live.rewind?.messageId !== rewind.messageId))) {
        close(live);
        live = undefined;
      }
      if (live) {
        await applyConfig(live, config);
      } else {
        await exits.get(sessionId);
        live = await start({ sessionId, sessionUuid: decoded.sessionUuid, directory, config, rewind });
      }
      clearIdleTimer(live);
      live.lastActive = now();
      live.sends.set(messageId, send);
      if (content !== null) publishRecords(live, live.projection.startUserPrompt(messageId, content));
      live.input.push({
        type: 'user',
        message: { role: 'user', content: sdkContent },
        parent_tool_use_id: null,
        uuid,
        origin: { kind: 'human' },
        priority: 'next',
      });
      if (!live.busy) {
        live.busy = true;
        publisher.status(live.directory, sessionId, 'busy');
      }
    },

    /** Stops the running turn; the CLI reports it as interrupted. */
    async abort(sessionId) {
      const live = sessions.get(sessionId);
      if (!live?.busy) return false;
      questions.rejectSession(sessionId);
      await live.query.interrupt();
      return true;
    },

    /**
     * Closes the session's query and waits for its CLI process to exit, so
     * nothing writes the transcript afterwards.
     */
    async closeSession(sessionId) {
      const live = sessions.get(sessionId);
      if (live) close(live);
      await exits.get(sessionId);
    },

    /**
     * The slash commands Claude Code offers in a directory. A query running
     * there answers; otherwise a query is opened just to ask, which sends no
     * prompt and so leaves no transcript, and is closed again.
     * @returns {Promise<Array<{ name: string, description: string, argumentHint: string }>>}
     */
    async commands(directory) {
      const parse = (commands) => commands.map((command) => slashCommandSchema.safeParse(command))
        .filter((command) => command.success)
        .map(({ data }) => ({ name: data.name, description: data.description, argumentHint: data.argumentHint }));
      const running = Array.from(sessions.values()).find((live) => live.directory === directory && !live.closing);
      if (running) return parse(await running.query.supportedCommands());

      const [sdk, executable] = await Promise.all([loadSdk(), launchableExecutable()]);
      const input = createInputQueue();
      const abortController = new AbortController();
      const query = sdk.query({
        prompt: input,
        options: {
          cwd: directory,
          pathToClaudeCodeExecutable: executable,
          env: buildEnv(),
          systemPrompt: { type: 'preset', preset: 'claude_code' },
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          abortController,
        },
      });
      // The query sends no frames before a prompt; reading them lets it end.
      void (async () => {
        try {
          for await (const frame of query) void frame;
        } catch {
          // The listing's own result decides the outcome.
        }
      })();
      let timer = null;
      try {
        const timedOut = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Claude Code did not list its commands in time')), COMMANDS_TIMEOUT_MS);
        });
        return parse(await Promise.race([query.supportedCommands(), timedOut]));
      } finally {
        clearTimeout(timer);
        input.close();
        setTimeout(() => abortController.abort(), 5_000).unref?.();
      }
    },

    /** Resolves once the session runs no turn. */
    whenIdle(sessionId) {
      const live = sessions.get(sessionId);
      if (!live?.busy) return Promise.resolve();
      return new Promise((resolve) => {
        live.idleWaiters.push(resolve);
      });
    },

    /**
     * Records of the running query, newest state, for history reads to
     * overlay. A closing query adds nothing: its turns are in the transcript,
     * and a revert may have dropped them from the conversation.
     */
    liveRecords(sessionId) {
      const live = sessions.get(sessionId);
      return live && !live.closing ? live.projection.records() : null;
    },

    /** @param {string} directory */
    busySessionIds(directory) {
      return Array.from(sessions.values())
        .filter((live) => live.busy && live.directory === directory)
        .map((live) => live.sessionId);
    },

    async shutdown() {
      const running = Array.from(sessions.values());
      for (const live of running) close(live);
      for (const live of running) live.abortController.abort();
    },
  };
};
