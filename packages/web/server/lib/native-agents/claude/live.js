// Live Claude Code sessions: one streaming-input query per session that
// OpenChamber is driving. The query stays open between turns, so a prompt
// sent while a turn runs joins that turn at its next tool boundary, and model,
// effort and plan mode change in place without starting a new session.
//
// Not every turn starts with a prompt: when a background task finishes, the
// CLI hands its notification to the model and runs a turn on its own. That
// turn's first model request marks the session busy the way a prompt does,
// and its result settles it. Between turns the session's background tasks go
// out as their own list, so clients can show that it will continue.
//
// A query with no turn or background work for `idleTimeoutMs` is closed; its CLI
// process exits and the next prompt resumes the session from its transcript. At most
// `maxLiveSessions` queries run at once; opening another closes the least
// recently used idle one, and fails when all of them are busy. A new query
// for a session starts only after the previous one has exited, so two CLI
// processes never write one transcript.
//
// Checklists and query-scoped task details publish native snapshots. Successful
// tool results trigger checklist reads; token events never touch task files.
//
// A prompt that commits a revert carries the rewind: the reverted message and
// the chain entry to resume at. The open query holds the whole conversation,
// so it is replaced by one that resumes at that entry; later prompts for the
// same revert join that query.

import { z } from 'zod';

import { invalidRequestError, NativeAgentError } from '../errors.js';
import { launchableClaudeExecutable } from '../executables.js';
import { decodeNativeSessionId, encodeClaudeChildSessionId, encodeClaudeSessionId } from '../ids.js';
import { claudeAbortedError, claudeTurnError, createClaudeProjection } from './projector.js';
import { prepareClaudeConnection, redactClaudeConnectionError } from './connections.js';
import { claudeChecklistSource, createClaudeChecklists, todosFromTodoWrite } from './tasks.js';
import { claudeTaskOutputRoot, createClaudeBackgroundTasks } from './background-tasks.js';
import { createClaudeSubagents } from './subagents.js';

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

const sameBackgroundTasks = (left, right) => left.length === right.length
  && left.every((task, index) => task.id === right[index].id
    && task.type === right[index].type
    && task.description === right[index].description);

// The first event of a model request. Subagent frames are routed away before
// this is checked, so it names a request of the main conversation.
const messageStartSchema = z.object({ event: z.object({ type: z.literal('message_start') }) });

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

const structuredTaskOutput = z.object({
  agentId: z.string().optional(), taskId: z.string().optional(), backgroundTaskId: z.string().optional(),
  output_file: z.string().optional(), outputFile: z.string().optional(),
});

// The ID Claude Code's own TaskCreate result names, which is the only account
// of a task created before anyone read the list.
const createdTaskOutput = z.object({
  task: z.object({ id: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/) }).passthrough(),
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

const turnErrorOf = (frame, launch) => {
  if (frame.terminal_reason === 'aborted_streaming' || frame.terminal_reason === 'aborted_tools') return claudeAbortedError();
  if (frame.subtype === 'success' && !frame.is_error) return null;
  const message = [frame.result, ...(frame.errors ?? [])].filter((text) => text).join('\n') || frame.subtype;
  return claudeTurnError(redactClaudeConnectionError(message, launch));
};

/**
 * @typedef {{ model: string | null, effort: string | null, permissionMode: 'bypassPermissions' | 'plan', launch?: Awaited<ReturnType<ReturnType<typeof import('./connections.js').createClaudeConnections>['resolve']>> }} LiveConfig
 * @typedef {{ kind: 'text', text: string } | { kind: 'blocks', blocks: object[] }} PromptContent
 * @typedef {{ messageId: string, resumeAt: string }} Rewind the reverted message, and the entry before it
 */

/**
 * @param {object} options
 * @param {() => Promise<import('@anthropic-ai/claude-agent-sdk')>} options.loadSdk
 * @param {() => Promise<string | null>} options.resolveExecutable path of the user's `claude`
 * @param {() => Record<string, string>} options.buildEnv
 * @param {(sessionUuid: string, directory: string) => Promise<boolean>} options.hasTranscript
 * @param {(sessionUuid: string, directory: string) => Promise<{ toolReferences: string[], hasRemovedPlanReplayState: boolean }>} [options.inspectReplayHistory] provider-specific blocks in the active replay chain
 * @param {ReturnType<typeof import('../publisher.js').createNativeEventPublisher>} options.publisher
 * @param {ReturnType<typeof import('../questions.js').createQuestionRegistry>} options.questions
 * @param {(sessionId: string, directory: string, turn: { id?: string, summary: string, status: string }) => void} [options.onTurnFinished] the CLI finished a turn and wrote it to the transcript
 * @param {(sessionId: string, directory: string) => void} [options.onIdle] the session stopped running turns
 * @param {ReturnType<typeof createClaudeChecklists>} [options.checklists] shared checklist owner
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
  inspectReplayHistory = async () => ({ toolReferences: [], hasRemovedPlanReplayState: false }),
  publisher,
  questions,
  // Appended to Claude Code's system prompt, which the CLI records with the
  // conversation's first request.
  readGlobalInstructions = async () => null,
  onTurnFinished = () => {},
  onIdle = () => {},
  onChecklistSource = async () => {},
  now = Date.now,
  checklists = createClaudeChecklists({ publisher, now }),
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  maxLiveSessions = DEFAULT_MAX_LIVE_SESSIONS,
  platform = process.platform,
}) => {
  /** @type {Map<string, object>} */
  const sessions = new Map();
  // A runtime-wide sequence is monotonic for each session across query replacement.
  let taskRevision = 0;
  const nextTaskRevision = () => ++taskRevision;

  const launchableExecutable = () => launchableClaudeExecutable(resolveExecutable, platform);
  /** @type {Map<string, Promise<void>>} session id → exit of its closed query */
  const exits = new Map();
  const pendingPrompts = new Map();
  const serializePrompt = (sessionId, work) => {
    const previous = pendingPrompts.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    pendingPrompts.set(sessionId, next);
    return next.finally(() => {
      if (pendingPrompts.get(sessionId) === next) pendingPrompts.delete(sessionId);
    });
  };

  const publishRecords = (live, messageIds) => {
    const records = [];
    for (const id of new Set(messageIds)) {
      const record = live.projection.record(id);
      if (record) records.push(record);
    }
    publisher.records(live.directory, live.sessionId, records);
  };

  const observeTools = (live, frame) => {
    if (frame.isReplay === true) return;
    const blocks = frameBlocksSchema.safeParse(frame).data?.message.content ?? [];
    const owner = frame.parent_tool_use_id
      ? encodeClaudeChildSessionId(live.sessionUuid, frame.parent_tool_use_id) : live.sessionId;
    for (const block of blocks) {
      if (block.type === 'tool_use' && block.id && block.name) {
        if (TASK_LIST_TOOLS.has(block.name) || block.name === 'TodoWrite' || ['Agent', 'Task', 'Bash'].includes(block.name)) {
          live.taskToolUses.set(block.id, { name: block.name, owner, todos: block.name === 'TodoWrite' ? todosFromTodoWrite(block.input) : null });
        }
      } else if (block.type === 'tool_result' && block.tool_use_id) {
        const call = live.taskToolUses.get(block.tool_use_id);
        if (!call) continue;
        live.taskToolUses.delete(block.tool_use_id);
        if (block.is_error === true) continue;
        if (TASK_LIST_TOOLS.has(call.name)) {
          // Task tools in children share the query's explicit file-list source.
          // A creation names the task it added, so a list nobody has read yet
          // still knows which entry is this plan's; without that account the
          // read only refreshes, and the next complete one decides.
          const created = call.name === 'TaskCreate' ? createdTaskOutput.safeParse(frame.tool_use_result) : null;
          const refresh = created?.success
            ? checklists.created(live.sessionId, created.data.task.id)
            : checklists.changed(live.sessionId);
          void refresh.catch(() => {});
        } else if (call.name === 'TodoWrite' && call.todos) {
          if (call.owner !== live.sessionId && !checklists.source(call.owner)) {
            checklists.bind(call.owner, live.directory, { identity: `todo:${call.owner}`, todoOnly: true });
            live.childChecklists.add(call.owner);
          }
          checklists.todoWrite(call.owner, call.todos);
        }
        // Only CLI-owned structured results of built-in task tools can grant
        // an output path. A tool's rendered text or an MCP payload cannot.
        const result = structuredTaskOutput.safeParse(frame.tool_use_result);
        if (result.success && ['Agent', 'Task', 'Bash'].includes(call.name)) {
          const data = result.data;
          const taskId = data.agentId ?? data.taskId ?? data.backgroundTaskId;
          if (taskId) live.tasks.outputFromTool({ taskId, toolUseId: block.tool_use_id, file: data.output_file ?? data.outputFile });
        }
      }
    }
  };

  const clearIdleTimer = (live) => {
    if (live.idleTimer) clearTimeout(live.idleTimer);
    live.idleTimer = null;
  };

  const close = (live) => {
    clearIdleTimer(live);
    if (live.closing) return;
    live.closing = true;
    live.tasks.close();
    questions.rejectSession(live.sessionId);
    exits.set(live.sessionId, live.exited);
    live.input.close();
    // The CLI exits once its input ends; the abort is the backstop.
    setTimeout(() => live.abortController.abort(), 5_000).unref?.();
  };

  const scheduleIdleClose = (live) => {
    clearIdleTimer(live);
    if (live.busy || live.backgroundTasks.length > 0 || live.closing) return;
    live.idleTimer = setTimeout(() => close(live), idleTimeoutMs);
    live.idleTimer.unref?.();
  };

  // A running turn keeps its query open and shows the session working.
  const markBusy = (live) => {
    clearIdleTimer(live);
    if (live.busy) return;
    live.busy = true;
    publisher.status(live.directory, live.sessionId, 'busy');
  };

  // The CLI sends its full live set whenever it changes. Watchers marked
  // ambient are not work. Only the edge between none and some moves idle
  // cleanup, so a repeated or reworded set never postpones it.
  const applyBackgroundTasks = (live, tasks) => {
    const wasRunning = live.backgroundTasks.length > 0;
    if (!sameBackgroundTasks(live.backgroundTasks, tasks)) {
      live.backgroundTasks = tasks;
      publisher.backgroundTasks(live.directory, live.sessionId, tasks);
    }
    const running = tasks.length > 0;
    if (running === wasRunning) return;
    if (running) clearIdleTimer(live);
    else scheduleIdleClose(live);
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
    const error = turnErrorOf(frame, live.config.launch);
    publishRecords(live, live.projection.finishTurn({ error }));
    if (error?.name === 'MessageAbortedError') live.subagents.stop(error);
    const reply = live.projection.records().findLast((record) => record.info.role === 'assistant');
    onTurnFinished(live.sessionId, live.directory, {
      id: reply?.info.id, summary: reply?.parts.findLast((part) => part.type === 'text')?.text ?? '',
      status: error ? 'interrupted' : 'completed',
    });
    if ((frame.queued_turn_count ?? 0) > 0) return;
    settleIdle(live, error);
    scheduleIdleClose(live);
  };

  const handleFrame = (live, frame) => {
    if (live.tasks.observe(frame)) applyBackgroundTasks(live, live.tasks.activity());
    if (frame.type === 'assistant' || frame.type === 'user') observeTools(live, frame);
    if (live.subagents.handleFrame(frame)) return;
    if (frame.type === 'stream_event') {
      // A turn the CLI started itself shows first as its model request.
      if (!live.busy && messageStartSchema.safeParse(frame).success) markBusy(live);
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
      // A replay echoes a local command's output, which the transcript keeps out of the conversation.
      if (frame.type === 'user' && frame.isReplay === true) return;
      const summary = frame.type === 'user' && live.compactSummaryNext && frame.isSynthetic === true;
      live.compactSummaryNext = false;
      const changed = live.projection.applyEntry(summary ? { ...frame, isCompactSummary: true } : frame);
      publishRecords(live, changed);
      live.subagents.announce(live.sessionId, live.projection, changed);
      return;
    }
    if (frame.type === 'result') {
      const parsed = resultFrameSchema.safeParse(frame);
      if (parsed.success) finishTurn(live, parsed.data);
    }
  };

  const ended = (live, failure) => {
    if (failure) failure = redactClaudeConnectionError(failure, live.config.launch);
    live.stderrTail = redactClaudeConnectionError(live.stderrTail, live.config.launch);
    clearIdleTimer(live);
    if (sessions.get(live.sessionId) === live) sessions.delete(live.sessionId);
    if (live.busy) {
      const reason = live.closing
        ? claudeAbortedError()
        : claudeTurnError(failure ?? (live.stderrTail.trim() || 'Claude Code exited before the turn finished.'));
      publishRecords(live, live.projection.finishTurn({ error: reason }));
      settleIdle(live, reason);
    }
    live.subagents.dispose(live.closing ? claudeAbortedError()
      : claudeTurnError(failure ?? 'Claude Code exited before the subagent finished.'));
    // Nothing wakes the session once its CLI is gone.
    if (live.backgroundTasks.length > 0) {
      live.backgroundTasks = [];
      publisher.backgroundTasks(live.directory, live.sessionId, []);
    }
    live.tasks.close();
    for (const child of live.childChecklists) checklists.forget(child);
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
    } finally {
      await live.connection.dispose();
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
    const idle = Array.from(sessions.values()).filter((live) => !live.busy && live.backgroundTasks.length === 0 && !live.closing);
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
    // Refuse incompatible history before a CLI process writes an upstream
    // rejection into the transcript. The CLI owns the active replay chain.
    if (resume) {
      const history = await inspectReplayHistory(sessionUuid, directory);
      if (history.hasRemovedPlanReplayState) {
        throw new NativeAgentError(
          'This session was created with the ChatGPT plan connection, which this version no longer supports. Its history stays readable, but it cannot be continued; start a new session to keep working.',
          { code: 'NATIVE_GPT_REPLAY_UNRESUMABLE', status: 400 },
        );
      }
      if ((config.launch?.env || config.launch?.acquire) && history.toolReferences.length > 0) {
        const target = config.launch.descriptor?.name ?? 'this connection';
        throw new NativeAgentError(
          `This session's history contains Tool Search references (${history.toolReferences.join(', ')}) that only Anthropic's endpoint accepts; ${target} rejects them with HTTP 400 on every send. Continue the session with the original Anthropic login, or start a new session with this model.`,
          { code: 'NATIVE_HISTORY_NOT_PORTABLE', status: 400 },
        );
      }
    }
    const connection = await prepareClaudeConnection(config.launch, buildEnv());
    let markExited = () => {};
    const exited = new Promise((resolve) => {
      markExited = resolve;
    });
    const live = {
      sessionId,
      sessionUuid,
      directory,
      connection,
      config,
      rewind,
      input: createInputQueue(),
      abortController: new AbortController(),
      sends: new Map(),
      subagents: createClaudeSubagents({ sessionUuid, directory, publisher, now }),
      busy: false,
      /** @type {Array<{ id: string, type: string, description: string }>} this process's, non-ambient */
      backgroundTasks: [],
      closing: false,
      idleTimer: null,
      idleWaiters: [],
      compactSummaryNext: false,
      taskToolUses: new Map(),
      childChecklists: new Set(),
      tasks: null,
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
      // The CLI offers the task-tracking tools only to the models it knows, and
      // a connected third-party model is one it does not. Without this opt-in
      // the model gets no checklist tool at all and records no checklist.
      env: { ...connection.env, CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' },
      systemPrompt: instructions === null
        ? { type: 'preset', preset: 'claude_code' }
        : { type: 'preset', preset: 'claude_code', append: instructions },
      permissionMode: config.permissionMode,
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      forwardSubagentText: true,
      abortController: live.abortController,
      canUseTool: (toolName, input, context) => canUseTool(live, toolName, input, context),
      stderr: (data) => {
        live.stderrTail = (live.stderrTail + data).slice(-STDERR_TAIL_CHARS);
      },
    };
    if (connection.settings) options.settings = connection.settings;
    if (config.model !== null) options.model = config.model;
    if (config.effort !== null) options.effort = config.effort;
    if (resume) options.resume = sessionUuid;
    else options.sessionId = sessionUuid;
    if (rewind !== null) options.resumeSessionAt = rewind.resumeAt;
    try {
      live.query = sdk.query({ prompt: live.input, options });
    } catch (error) {
      await connection.dispose();
      throw new Error(redactClaudeConnectionError(error instanceof Error ? error.message : String(error), config.launch));
    }
    live.tasks = createClaudeBackgroundTasks({
      sessionUuid, query: live.query, outputRoot: claudeTaskOutputRoot(connection.env, platform),
      nextRevision: nextTaskRevision,
      publish: (snapshot) => publisher.tasks(directory, sessionId, snapshot),
      childSessionForTool: (toolUseId) => live.subagents.session(encodeClaudeChildSessionId(sessionUuid, toolUseId))?.id ?? null,
    });
    const source = claudeChecklistSource({ env: connection.env, sessionUuid, directory });
    checklists.bind(sessionId, directory, source);
    publisher.tasks(directory, sessionId, live.tasks.snapshot());
    sessions.set(sessionId, live);
    void consume(live);
    try {
      await onChecklistSource(sessionId, directory, source ? { configDir: source.configDir, listId: source.listId } : null);
    } catch {
      // Live reads remain valid. Do not fail an accepted prompt or imply that
      // the captured source will survive a server restart after a failed write.
      console.warn('[native-agents] Claude checklist source could not be saved; restart recovery is unavailable');
    }
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
      return serializePrompt(sessionId, async () => {
        const decoded = decodeNativeSessionId(sessionId);
        if (!decoded || decoded.backend !== 'claude' || decoded.toolUseId !== null) {
          throw invalidRequestError('Prompts go to a Claude Code session, not a subagent');
        }
        const uuid = USER_MESSAGE_ID.exec(messageId)?.[1];
        if (!uuid) throw invalidRequestError(`Not a Claude user message id: ${messageId}`);
        let live = sessions.get(sessionId);
        if (live && (live.config.launch?.key ?? 'default') !== (config.launch?.key ?? 'default')) {
          if (live.busy || live.backgroundTasks.length > 0) {
            throw new NativeAgentError('Wait for the current turn and background tasks before switching connections', { status: 409, code: 'NATIVE_CONNECTION_BUSY' });
          }
          close(live);
          live = undefined;
        }
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
        markBusy(live);
      });
    },

    /**
     * Stops the background tasks the session's CLI still runs after its turn.
     * The CLI marks a task stopped by the user as notified, so the model is
     * not woken to report it. False when none ran.
     */
    async stopBackgroundTasks(sessionId) {
      const live = sessions.get(sessionId);
      if (!live || live.closing || live.backgroundTasks.length === 0) return false;
      const results = await Promise.allSettled(live.backgroundTasks.map((task) => live.query.stopTask(task.id)));
      const failures = results.filter((result) => result.status === 'rejected');
      if (failures.length === results.length) throw failures[0].reason;
      for (const failure of failures) {
        console.warn('[native-agents] could not stop a Claude Code background task:', sessionId, failure.reason instanceof Error ? failure.reason.message : failure.reason);
      }
      return true;
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
    async closeConnection(prefix) {
      const owned = Array.from(sessions.values()).filter((live) => live.config.launch?.key.startsWith(prefix));
      for (const live of owned) { close(live); live.abortController.abort(); }
      await Promise.all(owned.map((live) => live.exited));
    },

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

    sessionTasks(sessionId, directory) {
      const live = sessions.get(sessionId);
      if (live && live.directory !== directory) throw invalidRequestError('Task directory does not match its session');
      return live && !live.closing ? live.tasks.snapshot()
        : { state: 'inactive', generation: null, revision: taskRevision, tasks: [], omitted: 0 };
    },

    taskOutput(sessionId, directory, taskId, generation) {
      const live = sessions.get(sessionId);
      if (live && live.directory !== directory) throw invalidRequestError('Task directory does not match its session');
      if (!live || live.closing) return { state: 'unavailable', reason: 'query_closed' };
      return live.tasks.output(taskId, generation);
    },

    stopTask(sessionId, directory, taskId, generation) {
      const live = sessions.get(sessionId);
      if (live && live.directory !== directory) throw invalidRequestError('Task directory does not match its session');
      if (!live || live.closing) throw new NativeAgentError('The task query is closed', { status: 409, code: 'NATIVE_TASK_QUERY_CLOSED' });
      return live.tasks.stop(taskId, generation);
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
      const decoded = decodeNativeSessionId(sessionId);
      if (decoded?.backend !== 'claude') return null;
      const live = sessions.get(encodeClaudeSessionId(decoded.sessionUuid));
      if (!live || live.closing) return null;
      return decoded.toolUseId ? live.subagents.records(sessionId) : live.projection.records();
    },

    childSession(sessionId) {
      const decoded = decodeNativeSessionId(sessionId);
      if (decoded?.backend !== 'claude' || !decoded.toolUseId) return null;
      const live = sessions.get(encodeClaudeSessionId(decoded.sessionUuid));
      return live && !live.closing ? live.subagents.session(sessionId) : null;
    },

    isSessionRunning(sessionId) {
      const decoded = decodeNativeSessionId(sessionId);
      if (decoded?.backend !== 'claude') return false;
      const live = sessions.get(encodeClaudeSessionId(decoded.sessionUuid));
      return decoded.toolUseId ? live?.subagents.isRunning(sessionId) === true : live?.busy === true;
    },

    /** @param {string} directory */
    busySessionIds(directory) {
      return Array.from(sessions.values())
        .filter((live) => live.directory === directory)
        .flatMap((live) => [...(live.busy ? [live.sessionId] : []), ...live.subagents.busySessionIds()]);
    },

    /**
     * Background tasks of every open query, for clients that missed the
     * events announcing them. Every task is in this map: none outlives its query.
     * @returns {Record<string, { directory: string, tasks: Array<{ id: string, type: string, description: string }> }>}
     */
    backgroundTaskSnapshot() {
      return Object.fromEntries(Array.from(sessions.values())
        .filter((live) => !live.closing && live.backgroundTasks.length > 0)
        .map((live) => [live.sessionId, { directory: live.directory, tasks: structuredClone(live.backgroundTasks) }]));
    },

    async shutdown() {
      const running = Array.from(sessions.values());
      for (const live of running) close(live);
      for (const live of running) live.abortController.abort();
    },
  };
};
