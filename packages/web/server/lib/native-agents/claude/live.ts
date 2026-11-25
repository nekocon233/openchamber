import type { UUID } from 'node:crypto';
import type { CanUseTool, Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import type { JsonValue } from '../../shared/json-values.js';
import { invalidRequestError, NativeAgentError } from '../errors.js';
import { launchableClaudeExecutable } from '../executables.js';
import { decodeNativeSessionId, encodeClaudeChildSessionId, encodeClaudeSessionId } from '../ids.js';
import { claudeModelContextWindow } from '../catalog.js';
import type { ClaudePromptBlock } from '../prompt-parts.js';
import type { NativeEventPublisher } from '../publisher.js';
import type { QuestionRegistry } from '../questions.js';
import type { NativeErrorInfo, NativeMessageRecord, NativeSessionRecord, NativeTextPart } from '../records.js';
import { claudeAbortedError, claudeTurnError, createClaudeProjection } from './projector.js';
import type { ClaudeProjection, ClaudePromptContent, ClaudeSendRecord } from './projector.js';
import { applyClaudeLiveConfig, claudeEffortSchema, prepareClaudeConnection, redactClaudeConnectionError } from './connections.js';
import type { ClaudeConnectionLaunch, ClaudeLiveConfig, PreparedClaudeConnection } from './connections.js';
import { claudeChecklistSource, createClaudeChecklists, todosFromTodoWrite } from './tasks.js';
import type { ClaudeChecklists, ClaudeTaskItem } from './tasks.js';
import { claudeTaskOutputRoot, createClaudeBackgroundTasks } from './background-tasks.js';
import type { ClaudeBackgroundTaskActivity, ClaudeBackgroundTaskOutput, ClaudeBackgroundTasks, ClaudeBackgroundTaskSnapshot } from './background-tasks.js';
import { createClaudeSubagents } from './subagents.js';
import type { ClaudeSubagents } from './subagents.js';
import type { ClaudeSdkModule } from './sdk.js';
import type { ClaudeReplayHistoryInspection } from './store.js';

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
const COMMANDS_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_LIVE_SESSIONS = 6;
const STDERR_TAIL_CHARS = 4000;
const USER_MESSAGE_ID = /^ncl_u_([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i;

const PLAN_DECLINED = 'The user did not approve implementation. Keep the session in plan mode.';
const QUESTION_DISMISSED = 'The user dismissed the question without answering.';

const opaqueJson = z.custom<JsonValue>(() => true);

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
  local_command: z.string().optional(),
  queued_turn_count: z.number().optional(),
  usage: opaqueJson.nullish(),
  modelUsage: opaqueJson.nullish(),
}).passthrough();

const messageStartSchema = z.object({ event: z.object({ type: z.literal('message_start') }) });

const TASK_LIST_TOOLS = new Set(['TaskCreate', 'TaskUpdate']);
const frameBlocksSchema = z.object({
  message: z.object({
    content: z.array(z.object({
      type: z.string(),
      id: z.string().optional(),
      name: z.string().optional(),
      input: opaqueJson.optional(),
      tool_use_id: z.string().optional(),
      is_error: z.boolean().optional(),
    }).passthrough()).catch([]),
  }).passthrough(),
}).passthrough();

const structuredTaskOutput = z.object({
  agentId: z.string().optional(),
  taskId: z.string().optional(),
  backgroundTaskId: z.string().optional(),
  output_file: z.string().optional(),
  outputFile: z.string().optional(),
});

const createdTaskOutput = z.object({
  task: z.object({ id: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/) }).passthrough(),
}).passthrough();

type InputQueue = AsyncIterable<SDKUserMessage> & {
  push: (message: SDKUserMessage) => void;
  close: () => void;
};

type ParsedResultFrame = z.infer<typeof resultFrameSchema>;
type TurnStopReason = 'keep-planning' | 'user-stop' | 'plan-execution' | null;

type TrackedTaskToolUse = {
  name: string;
  owner: string;
  todos: ClaudeTaskItem[] | null;
};

export type ClaudeLiveRewind = {
  messageId: string;
  resumeAt: string;
};

export type ClaudeToolConfiguration = {
  key: string;
  child: boolean;
  command: string;
  args: string[];
  env: Record<string, string>;
};

export type ClaudeSlashCommand = {
  name: string;
  description: string;
  argumentHint: string;
};

export type ClaudeTurnFinishedSummary = {
  id?: string;
  summary: string;
  status: 'completed' | 'interrupted';
};

export type ClaudeBackgroundTaskDirectorySnapshot = Record<string, {
  directory: string;
  tasks: ClaudeBackgroundTaskActivity[];
}>;

export interface ClaudeLivePublisher extends Pick<
  NativeEventPublisher,
  'records' | 'delta' | 'status' | 'session' | 'error' | 'backgroundTasks' | 'checklist' | 'forget' | 'emit'
> {
  tasks: (directory: string, sessionID: string, snapshot: ClaudeBackgroundTaskSnapshot) => void;
}

export interface ClaudeLivePromptInput {
  sessionId: string;
  directory: string;
  messageId: string;
  content: ClaudePromptContent | null;
  sdkContent: ReadonlyArray<ClaudePromptBlock>;
  config: ClaudeLiveConfig;
  send: ClaudeSendRecord;
  rewind?: ClaudeLiveRewind | null | undefined;
  signal?: AbortSignal | null | undefined;
}

export interface ClaudeLiveSessionsOptions {
  toolConfiguration?: ((sessionId: string) => ClaudeToolConfiguration | null | undefined) | undefined;
  loadSdk: () => Promise<ClaudeSdkModule>;
  resolveExecutable: () => Promise<string | null>;
  buildEnv: () => Record<string, string>;
  hasTranscript: (sessionUuid: string, directory: string) => Promise<boolean>;
  inspectReplayHistory?: ((sessionUuid: string, directory: string) => Promise<ClaudeReplayHistoryInspection>) | undefined;
  publisher: ClaudeLivePublisher;
  questions: Pick<QuestionRegistry, 'ask' | 'rejectSession'>;
  readGlobalInstructions?: (() => Promise<string | null>) | undefined;
  onTurnFinished?: ((sessionId: string, directory: string, turn: ClaudeTurnFinishedSummary) => void) | undefined;
  onIdle?: ((sessionId: string, directory: string) => void) | undefined;
  onChecklistSource?: ((sessionId: string, directory: string, source: { configDir: string; listId: string } | null) => Promise<void> | void) | undefined;
  now?: (() => number) | undefined;
  checklists?: ClaudeChecklists | undefined;
  idleTimeoutMs?: number | undefined;
  maxLiveSessions?: number | undefined;
  platform?: NodeJS.Platform | undefined;
}

export interface ClaudeLiveSessions {
  prompt: (input: ClaudeLivePromptInput) => Promise<void>;
  canReuseConnection: (sessionId: string, launch: ClaudeConnectionLaunch, toolKey: string) => boolean;
  stopBackgroundTasks: (sessionId: string) => Promise<boolean>;
  abort: (sessionId: string) => Promise<boolean>;
  closeConnection: (prefix: string) => Promise<void>;
  closeSession: (sessionId: string) => Promise<void>;
  commands: (directory: string) => Promise<ClaudeSlashCommand[]>;
  sessionTasks: (sessionId: string, directory: string) => ClaudeBackgroundTaskSnapshot;
  taskOutput: (sessionId: string, directory: string, taskId: string, generation: string) => Promise<ClaudeBackgroundTaskOutput> | ClaudeBackgroundTaskOutput;
  stopTask: (sessionId: string, directory: string, taskId: string, generation: string) => Promise<{ accepted: true }>;
  whenIdle: (sessionId: string) => Promise<void>;
  liveRecords: (sessionId: string) => NativeMessageRecord[] | null;
  childSession: (sessionId: string) => NativeSessionRecord | null;
  isSessionRunning: (sessionId: string) => boolean;
  busySessionIds: (directory: string) => string[];
  backgroundTaskSnapshot: () => ClaudeBackgroundTaskDirectorySnapshot;
  shutdown: () => Promise<void>;
}

type LiveSessionCore = {
  sessionId: string;
  sessionUuid: string;
  directory: string;
  connection: PreparedClaudeConnection;
  config: ClaudeLiveConfig;
  rewind: ClaudeLiveRewind | null;
  input: InputQueue;
  abortController: AbortController;
  sends: Map<string, ClaudeSendRecord>;
  subagents: ClaudeSubagents;
  busy: boolean;
  turnStopReason: TurnStopReason;
  backgroundTasks: ClaudeBackgroundTaskActivity[];
  closing: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  idleWaiters: Array<() => void>;
  taskToolUses: Map<string, TrackedTaskToolUse>;
  childChecklists: Set<string>;
  exited: Promise<void>;
  markExited: () => void;
  lastActive: number;
  stderrTail: string;
  toolKey: string;
  projection: ClaudeProjection;
};

type LiveSession = LiveSessionCore & {
  query: Query;
  tasks: ClaudeBackgroundTasks;
};

const sameBackgroundTasks = (
  left: ReadonlyArray<ClaudeBackgroundTaskActivity>,
  right: ReadonlyArray<ClaudeBackgroundTaskActivity>,
): boolean => left.length === right.length
  && left.every((task, index) => {
    const other = right[index];
    return other !== undefined
      && task.id === other.id
      && task.type === other.type
      && task.description === other.description;
  });

const createInputQueue = (): InputQueue => {
  const items: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
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
        const next = items.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
};

const turnErrorOf = (frame: ParsedResultFrame, launch?: ClaudeConnectionLaunch): NativeErrorInfo | null => {
  if (frame.terminal_reason === 'aborted_streaming' || frame.terminal_reason === 'aborted_tools') return claudeAbortedError();
  if (frame.subtype === 'success' && !frame.is_error) return null;
  const message = [frame.result, ...(frame.errors ?? [])].filter((text): text is string => Boolean(text)).join('\n') || frame.subtype;
  return claudeTurnError(redactClaudeConnectionError(message, launch));
};

const toSdkContent = (blocks: ReadonlyArray<ClaudePromptBlock>): SDKUserMessage['message']['content'] => blocks.map((block) => {
  if (block.type !== 'image') return block;
  // SAFETY: claudePromptBlocks validates every image block's media_type starts with "image/"; the CLI passes image blocks verbatim to the provider.
  const mediaType = block.source.media_type as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  return { type: 'image' as const, source: { type: 'base64' as const, media_type: mediaType, data: block.source.data } };
});

export const createClaudeLiveSessions = ({
  toolConfiguration = () => null,
  loadSdk,
  resolveExecutable,
  buildEnv,
  hasTranscript,
  inspectReplayHistory = async () => ({ toolReferences: [], hasRemovedPlanReplayState: false }),
  publisher,
  questions,
  readGlobalInstructions = async () => null,
  onTurnFinished = () => {},
  onIdle = () => {},
  onChecklistSource = async () => {},
  now = Date.now,
  checklists = createClaudeChecklists({ publisher, now }),
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  maxLiveSessions = DEFAULT_MAX_LIVE_SESSIONS,
  platform = process.platform,
}: ClaudeLiveSessionsOptions): ClaudeLiveSessions => {
  const sessions = new Map<string, LiveSession>();
  let taskRevision = 0;
  const nextTaskRevision = (): number => ++taskRevision;

  const launchableExecutable = (): Promise<string> => launchableClaudeExecutable(resolveExecutable, platform);
  const exits = new Map<string, Promise<void>>();
  const pendingPrompts = new Map<string, Promise<void>>();

  const serializePrompt = (sessionId: string, work: () => Promise<void>): Promise<void> => {
    const previous = pendingPrompts.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    pendingPrompts.set(sessionId, next);
    return next.finally(() => {
      if (pendingPrompts.get(sessionId) === next) pendingPrompts.delete(sessionId);
    });
  };

  const publishRecords = (live: LiveSession, messageIds: ReadonlyArray<string>): void => {
    const records: NativeMessageRecord[] = [];
    for (const id of new Set(messageIds)) {
      const record = live.projection.record(id);
      if (record) records.push(record);
      else publisher.emit(live.directory, 'message.removed', { sessionID: live.sessionId, messageID: id });
    }
    publisher.records(live.directory, live.sessionId, records);
  };

  const observeTools = (live: LiveSession, frame: SDKMessage): void => {
    if ('isReplay' in frame && frame.isReplay === true) return;
    const blocks = frameBlocksSchema.safeParse(frame).data?.message.content ?? [];
    const parentToolUseId = 'parent_tool_use_id' in frame ? frame.parent_tool_use_id : null;
    const owner = parentToolUseId
      ? encodeClaudeChildSessionId(live.sessionUuid, parentToolUseId)
      : live.sessionId;
    const toolUseResult = 'tool_use_result' in frame ? frame.tool_use_result : undefined;
    for (const block of blocks) {
      if (block.type === 'tool_use' && block.id && block.name) {
        if (TASK_LIST_TOOLS.has(block.name) || block.name === 'TodoWrite' || ['Agent', 'Task', 'Bash'].includes(block.name)) {
          live.taskToolUses.set(block.id, {
            name: block.name,
            owner,
            todos: block.name === 'TodoWrite' ? todosFromTodoWrite(block.input) : null,
          });
        }
      } else if (block.type === 'tool_result' && block.tool_use_id) {
        const call = live.taskToolUses.get(block.tool_use_id);
        if (!call) continue;
        live.taskToolUses.delete(block.tool_use_id);
        if (block.is_error === true) continue;
        if (TASK_LIST_TOOLS.has(call.name)) {
          const created = call.name === 'TaskCreate' ? createdTaskOutput.safeParse(toolUseResult) : null;
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
        const result = structuredTaskOutput.safeParse(toolUseResult);
        if (result.success && ['Agent', 'Task', 'Bash'].includes(call.name)) {
          const data = result.data;
          const taskId = data.agentId ?? data.taskId ?? data.backgroundTaskId;
          if (taskId) live.tasks.outputFromTool({ taskId, toolUseId: block.tool_use_id, file: data.output_file ?? data.outputFile });
        }
      }
    }
  };

  const clearIdleTimer = (live: LiveSession): void => {
    if (live.idleTimer) clearTimeout(live.idleTimer);
    live.idleTimer = null;
  };

  const close = (live: LiveSession): void => {
    clearIdleTimer(live);
    if (live.closing) return;
    live.closing = true;
    live.turnStopReason = null;
    live.tasks.close();
    questions.rejectSession(live.sessionId);
    exits.set(live.sessionId, live.exited);
    live.input.close();
    setTimeout(() => live.abortController.abort(), 5_000).unref?.();
  };

  const scheduleIdleClose = (live: LiveSession): void => {
    clearIdleTimer(live);
    if (live.busy || live.backgroundTasks.length > 0 || live.closing) return;
    live.idleTimer = setTimeout(() => close(live), idleTimeoutMs);
    live.idleTimer.unref?.();
  };

  const markBusy = (live: LiveSession): void => {
    clearIdleTimer(live);
    if (live.busy) return;
    live.turnStopReason = null;
    live.busy = true;
    publisher.status(live.directory, live.sessionId, 'busy');
  };

  const applyBackgroundTasks = (live: LiveSession, tasks: ClaudeBackgroundTaskActivity[]): void => {
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

  const settleIdle = (live: LiveSession, error: NativeErrorInfo | null): void => {
    live.busy = false;
    live.lastActive = now();
    questions.rejectSession(live.sessionId);
    publisher.status(live.directory, live.sessionId, 'idle');
    if (error !== null && error.name !== 'MessageAbortedError') publisher.error(live.directory, live.sessionId, error);
    onIdle(live.sessionId, live.directory);
    for (const resolve of live.idleWaiters.splice(0)) resolve();
  };

  const finishTurn = (live: LiveSession, frame: ParsedResultFrame): void => {
    const error = turnErrorOf(frame, live.config.launch);
    const planKept = live.turnStopReason === 'keep-planning' || live.turnStopReason === 'plan-execution';
    live.turnStopReason = null;
    publishRecords(live, live.projection.finishTurn({ error, planKept, queuedTurns: frame.queued_turn_count ?? 0, localCommand: frame.local_command }));
    if (error?.name === 'MessageAbortedError') live.subagents.stop(error);
    const reply = live.projection.records().findLast((record) => record.info.role === 'assistant');
    const lastText = reply?.parts.findLast((part): part is NativeTextPart => part.type === 'text');
    const turnSummary: ClaudeTurnFinishedSummary = {
      summary: lastText?.text ?? '',
      status: error ? 'interrupted' : 'completed',
    };
    if (reply?.info.id !== undefined) turnSummary.id = reply.info.id;
    onTurnFinished(live.sessionId, live.directory, turnSummary);
    if ((frame.queued_turn_count ?? 0) > 0) return;
    settleIdle(live, error);
    scheduleIdleClose(live);
  };

  const handleFrame = (live: LiveSession, frame: SDKMessage): void => {
    if (live.tasks.observe(frame)) applyBackgroundTasks(live, live.tasks.activity());
    if (frame.type === 'assistant' || frame.type === 'user') observeTools(live, frame);
    if (live.subagents.handleFrame(frame)) return;
    if (frame.type === 'stream_event') {
      if (!live.busy && messageStartSchema.safeParse(frame).success) markBusy(live);
      const { changed, delta } = live.projection.applyStreamEvent(frame);
      if (changed.length > 0) publishRecords(live, changed);
      if (delta) publisher.delta(live.directory, delta);
      return;
    }
    if (frame.type === 'system') {
      if (frame.subtype !== 'compact_boundary' && frame.subtype !== 'status') return;
      publishRecords(live, live.projection.applyEntry(frame));
      return;
    }
    if (frame.type === 'assistant' || frame.type === 'user') {
      if (frame.type === 'user' && 'isReplay' in frame && frame.isReplay === true) return;
      const changed = live.projection.applyEntry(frame);
      publishRecords(live, changed);
      live.subagents.announce(live.sessionId, live.projection, changed);
      return;
    }
    if (frame.type === 'result') {
      const parsed = resultFrameSchema.safeParse(frame);
      if (parsed.success) {
        if (parsed.data.subtype === 'success' && !parsed.data.is_error) {
          publishRecords(live, live.projection.applyResult(frame));
        }
        finishTurn(live, parsed.data);
      }
    }
  };

  const ended = (live: LiveSession, rawFailure: string | null): void => {
    const failure = rawFailure ? redactClaudeConnectionError(rawFailure, live.config.launch) : null;
    live.stderrTail = redactClaudeConnectionError(live.stderrTail, live.config.launch);
    clearIdleTimer(live);
    live.turnStopReason = null;
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

  const consume = async (live: LiveSession): Promise<void> => {
    try {
      for await (const frame of live.query) handleFrame(live, frame);
      ended(live, null);
    } catch (error) {
      ended(live, error instanceof Error ? error.message : String(error));
    } finally {
      await live.connection.dispose();
    }
  };

  const buildCanUseTool = (live: LiveSessionCore): CanUseTool => async (toolName, input, context) => {
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
      if (outcome.status === 'transferred') {
        live.turnStopReason = 'plan-execution';
        return { behavior: 'deny', message: 'The approved plan will continue with the selected execution model.', interrupt: true };
      }
      if (outcome.status === 'rejected' || context.signal.aborted || live.closing || live.turnStopReason === 'user-stop') {
        return { behavior: 'deny', message: PLAN_DECLINED, interrupt: true };
      }
      const firstAnswer = outcome.answers[0];
      const answer = outcome.answers.length === 1 && firstAnswer?.length === 1 ? (firstAnswer[0] ?? '') : '';
      if (answer !== 'build') {
        if (answer === 'plan') live.turnStopReason = 'keep-planning';
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

  const makeRoom = (): void => {
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
    if (!oldest) return;
    sessions.delete(oldest.sessionId);
    close(oldest);
  };

  const start = async ({
    sessionId,
    sessionUuid,
    directory,
    config,
    rewind,
  }: {
    sessionId: string;
    sessionUuid: string;
    directory: string;
    config: ClaudeLiveConfig;
    rewind: ClaudeLiveRewind | null;
  }): Promise<LiveSession> => {
    makeRoom();
    const [sdk, executable, resume, instructions] = await Promise.all([
      loadSdk(),
      launchableExecutable(),
      rewind === null ? hasTranscript(sessionUuid, directory) : true,
      readGlobalInstructions(),
    ]);
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
    let markExited: () => void = () => {};
    const exited = new Promise<void>((resolve) => {
      markExited = resolve;
    });
    const sends = new Map<string, ClaudeSendRecord>();
    const tools = toolConfiguration(sessionId);
    const state: LiveSessionCore = {
      sessionId,
      sessionUuid,
      directory,
      connection,
      config,
      rewind,
      input: createInputQueue(),
      abortController: new AbortController(),
      sends,
      subagents: createClaudeSubagents({ sessionUuid, directory, publisher, now }),
      busy: false,
      turnStopReason: null,
      backgroundTasks: [],
      closing: false,
      idleTimer: null,
      idleWaiters: [],
      taskToolUses: new Map(),
      childChecklists: new Set(),
      exited,
      markExited,
      lastActive: now(),
      stderrTail: '',
      toolKey: tools?.key ?? '',
      projection: createClaudeProjection({
        sessionId,
        cwd: directory,
        live: true,
        now,
        sendRecordFor: (messageId) => sends.get(messageId) ?? null,
        childSessionIdForToolUse: (toolUseId) => encodeClaudeChildSessionId(sessionUuid, toolUseId),
        contextWindowFor: (modelID) => state.config.launch?.descriptor?.contextWindow ?? claudeModelContextWindow(modelID),
      }),
    };
    const env = tools && !tools.child
      ? { ...connection.env, CLAUDE_CODE_ENABLE_TODO_TOOLS: '1', MCP_TOOL_TIMEOUT: '3600000' }
      : { ...connection.env, CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' };
    const options: Options = {
      cwd: directory,
      pathToClaudeCodeExecutable: executable,
      env,
      systemPrompt: instructions === null
        ? { type: 'preset', preset: 'claude_code' }
        : { type: 'preset', preset: 'claude_code', append: instructions },
      permissionMode: config.permissionMode,
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      forwardSubagentText: true,
      abortController: state.abortController,
      canUseTool: buildCanUseTool(state),
      stderr: (data) => {
        state.stderrTail = (state.stderrTail + data).slice(-STDERR_TAIL_CHARS);
      },
      settings: connection.settings ?? { env: { ENABLE_TOOL_SEARCH: 'false' } },
    };
    if (tools) {
      options.disallowedTools = ['Agent', 'Task'];
      if (tools.child) options.disallowedTools.push('ExitPlanMode');
      else {
        options.mcpServers = { openchamber_subagents: { command: tools.command, args: tools.args, env: tools.env } };
      }
    }
    if (config.model !== null) options.model = config.model;
    const parsedEffort = config.effort !== null ? claudeEffortSchema.safeParse(config.effort) : null;
    if (parsedEffort?.success) options.effort = parsedEffort.data;
    if (resume) options.resume = sessionUuid;
    else options.sessionId = sessionUuid;
    if (rewind !== null) options.resumeSessionAt = rewind.resumeAt;
    let query: Query;
    try {
      query = sdk.query({ prompt: state.input, options });
    } catch (error) {
      await connection.dispose();
      throw new Error(redactClaudeConnectionError(error instanceof Error ? error.message : String(error), config.launch));
    }
    const tasks = createClaudeBackgroundTasks({
      sessionUuid,
      query,
      outputRoot: claudeTaskOutputRoot(connection.env, platform),
      nextRevision: nextTaskRevision,
      publish: (snapshot) => publisher.tasks(directory, sessionId, snapshot),
      childSessionForTool: (toolUseId) => state.subagents.session(encodeClaudeChildSessionId(sessionUuid, toolUseId))?.id ?? null,
    });
    const live: LiveSession = Object.assign(state, { query, tasks });
    const source = claudeChecklistSource({ env: connection.env, sessionUuid, directory });
    checklists.bind(sessionId, directory, source);
    publisher.tasks(directory, sessionId, live.tasks.snapshot());
    sessions.set(sessionId, live);
    void consume(live);
    try {
      await onChecklistSource(sessionId, directory, source ? { configDir: source.configDir, listId: source.listId } : null);
    } catch {
      console.warn('[native-agents] Claude checklist source could not be saved; restart recovery is unavailable');
    }
    return live;
  };

  return {
    canReuseConnection(sessionId, launch, toolKey) {
      const live = sessions.get(sessionId);
      return Boolean(live && !live.closing && live.toolKey === toolKey && (live.config.launch?.key ?? 'default') === launch.key);
    },

    async prompt({ sessionId, directory, messageId, content, sdkContent, config, send, rewind = null, signal = null }) {
      return serializePrompt(sessionId, async () => {
        signal?.throwIfAborted();
        const decoded = decodeNativeSessionId(sessionId);
        if (!decoded || decoded.backend !== 'claude' || decoded.toolUseId !== null) {
          throw invalidRequestError('Prompts go to a Claude Code session, not a subagent');
        }
        const match = USER_MESSAGE_ID.exec(messageId);
        if (!match?.[1] || !match[2] || !match[3] || !match[4] || !match[5]) {
          throw invalidRequestError(`Not a Claude user message id: ${messageId}`);
        }
        const uuid: UUID = `${match[1]}-${match[2]}-${match[3]}-${match[4]}-${match[5]}`;
        let live = sessions.get(sessionId);
        const toolKey = toolConfiguration(sessionId)?.key ?? '';
        if (live && live.toolKey !== toolKey) {
          if (live.busy || live.backgroundTasks.length) throw new NativeAgentError('Wait for the current turn before applying subagent settings', { status: 409, code: 'NATIVE_SESSION_BUSY' });
          close(live);
          live = undefined;
        }
        if (live && (live.config.launch?.key ?? 'default') !== (config.launch?.key ?? 'default')) {
          if (live.busy || live.backgroundTasks.length > 0) {
            throw new NativeAgentError('Wait for the current turn and background tasks before switching connections', { status: 409, code: 'NATIVE_CONNECTION_BUSY' });
          }
          close(live);
          live = undefined;
        }
        if (live && (live.closing || (rewind !== null && live.rewind?.messageId !== rewind.messageId))) {
          close(live);
          live = undefined;
        }
        let created = false;
        if (live) {
          await applyClaudeLiveConfig(live, config);
        } else {
          await exits.get(sessionId);
          live = await start({ sessionId, sessionUuid: decoded.sessionUuid, directory, config, rewind });
          created = true;
        }
        if (signal?.aborted) {
          if (created) close(live);
          signal.throwIfAborted();
        }
        live.lastActive = now();
        live.sends.set(messageId, send);
        live.projection.queueTurn(sdkContent);
        if (content !== null) publishRecords(live, live.projection.startUserPrompt(messageId, content));
        live.input.push({
          type: 'user',
          message: { role: 'user', content: toSdkContent(sdkContent) },
          parent_tool_use_id: null,
          uuid,
          origin: { kind: 'human' },
          priority: 'next',
        });
        markBusy(live);
      });
    },

    async stopBackgroundTasks(sessionId) {
      const live = sessions.get(sessionId);
      if (!live || live.closing || live.backgroundTasks.length === 0) return false;
      const results = await Promise.allSettled(live.backgroundTasks.map((task) => live.query.stopTask(task.id)));
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length === results.length && failures[0]) throw failures[0].reason;
      for (const failure of failures) {
        console.warn('[native-agents] could not stop a Claude Code background task:', sessionId, failure.reason instanceof Error ? failure.reason.message : failure.reason);
      }
      return true;
    },

    async abort(sessionId) {
      const live = sessions.get(sessionId);
      if (!live?.busy) return false;
      live.turnStopReason = 'user-stop';
      questions.rejectSession(sessionId);
      await live.query.interrupt();
      return true;
    },

    async closeConnection(prefix) {
      const owned = Array.from(sessions.values()).filter((live) => live.config.launch?.key.startsWith(prefix));
      for (const live of owned) {
        close(live);
        live.abortController.abort();
      }
      await Promise.all(owned.map((live) => live.exited));
    },

    async closeSession(sessionId) {
      const live = sessions.get(sessionId);
      if (live) close(live);
      await exits.get(sessionId);
    },

    async commands(directory) {
      const parse = (commands: ReadonlyArray<object>): ClaudeSlashCommand[] => commands
        .map((command) => slashCommandSchema.safeParse(command))
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
      void (async () => {
        try {
          for await (const frame of query) void frame;
        } catch {
          return;
        }
      })();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timedOut = new Promise<never>((_, reject) => {
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
      return live && !live.closing
        ? live.tasks.snapshot()
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

    whenIdle(sessionId) {
      const live = sessions.get(sessionId);
      if (!live?.busy) return Promise.resolve();
      return new Promise((resolve) => {
        live.idleWaiters.push(resolve);
      });
    },

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

    busySessionIds(directory) {
      return Array.from(sessions.values())
        .filter((live) => live.directory === directory)
        .flatMap((live) => [...(live.busy ? [live.sessionId] : []), ...live.subagents.busySessionIds()]);
    },

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
