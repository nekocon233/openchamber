import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { codexVariantSettings, nativeModelSupportsVariant } from './catalog.js';
import type { VariantCapableModel } from './catalog.js';
import { createAntigravityBackend } from './antigravity/backend.js';
import { createAntigravityDecisions } from './antigravity/decisions.js';
import { resolveAgyCommand } from './antigravity/command.js';
import { withAgyFileDetails } from './antigravity/tools.js';
import { compactLaunchOverride, createClaudeConnections } from './claude/connections.js';
import type { ClaudeConnectionLaunch, ClaudeConnectionWriteInput } from './claude/connections.js';
import { createClaudeLiveSessions } from './claude/live.js';
import { loadClaudeSdk } from './claude/sdk.js';
import { createClaudeSessionStore } from './claude/store.js';
import { claudeChecklistSource, createClaudeChecklists } from './claude/tasks.js';
import { createClaudeUtility } from './claude/utility.js';
import { createCodexAppServer } from './codex/app-server.js';
import { createCodexAutoTitles } from './codex/auto-title.js';
import { createCodexCatalog } from './codex/catalog.js';
import { createCodexCommands } from './codex/commands.js';
import { createCodexConnections } from './codex/connections.js';
import type { CodexConnectionWrite } from './codex/connections.js';
import { createCodexLiveThreads, codexThreadToolConfig } from './codex/live.js';
import { createCodexPlanDecisions } from './codex/plan-decisions.js';
import { createCodexSessionStore } from './codex/store.js';
import { createCodexUtility } from './codex/utility.js';
import { createDeepseekBackend } from './deepseek/backend.js';
import { createDeepseekInstallation } from './deepseek/installation.js';
import { createDeepseekSetup } from './deepseek/setup.js';
import { createDeepseekMaintenance, deepseekPackage } from './deepseek/maintenance.js';
import { isEnterpriseMode } from '../enterprise-mode.js';
import { isRecord } from '../shared/guards.js';
import type { JsonObject } from '../shared/json-values.js';
import {
  invalidRequestError,
  NativeAgentError,
  revertFirstMessageError,
  sessionBusyError,
  sessionNotFoundError,
} from './errors.js';
import { launchableClaudeExecutable } from './executables.js';
import type { CliResolver } from './executables.js';
import {
  claudeUserMessageId,
  decodeNativeSessionId,
  encodeClaudeSessionId,
  encodeCodexSessionId,
  NATIVE_BACKEND_CLAUDE,
  NATIVE_BACKEND_CODEX,
  NATIVE_BACKEND_DEEPSEEK,
  NATIVE_BACKEND_ANTIGRAVITY,
  NATIVE_PROVIDER_CLAUDE,
  NATIVE_PROVIDER_CODEX,
  nativeBackendOfProviderId,
} from './ids.js';
import type { NativeBackend, NativeSessionRef } from './ids.js';
import { claudePromptBlocks, withInstructions } from './prompt-parts.js';
import type { PromptPart } from './prompt-parts.js';
import { createNativeEventPublisher } from './publisher.js';
import type { NativeChecklistSnapshot, NativePublishedEvent } from './publisher.js';
import { createQuestionRegistry } from './questions.js';
import { createNativeInteractions } from './interactions.js';
import { createNativePlanExecution, planExecutionChoiceSchema } from './plan-execution.js';
import type { NativePlanExecution, PlanExecutionChoice, PlanReferenceRequest } from './plan-execution.js';
import { unconfirmedSessionRecord, unknownError } from './records.js';
import type { NativeMessageRecord, NativeSessionRecord } from './records.js';
import { createNativeRegistry } from './registry.js';
import type { RegistrySessionInput } from './registry.js';
import { createNativeReverts } from './revert.js';
import type { PendingRevert, RevertResult, RevertTurnInput } from './revert.js';
import { createSnapshotStore } from './snapshots.js';
import type { SnapshotStore } from './snapshots.js';
import { readNativeStatistics } from './stats.js';
import type { NativeStatisticsBackendResult, NativeStatisticsQuery } from './stats.js';
import { createNativeConversations } from './conversations/runtime.js';
import type { ConversationNativeMessagePage } from './conversations/history.js';
import type {
  ConversationCodexCommandInput,
  ConversationCompactRequest,
  ConversationDeepseekCommandInput,
  ConversationPromptRequest,
  ConversationSessionAssist,
  ConversationSessionPatch,
  ConversationSessionWork,
  ConversationSourceLifecycle,
  NativeConversationsController,
} from './conversations/runtime.js';
import type { ConversationSelection } from './conversations/store.js';
import { agentConfigurationWriteSchema } from './agent-configuration.js';
import type { AgentConfigurationWrite, AgentModel } from './agent-configuration.js';
import { createNativeDelegation } from './delegation.js';
import type { DelegationToolConfig, NativeDelegation } from './delegation.js';

export type { PromptPart };

export interface PromptRequest {
  directory: string;
  messageID: string;
  parts: PromptPart[];
  model: { providerID: string; modelID: string };
  variant?: string | undefined;
  agent: 'build' | 'plan';
  preserveSelection?: boolean | undefined;
  instructions?: string | undefined;
  subagentModel?: AgentModel | null | undefined;
}

export type NativeMemorySharing = Pick<import('../agent-memory/native-sharing.js').NativeMemorySharing,
  'enabled' | 'context' | 'checkpoint' | 'release' | 'status' | 'connect' | 'disconnect' | 'importSource' | 'forget' | 'setProgressVisible'>;

export interface NativeAgentsRuntimeOptions {
  dataDir: string;
  resolveExecutable: CliResolver;
  buildChildEnv: () => Record<string, string>;
  clientVersion: string;
  publishNativeEvent: (event: NativePublishedEvent) => void;
  readGlobalInstructions?: (() => Promise<string | null>) | undefined;
  getSmallModelService?: (() => Promise<typeof import('../small-model/index.js')>) | undefined;
  snapshots?: SnapshotStore | undefined;
  loadSdk?: typeof loadClaudeSdk | undefined;
  resolveAntigravityCommand?: typeof resolveAgyCommand | undefined;
  now?: (() => number) | undefined;
  managedChatsRoots?: ReadonlyArray<string> | undefined;
  memory?: NativeMemorySharing | null | undefined;
  deepseekInstallation?: ReturnType<typeof createDeepseekInstallation> | undefined;
}

interface PromptSendRecord {
  modelID: string;
  agent: string;
  variant?: string;
}

interface TurnFinishedInfo {
  id?: string | undefined;
  summary?: string | undefined;
  status?: string | undefined;
}

interface CatalogModelDescriptor extends VariantCapableModel {
  id: string;
  aliases?: ReadonlyArray<{ id: string }> | undefined;
}

type SettledResult<Value> =
  | { status: 'ok'; value: Value }
  | { status: 'error'; message: string; reason?: 'unauthenticated' };

const CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const STOP_TIMEOUT_MS = 10_000;
const COMMANDS_CACHE_MS = 10 * 60_000;

const threadResponseSchema = z.object({
  thread: z.object({ id: z.string() }).passthrough(),
  serviceTier: z.string().nullish(),
}).passthrough();

const openChamberNamespace = z.record(z.string(), z.json()).catch({});

const hasErrorCode = (value: unknown): value is { code?: unknown } => isRecord(value);
const isNumber = (value: unknown): value is number => typeof value === 'number';
const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const antigravityUnsupported = (operation: string): NativeAgentError => new NativeAgentError(
  `Antigravity does not support ${operation} in OpenChamber`,
  { code: 'NATIVE_ANTIGRAVITY_UNSUPPORTED', status: 409 },
);

const settled = async <Value>(promise: Promise<Value>): Promise<SettledResult<Value>> => {
  try {
    return { status: 'ok', value: await promise };
  } catch (error) {
    if (hasErrorCode(error) && error.code === 'NATIVE_ANTIGRAVITY_UNAUTHENTICATED') {
      return { status: 'error', message: errorMessage(error), reason: 'unauthenticated' };
    }
    return { status: 'error', message: errorMessage(error) };
  }
};

const withHistoryMeasurements = (liveRecord: NativeMessageRecord, historyRecord: NativeMessageRecord): NativeMessageRecord => {
  const live = liveRecord.info;
  const history = historyRecord.info;
  if (live.role !== 'assistant' || history.role !== 'assistant') return liveRecord;
  if (!isNumber(live.time.completed) && isNumber(history.time.completed)) return historyRecord;
  if (live.tokens !== undefined && live.contextWindow !== undefined && live.contextCompaction !== undefined) return liveRecord;
  const info = { ...live };
  if (info.tokens === undefined && history.tokens !== undefined) info.tokens = history.tokens;
  if (info.contextWindow === undefined && history.contextWindow !== undefined) info.contextWindow = history.contextWindow;
  if (info.contextCompaction === undefined && history.contextCompaction !== undefined) info.contextCompaction = history.contextCompaction;
  if (info.tokens === live.tokens && info.contextWindow === live.contextWindow
    && info.contextCompaction === live.contextCompaction) return liveRecord;
  return { ...liveRecord, info };
};

export const overlay = (
  history: NativeMessageRecord[],
  live: ReadonlyArray<NativeMessageRecord> | null | undefined,
): NativeMessageRecord[] => {
  if (!live || live.length === 0) return history;
  const liveById = new Map(live.map((record) => [record.info.id, record]));
  const merged = history.map((record) => {
    const liveRecord = liveById.get(record.info.id);
    if (!liveRecord) return record;
    const measured = withHistoryMeasurements(liveRecord, record);
    if (!record.info.id.startsWith('nag_') || measured === record) return measured;
    const saved = new Map(record.parts.map((part) => [part.id, part]));
    const parts = measured.parts.map((part) => withAgyFileDetails(part, saved.get(part.id)));
    return parts.some((part, index) => part !== measured.parts[index]) ? { ...measured, parts } : measured;
  });
  const known = new Set(history.map((record) => record.info.id));
  for (const record of live) if (!known.has(record.info.id)) merged.push(record);
  return merged
    .map((record, index) => ({ record, index }))
    .sort((left, right) => (left.record.info.time.created - right.record.info.time.created) || (left.index - right.index))
    .map(({ record }) => record);
};

const untilRewound = (records: NativeMessageRecord[], pending: PendingRevert | null): NativeMessageRecord[] => {
  if (pending?.phase !== 'committed') return records;
  const index = records.findIndex((record) => record.info.id === pending.messageId);
  return index === -1 ? records : records.slice(0, index);
};

const storedOpenChamber = (metadata: JsonObject): JsonObject => openChamberNamespace.parse(metadata.openchamber ?? {});

const withoutServerMetadata = (metadata: JsonObject): JsonObject => {
  const namespace = storedOpenChamber(metadata);
  delete namespace.native;
  return { ...metadata, openchamber: namespace };
};

export const createNativeAgentsRuntime = ({
  dataDir,
  resolveExecutable,
  buildChildEnv,
  clientVersion,
  publishNativeEvent,
  readGlobalInstructions = async () => null,
  getSmallModelService = async () => import('../small-model/index.js'),
  snapshots = createSnapshotStore({ dataDir }),
  loadSdk = loadClaudeSdk,
  resolveAntigravityCommand = resolveAgyCommand,
  now = Date.now,
  managedChatsRoots = [],
  memory = null,
  deepseekInstallation = createDeepseekInstallation({ dataDir, resolveExecutable, buildEnv: buildChildEnv }),
}: NativeAgentsRuntimeOptions) => {
  const registry = createNativeRegistry({ filePath: path.join(dataDir, 'native-agents', 'registry.json'), now });
  const claudeConnections = createClaudeConnections({ dataDir });
  const reverts = createNativeReverts({ registry, snapshots });
  let conversations: NativeConversationsController<typeof native> | undefined = undefined;
  let planExecution: NativePlanExecution | undefined = undefined;
  let delegation: NativeDelegation | undefined = undefined;
  const sourceTools = new Map<string, DelegationToolConfig | null>();
  const antigravityPreparations = new Map<string, AbortController>();
  const publisher = createNativeEventPublisher({
    publishNativeEvent: (event) => {
      delegation?.observe(event);
      return conversations ? conversations.publish(event) : publishNativeEvent(event);
    },
    now,
  });
  const interactions = createNativeInteractions({ dataDir, now });
  const questions = createQuestionRegistry({
    publish: (directory, payload) => publisher.emit(directory, payload.type, payload.properties),
    executePlan: (context, outcome, actions) => {
      if (!planExecution) throw new NativeAgentError('Native plan execution is unavailable', { status: 503, code: 'NATIVE_UNAVAILABLE' });
      return planExecution.execute(context, outcome, actions);
    },
    canExecutePlan: (request) => {
      const source = decodeNativeSessionId(request.sessionID);
      return Boolean(planExecution && source && !registry.isDelegatedSession(request.sessionID) && !(source.backend === NATIVE_BACKEND_CLAUDE && source.toolUseId));
    },
    onSettled: async (request, outcome, directory) => {
      const firstAnswer = outcome.status === 'replied' && outcome.answers.length === 1 && outcome.answers[0]?.length === 1
        ? outcome.answers[0][0]
        : undefined;
      const approved = firstAnswer === 'build';
      const keepPlanning = firstAnswer === 'plan';
      if (request.kind?.endsWith('-plan-exit') && approved) delegation?.promote(request.sessionID);
      await planExecution?.settled(request, outcome);
      const hasExecution = (outcome.status === 'replied' || outcome.status === 'transferred') && Boolean(outcome.execution);
      if (!hasExecution) await interactions.record(request, outcome);
      if (request.kind?.endsWith('-plan-exit') && (outcome.status === 'rejected' || keepPlanning) && !request.executionPending) {
        try { await delegation?.cancel((await registry.getSession(request.sessionID))?.conversationId ?? request.sessionID); }
        catch { publisher.error(directory, request.sessionID, unknownError('Some subagents could not be confirmed stopped. Inspect their tasks before retrying.')); }
      }
      if (!request.tool) return;
      try {
        const decoded = decodeNativeSessionId(request.sessionID);
        const history = decoded?.backend === NATIVE_BACKEND_ANTIGRAVITY
          ? await antigravity.store.loadHistory(request.sessionID, decoded.conversationId, directory)
          : decoded?.backend === NATIVE_BACKEND_DEEPSEEK
            ? await deepseek.loadMessages(request.sessionID, directory, { limit: 200 })
            : await (decoded?.backend === 'codex' ? codex : claude).loadHistory(request.sessionID, directory);
        const records = await interactions.attach(request.sessionID, overlay(history?.records ?? [], liveFor(request.sessionID).liveRecords(request.sessionID)));
        for (const record of records) {
          for (const part of record.parts) {
            if (part.type === 'tool' && part.tool === 'question' && (part.callID === request.tool.callID || part.callID === request.id)) {
              if (!conversations?.publishInteraction(request.sessionID, part)) publisher.part(directory, request.sessionID, part);
            }
          }
        }
      } catch {
        void 0;
      }
    },
  });
  const planDecisions = createCodexPlanDecisions({
    questions,
    prompt: (sessionId, request, signal) => conversations
      ? conversations.automaticPrompt(sessionId, request, signal)
      : prompt(sessionId, request, signal),
    failed: (plan, error) => publisher.error(plan.directory, plan.sessionId, unknownError(error.message)),
  });

  const withRevert = async (record: NativeSessionRecord): Promise<NativeSessionRecord> => {
    const pending = await reverts.pending(record.id);
    return pending?.phase === 'pending' ? { ...record, revert: { messageID: pending.messageId } } : record;
  };

  const withMetadata = async (record: NativeSessionRecord): Promise<NativeSessionRecord> => {
    const entry = await registry.getSession(record.id);
    const stored: JsonObject = entry?.metadata ?? {};
    const nativeMetadata = { ...record.metadata.openchamber.native };
    if (entry?.agentConfiguration) nativeMetadata.agents = entry.agentConfiguration;
    const baseRecord: NativeSessionRecord = entry?.delegation ? { ...record, parentID: entry.delegation.parentID } : record;
    const storedNamespace = storedOpenChamber(stored);
    return {
      ...baseRecord,
      metadata: {
        ...baseRecord.metadata,
        ...stored,
        openchamber: { ...storedOpenChamber(baseRecord.metadata), ...storedNamespace, native: nativeMetadata },
      },
    };
  };

  const decorate = async (record: NativeSessionRecord): Promise<NativeSessionRecord> => withMetadata(await withRevert(record));

  const adoptSession = async (sessionId: string, directory: string): Promise<void> => {
    const decoded = decodeOwnSession(sessionId);
    if (decoded.backend === NATIVE_BACKEND_DEEPSEEK) {
      await deepseek.adopt(sessionId, directory);
      return;
    }
    const createdAt = now();
    await registry.registerSession(sessionId, {
      backend: decoded.backend,
      nativeId: decoded.backend === NATIVE_BACKEND_CLAUDE
        ? decoded.sessionUuid
        : decoded.backend === NATIVE_BACKEND_ANTIGRAVITY ? decoded.conversationId : decoded.threadId,
      directory,
      origin: 'adopted',
      createdAt,
      confirmedAt: createdAt,
    });
  };

  const publishSession = async (sessionId: string, directory: string): Promise<NativeSessionRecord | null> => {
    const session = await storeFor(sessionId).getSession(sessionId, directory);
    if (!session) return null;
    const record = await decorate(session);
    publisher.session(directory, record, { created: false });
    return record;
  };

  const settleClaudeRewind = async (sessionId: string, directory: string): Promise<PendingRevert | null> => {
    const pending = await reverts.pending(sessionId);
    if (pending?.phase !== 'committed') return pending;
    if (await claude.chainHolds(sessionId, directory, pending.messageId)) return pending;
    await reverts.finishCommit(sessionId);
    return null;
  };

  const checkpointTurn = async (sessionId: string, directory: string, turn?: TurnFinishedInfo | null): Promise<void> => {
    const observedAt = now();
    if (memory) {
      try {
        if (!await memory.enabled() || !turn
          || (decode(sessionId).backend === NATIVE_BACKEND_ANTIGRAVITY && isEnterpriseMode())) {
          memory.release(sessionId);
          return;
        }
        await memory.checkpoint({
          backend: decode(sessionId).backend,
          sessionId,
          directory,
          delivery: 'managed',
          turnId: turn.id,
          summary: (turn.summary ?? '').slice(0, 12000),
          status: turn.status === 'completed' ? 'completed' : 'interrupted',
          observedAt,
        });
      } catch { memory.release(sessionId); }
    }
  };

  const onTurnFinished = (sessionId: string, directory: string, turn?: TurnFinishedInfo | null): void => {
    void checkpointTurn(sessionId, directory, turn);
    const initialSession = (async () => {
      try {
        const entry = await registry.getSession(sessionId);
        await registry.confirmSession(sessionId);
        if (decode(sessionId).backend === NATIVE_BACKEND_CLAUDE) {
          if (entry?.confirmedAt === undefined && entry?.title !== undefined) await claude.rename(sessionId, directory, entry.title);
          await settleClaudeRewind(sessionId, directory);
        }
        await publishSession(sessionId, directory);
        return entry?.confirmedAt === undefined ? entry : null;
      } catch (error) {
        console.warn('[native-agents] could not refresh the session after a turn:', sessionId, errorMessage(error));
        return null;
      }
    })();
    if (decode(sessionId).backend === NATIVE_BACKEND_CODEX && turn?.status === 'completed' && turn.id) {
      void codexTitles.generate({ sessionId, directory, turnId: turn.id, initialSession }).catch((error) => {
        console.warn('[native-agents] could not generate the initial Codex title:', sessionId, errorMessage(error));
      });
    }
  };

  const onIdle = (sessionId: string): void => {
    memory?.release(sessionId);
    void reverts.afterTurn(sessionId);
    if (appServer.isStale() && codexLive?.isIdle()) void appServer.restart();
  };

  let codexLive: ReturnType<typeof createCodexLiveThreads> | null = null;
  const codexConnections = createCodexConnections({ dataDir });
  const codexCatalog = createCodexCatalog({ request: (method, params) => appServer.request(method, params), buildEnv: buildChildEnv });
  const codexCommands = createCodexCommands({ request: (method, params) => appServer.request(method, params) });
  const codexUtility = createCodexUtility({ request: (method, params) => appServer.request(method, params), catalog: codexCatalog });
  const appServer = createCodexAppServer({
    resolveExecutable: () => resolveExecutable('codex'),
    buildEnv: buildChildEnv,
    buildConnectionOverrides: () => codexConnections.launch(),
    onNotification: (method, params) => {
      if (!codexUtility.handleNotification(method, params)) codexLive?.handleNotification(method, params);
    },
    onServerRequest: (method, params) => {
      if (codexUtility.ownsRequest(params)) return Promise.reject(new Error('Tools are unavailable for utility generation'));
      if (!codexLive) return Promise.reject(new Error('Codex live runtime is not ready'));
      return codexLive.handleServerRequest(method, params);
    },
    onExit: (error) => {
      planDecisions.clear();
      codexUtility.handleExit(error);
      codexLive?.handleExit(errorMessage(error));
    },
    clientVersion,
  });
  const codexLiveInstance = createCodexLiveThreads({
    toolConfiguration: (id) => sourceTools.get(id) ?? undefined,
    request: (method, params) => appServer.request(method, params),
    readGlobalInstructions,
    readTurnDetails: (sessionId, turnId) => codex.readTurnDetails(sessionId, turnId),
    publisher,
    questions,
    onTurnFinished,
    onIdle,
    onPlanReady: (plan) => registry.isDelegatedSession(plan.sessionId) ? undefined : planDecisions.propose(plan),
    onSessionClosed: (sessionId) => {
      memory?.release(sessionId);
      planDecisions.cancel(sessionId);
    },
    now,
  });
  codexLive = codexLiveInstance;
  const claude = createClaudeSessionStore({ loadSdk, registry, connections: claudeConnections, isSessionRunning: (sessionId) => claudeLive.isSessionRunning(sessionId) });
  const codex = createCodexSessionStore({ appServer, registry, readGlobalInstructions });
  const codexTitles = createCodexAutoTitles({
    store: codex,
    pendingRevert: (sessionId) => reverts.pending(sessionId),
    generateText: async (input) => (await getSmallModelService()).generateSmallModelText(input),
    publishSession,
  });
  const checklists = createClaudeChecklists({
    publisher,
    now,
    readProjection: (identity) => registry.checklistProjection(identity),
    writeProjection: (identity, projection) => registry.setChecklistProjection(identity, projection),
  });
  const claudeLive = createClaudeLiveSessions({
    toolConfiguration: (id) => sourceTools.get(id) ?? undefined,
    loadSdk,
    resolveExecutable: () => resolveExecutable('claude'),
    buildEnv: buildChildEnv,
    readGlobalInstructions,
    hasTranscript: claude.hasTranscript,
    inspectReplayHistory: claude.inspectReplayHistory,
    publisher,
    questions,
    onTurnFinished,
    onIdle,
    checklists,
    onChecklistSource: async (sessionId, directory, source) => {
      if (!await registry.getSession(sessionId)) await adoptSession(sessionId, directory);
      await registry.updateSession(sessionId, { claudeChecklistSource: source });
    },
    now,
  });
  const claudeUtility = createClaudeUtility({
    loadSdk,
    launchableExecutable: () => launchableClaudeExecutable(() => resolveExecutable('claude')),
    buildEnv: buildChildEnv,
    connections: { hasCredentials: claudeConnections.hasCredentials, resolve: claudeConnections.resolve },
  });
  const deepseekMaintenance = createDeepseekMaintenance({ dataDir, resolveNodeExecutable: () => resolveExecutable('node'), buildEnv: buildChildEnv });
  const deepseek = createDeepseekBackend({
    toolConfiguration: (id) => sourceTools.get(id) ?? undefined,
    resolveExecutable: () => deepseekInstallation.resolve(),
    buildEnv: buildChildEnv,
    reverts,
    memory,
    maintenance: deepseekMaintenance,
    resolveNodeExecutable: () => resolveExecutable('node'),
    registry,
    publisher,
    questions,
    readGlobalInstructions,
    now,
    decorateSession: decorate,
  });
  const deepseekSetup = createDeepseekSetup({ installation: deepseekInstallation });
  const antigravity = createAntigravityBackend({
    toolConfiguration: (id) => sourceTools.get(id) ?? undefined,
    resolveExecutable: () => resolveExecutable('agy'),
    buildEnv: buildChildEnv,
    resolveNodeExecutable: () => resolveExecutable('node'),
    resolveCommand: resolveAntigravityCommand,
    registry,
    publisher,
    readGlobalInstructions,
    decorateSession: decorate,
    now,
    onTurnFinished: checkpointTurn,
    onInteraction: async (proposal) => {
      if ((await registry.getSession(proposal.sessionId))?.delegation) return;
      if (!await registry.getSession(proposal.sessionId)) await adoptSession(proposal.sessionId, proposal.directory);
      await antigravityDecisions.propose(proposal);
    },
  });
  const antigravityDecisions = createAntigravityDecisions({
    registry,
    questions,
    interactions,
    loadProposal: async (sessionId, directory) => {
      const decoded = decodeNativeSessionId(sessionId);
      if (decoded?.backend !== NATIVE_BACKEND_ANTIGRAVITY) return null;
      if (antigravity.busySessionIds(directory).includes(sessionId)) return null;
      const history = await antigravity.store.loadHistory(sessionId, decoded.conversationId, directory);
      if (!history || history.interactionSourceComplete === false) {
        throw new NativeAgentError('Antigravity interaction history is unavailable or incomplete. Reload the conversation before replying.', {
          code: 'NATIVE_ANTIGRAVITY_HISTORY_UNAVAILABLE', status: 502,
        });
      }
      return history.interactionProposal ?? null;
    },
    prompt: (sessionId, request, signal) => conversations
      ? conversations.automaticPrompt(sessionId, request, signal)
      : prompt(sessionId, request, signal),
    failed: (proposal, error) => publisher.error(proposal.directory, proposal.sessionId, unknownError(error.message)),
  });

  const decode = (sessionId: string): NativeSessionRef => {
    const decoded = decodeNativeSessionId(sessionId);
    if (!decoded) throw invalidRequestError(`Not a native session id: ${sessionId}`);
    return decoded;
  };

  const decodeOwnSession = (sessionId: string): NativeSessionRef => {
    const decoded = decode(sessionId);
    if (decoded.backend === NATIVE_BACKEND_CLAUDE && decoded.toolUseId !== null) {
      throw invalidRequestError('A Claude Code subagent session belongs to its parent session');
    }
    return decoded;
  };

  const storeFor = (sessionId: string) => ({ claude, codex, deepseek, antigravity })[decode(sessionId).backend];
  const liveFor = (sessionId: string) => ({ claude: claudeLive, codex: codexLiveInstance, deepseek, antigravity })[decode(sessionId).backend];

  const assertDelegationRoot = async (sessionId: string): Promise<void> => {
    if ((await registry.getSession(sessionId))?.delegation) throw invalidRequestError('Subagent sessions are controlled by their parent conversation');
  };

  const committing = async (
    sessionId: string,
    directory: string,
    pending: PendingRevert | null,
    step: () => Promise<void>,
  ): Promise<void> => {
    if (pending?.phase !== 'pending') {
      await step();
      return;
    }
    await reverts.beginCommit(sessionId);
    try {
      await step();
    } catch (error) {
      await reverts.cancelCommit(sessionId);
      await publishSession(sessionId, directory);
      throw error;
    }
    await publishSession(sessionId, directory);
  };

  const assertSessionBackend = (backend: NativeBackend, providerID: string): void => {
    if (nativeBackendOfProviderId(providerID) !== backend) {
      throw new NativeAgentError('A native session keeps the CLI it started with', { code: 'NATIVE_BACKEND_MISMATCH', status: 409 });
    }
  };

  const sendRecordOf = (request: { model: { modelID: string }; agent: 'build' | 'plan'; variant?: string | undefined }): PromptSendRecord => {
    const send: PromptSendRecord = { modelID: request.model.modelID, agent: request.agent };
    if (request.variant !== undefined) send.variant = request.variant;
    return send;
  };

  const claudeCommands = new Map<string, { at: number; commands: Promise<Array<{ name: string; description: string; argumentHint: string }>> }>();

  const sendToClaude = async (
    sessionId: string,
    request: PromptRequest,
    send: PromptSendRecord,
    {
      visible,
      launchOverride = null,
      signal = null,
    }: {
      visible: boolean;
      launchOverride?: ((launch: ClaudeConnectionLaunch) => ClaudeConnectionLaunch) | null | undefined;
      signal?: AbortSignal | null | undefined;
    },
  ): Promise<void> => {
    const { directory, messageID } = request;
    let launch = await claudeConnections.resolve(request.model.modelID, request.variant ?? null);
    if (launchOverride) launch = launchOverride(launch);
    if (launch.descriptor && request.variant !== undefined && !launch.descriptor.efforts.includes(request.variant)) {
      throw invalidRequestError('This model does not support the selected reasoning effort');
    }
    const blocks = claudePromptBlocks(request.parts);
    const pending = await settleClaudeRewind(sessionId, directory);
    await committing(sessionId, directory, pending, async () => {
      await reverts.beforePrompt(sessionId, directory, messageID);
      signal?.throwIfAborted();
      await claudeLive.prompt({
        signal,
        sessionId,
        directory,
        messageId: messageID,
        content: visible ? { kind: 'blocks', blocks } : null,
        sdkContent: blocks,
        config: {
          model: launch.model,
          launch,
          effort: request.variant !== undefined && CLAUDE_EFFORTS.has(request.variant) ? request.variant : null,
          permissionMode: request.agent === 'plan' ? 'plan' : 'bypassPermissions',
        },
        send,
        rewind: pending?.resumeAt === undefined ? null : { messageId: pending.messageId, resumeAt: pending.resumeAt },
      });
    });
  };

  const commitCodexRevert = async (sessionId: string, directory: string): Promise<void> => {
    const pending = await reverts.pending(sessionId);
    await committing(sessionId, directory, pending, async () => {
      if (pending?.beforeTurnId === undefined) return;
      await codexLiveInstance.revertThread(sessionId, pending.beforeTurnId);
      await reverts.finishCommit(sessionId);
    });
  };

  const stopTurn = async (sessionId: string): Promise<void> => {
    antigravityPreparations.get(sessionId)?.abort();
    let delegationError: unknown;
    try { await delegation?.cancel((await registry.getSession(sessionId))?.conversationId ?? sessionId); }
    catch (error) { delegationError = error; }
    planDecisions.cancel(sessionId);
    await antigravityDecisions.cancel(sessionId);
    const { backend } = decode(sessionId);
    if (backend === NATIVE_BACKEND_DEEPSEEK) {
      await deepseek.stop(sessionId);
      if (delegationError) throw delegationError;
      return;
    }
    const live = { claude: claudeLive, codex: codexLiveInstance, antigravity }[backend];
    await live.abort(sessionId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), STOP_TIMEOUT_MS);
    });
    try {
      if (await Promise.race([live.whenIdle(sessionId).then(() => false), timedOut])) throw sessionBusyError();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (delegationError) throw delegationError;
  };

  const prompt = async (sessionId: string, request: PromptRequest, signal?: AbortSignal): Promise<void> => {
    const { backend } = decode(sessionId);
    assertSessionBackend(backend, request.model.providerID);
    await planExecution?.beforePrompt(sessionId, request.messageID);
    sourceTools.set(sessionId, await delegation?.prepare(sessionId, request) ?? null);
    if (backend === NATIVE_BACKEND_DEEPSEEK) {
      signal?.throwIfAborted();
      const knowledge = memory ? await memory.context({ backend, sessionId, directory: request.directory, delivery: 'managed' }).catch(() => null) : null;
      try {
        await deepseek.prompt(sessionId, { ...request, instructions: [request.instructions, knowledge?.text].filter(Boolean).join('\n\n') || undefined }, signal);
      } catch (error) {
        if (!hasErrorCode(error) || error.code !== 'NATIVE_PROMPT_OUTCOME_UNKNOWN') memory?.release(sessionId);
        throw error;
      }
      await registry.recordSend(sessionId, { ...sendRecordOf(request), messageId: request.messageID, providerID: request.model.providerID, sentAt: now() });
      return;
    }
    if (backend === NATIVE_BACKEND_ANTIGRAVITY) {
      signal?.throwIfAborted();
      await antigravityDecisions.beforePrompt(sessionId, request.messageID);
      if (antigravityPreparations.has(sessionId)) throw sessionBusyError();
      const preparation = new AbortController();
      antigravityPreparations.set(sessionId, preparation);
      const admissionSignal = signal ? AbortSignal.any([signal, preparation.signal]) : preparation.signal;
      try {
        const commandParts = await antigravity.commandParts(request.parts, request.directory);
        admissionSignal.throwIfAborted();
        const knowledge = memory && !isEnterpriseMode() ? await memory.context({ backend, sessionId, directory: request.directory, delivery: 'managed' }).catch(() => null) : null;
        const parts = withInstructions(commandParts, [request.instructions, knowledge?.text].filter(Boolean).join('\n\n') || undefined);
        await antigravity.prompt(sessionId, { ...request, parts }, admissionSignal);
      } catch (error) {
        if (!hasErrorCode(error) || error.code !== 'NATIVE_PROMPT_OUTCOME_UNKNOWN') memory?.release(sessionId);
        throw error;
      } finally {
        if (antigravityPreparations.get(sessionId) === preparation) antigravityPreparations.delete(sessionId);
      }
      return;
    }
    if (signal) signal.throwIfAborted();
    else planDecisions.cancel(sessionId);
    const send = sendRecordOf(request);
    const knowledge = memory ? await memory.context({
      backend, sessionId, directory: request.directory, delivery: 'managed',
    }).catch(() => null) : null;
    const parts = withInstructions(request.parts, [request.instructions, knowledge?.text].filter(Boolean).join('\n\n') || undefined);
    try {
      if (backend === NATIVE_BACKEND_CLAUDE) {
        await sendToClaude(sessionId, { ...request, parts }, send, { visible: true, signal });
      } else {
        const input = await codexCommands.promptInput(parts, request.directory);
        signal?.throwIfAborted();
        await commitCodexRevert(sessionId, request.directory);
        signal?.throwIfAborted();
        await reverts.beforePrompt(sessionId, request.directory, request.messageID);
        signal?.throwIfAborted();
        const launch = await codexConnections.resolve(request.model.modelID);
        signal?.throwIfAborted();
        await codexLiveInstance.prompt({
          sessionId,
          directory: request.directory,
          messageId: request.messageID,
          input,
          config: { model: launch.model, providerId: launch.providerId, ...codexVariantSettings(request.variant), mode: request.agent === 'plan' ? 'plan' : 'default' },
          send,
          signal,
        });
      }
      await registry.recordSend(sessionId, { ...send, messageId: request.messageID, providerID: request.model.providerID, sentAt: now() });
    } catch (error) {
      memory?.release(sessionId);
      throw error;
    }
  };

  const createSession = async (
    { backend, directory, title }: { backend: NativeBackend; directory: string; title?: string | undefined },
    {
      beforePublish = async () => undefined,
      toolLaunch,
    }: {
      beforePublish?: ((record: NativeSessionRecord) => Promise<void>) | undefined;
      toolLaunch?: { subagentModel?: AgentModel | null | undefined; child?: boolean | undefined } | undefined;
    } = {},
  ): Promise<NativeSessionRecord> => {
    if (backend === NATIVE_BACKEND_DEEPSEEK) {
      const session = await deepseek.createSession(directory, title, beforePublish);
      publisher.session(session.directory, session, { created: true });
      return session;
    }
    if (backend === NATIVE_BACKEND_ANTIGRAVITY) {
      const record = await antigravity.createSession({ directory, title });
      await beforePublish(record);
      publisher.session(directory, record, { created: true });
      return record;
    }
    let sessionId: string | undefined;
    let nativeId: string;
    let serviceTier: string | null = null;
    const launch = backend === NATIVE_BACKEND_CODEX && toolLaunch && delegation
      ? await delegation.prepareLaunch({ ...toolLaunch, directory })
      : null;
    try {
      if (backend === NATIVE_BACKEND_CLAUDE) {
        nativeId = randomUUID();
        sessionId = encodeClaudeSessionId(nativeId);
      } else {
        const start: JsonObject = {
          cwd: directory,
          approvalPolicy: 'never',
          sandbox: 'danger-full-access',
          developerInstructions: (await readGlobalInstructions()) ?? undefined,
        };
        if (launch) start.config = codexThreadToolConfig(launch.tools);
        const started = threadResponseSchema.parse(await appServer.request('thread/start', start));
        nativeId = started.thread.id;
        sessionId = encodeCodexSessionId(nativeId);
        serviceTier = started.serviceTier ?? null;
        if (title !== undefined) {
          await codex.rename(sessionId, title).catch((error) => {
            console.warn('[native-agents] could not name the new Codex thread:', sessionId, errorMessage(error));
          });
        }
      }
      const entry: RegistrySessionInput = { backend, nativeId, directory, origin: 'openchamber', createdAt: now() };
      if (title !== undefined) entry.title = title;
      await registry.registerSession(sessionId, entry);
      const record = unconfirmedSessionRecord({ sessionId, ...entry });
      await beforePublish(record);
      if (launch) {
        await launch.bind(sessionId);
        sourceTools.set(sessionId, launch.tools);
      }
      if (backend === NATIVE_BACKEND_CODEX) codexLiveInstance.threadStarted(sessionId, directory, serviceTier, launch?.tools.key ?? '');
      publisher.session(directory, record, { created: true });
      return record;
    } catch (error) {
      launch?.cancel();
      if (sessionId) sourceTools.delete(sessionId);
      throw error;
    }
  };

  const applyCodexConnectionChange = async (): Promise<void> => {
    if (codexLiveInstance.isIdle()) await appServer.restart();
    else appServer.markStale();
  };

  const stopConversationSource = async (sessionId: string): Promise<void> => {
    let stopError: unknown;
    try { await native.abort(sessionId); }
    catch (error) { stopError = error; }
    try { await stopTurn(sessionId); }
    finally { await sourceLifecycle[decode(sessionId).backend].retire(sessionId); }
    if (stopError) throw stopError;
  };

  const sourceLifecycle = {
    claude: { retire: (id: string) => { delegation?.retire(id); return claudeLive.closeSession(id); }, stop: stopConversationSource, delete: true, compact: true, rewind: true },
    codex: { retire: async (id: string) => { delegation?.retire(id); }, stop: stopConversationSource, delete: true, compact: true, rewind: true },
    deepseek: { retire: async (id: string) => { delegation?.retire(id); }, stop: (id: string) => deepseek.stop(id), delete: true, compact: true, rewind: true },
    antigravity: { retire: (id: string) => { delegation?.retire(id); return antigravity.closeSession(id); }, stop: stopConversationSource, delete: false, compact: false, rewind: false },
  } satisfies Record<NativeBackend, ConversationSourceLifecycle>;

  const native = {
    canDeleteDelegations: (id: string): boolean => delegation?.canDelete(id) ?? false,
    canDeleteSource: (backend: NativeBackend): boolean => delegation?.canDeleteBackend(backend) ?? backend !== 'antigravity',
    hasActiveDelegations: (id: string): boolean => delegation?.hasActive(id) ?? false,
    hasPendingDelegationTool(id: string): boolean {
      if (!delegation?.usedInTurn(id)) return false;
      const records = liveFor(id).liveRecords(id);
      return records?.some((record) => record.parts.some((part) => part.type === 'tool' && part.state.status === 'running' && part.tool !== 'plan_exit')) ?? false;
    },
    cancelDelegations: async (id: string): Promise<boolean> => delegation ? delegation.cancel(id) : false,
    assertDelegatedDeletion: async (id: string): Promise<void> => { await delegation?.assertDeletion(id); },
    removeDelegatedChildren: async (id: string, retained?: ReadonlySet<string>): Promise<void> => { await delegation?.removeChildren(id, retained); },
    async validateAgentConfiguration(configuration: AgentConfigurationWrite, main?: ConversationSelection | null): Promise<AgentConfigurationWrite> {
      const parsed = agentConfigurationWriteSchema.parse(configuration);
      if (!delegation) throw new NativeAgentError('Cross-CLI subagents are unavailable', { status: 503, code: 'NATIVE_DELEGATION_UNAVAILABLE' });
      if (main) {
        const mainModel: AgentModel = main.variant !== undefined
          ? { model: main.model, variant: main.variant }
          : { model: main.model };
        await delegation.validateModel(mainModel);
      }
      for (const choice of [parsed.subagent, parsed.execution]) if (choice) await delegation.validateModel(choice);
      return parsed;
    },
    async configureAgents(
      sessionId: string,
      directory: string,
      configuration: AgentConfigurationWrite,
      expectedRevision: number,
      main?: ConversationSelection | undefined,
    ): Promise<NativeSessionRecord | null> {
      if (isEnterpriseMode()) throw new NativeAgentError('Cross-CLI subagents are unavailable in enterprise mode', { status: 403, code: 'enterprise_mode' });
      if (main) throw invalidRequestError('Apply combinations in a unified native conversation');
      await adoptSession(sessionId, directory);
      const session = await native.getSession(sessionId, directory);
      if (session.parentID) throw invalidRequestError('Subagent settings belong to the parent conversation');
      const parsed = await native.validateAgentConfiguration(configuration);
      if (!await registry.setAgentConfiguration(sessionId, parsed, expectedRevision)) {
        throw new NativeAgentError('The subagent selection changed. Reload and retry.', { status: 409, code: 'NATIVE_CONVERSATION_SELECTION_CONFLICT' });
      }
      return publishSession(sessionId, directory);
    },
    delegatedChildren: async (parentID: string): Promise<NativeSessionRecord[]> => delegation ? delegation.children(parentID) : [],
    memorySharing: memory,
    statistics: (
      query: NativeStatisticsQuery,
      options?: { scopeDirectories?: ReadonlyArray<string> | undefined; signal?: AbortSignal | undefined; sourceTimeoutMs?: number | undefined },
    ): Promise<{ backends: Record<string, NativeStatisticsBackendResult> }> => readNativeStatistics({
      query,
      backends: { claude, codex, deepseek, antigravity: antigravity.store },
      ...options,
    }),
    claudeConnections,
    codexConnections,
    async saveCodexConnection(id: string | null, input: CodexConnectionWrite) {
      const saved = await codexConnections.save(id, input);
      await applyCodexConnectionChange();
      return saved;
    },
    async removeCodexConnection(id: string) {
      const result = await codexConnections.remove(id);
      await applyCodexConnectionChange();
      return result;
    },

    antigravityQuota: () => antigravity.quota(),
    deepseekSetup,

    async capabilities() {
      const delegationReady = delegation ? await delegation.initialize().then(() => true, () => false) : false;
      const [claudeCli, codexCli, deepseekCli, agyCli, nodeCli] = await Promise.all([
        resolveExecutable('claude'),
        resolveExecutable('codex'),
        deepseekInstallation.resolve(),
        resolveExecutable('agy'),
        resolveExecutable('node'),
      ]);
      return {
        supported: true,
        backends: {
          [NATIVE_BACKEND_CLAUDE]: { cli: claudeCli !== null, tasks: { checklist: true, background: true, output: true, stop: true } },
          [NATIVE_BACKEND_CODEX]: { cli: codexCli !== null, tasks: { plan: true, todos: true } },
          [NATIVE_BACKEND_DEEPSEEK]: {
            cli: deepseekCli !== null,
            blockedByEnterprise: isEnterpriseMode(),
            tasks: { checklist: true },
            actions: { revert: true, delete: deepseekCli !== null && await deepseekPackage(deepseekCli) !== null && await resolveExecutable('node') !== null, fork: true },
          },
          [NATIVE_BACKEND_ANTIGRAVITY]: {
            cli: agyCli !== null,
            blockedByEnterprise: false,
            tasks: { checklist: nodeCli !== null, background: true, output: true, stop: false },
            actions: { revert: false, delete: false, fork: false, compact: false },
          },
        },
        registry: registry.status(),
        agentCombinations: !isEnterpriseMode() && nodeCli !== null && delegationReady,
        delegationBackends: isEnterpriseMode() || nodeCli === null || !delegationReady ? [] : ['claude', 'codex', 'deepseek', 'antigravity'],
      };
    },

    async catalog() {
      const [codexList, claudeList, deepseekList, antigravityList] = await Promise.all([
        settled((async () => [...await codexCatalog(), ...await codexConnections.catalog()])()),
        settled(claudeConnections.catalog()),
        settled(deepseek.catalog()),
        settled(antigravity.catalog()),
      ]);
      return {
        backends: {
          [NATIVE_BACKEND_CLAUDE]: claudeList.status === 'ok' ? { status: 'ok' as const, models: claudeList.value } : claudeList,
          [NATIVE_BACKEND_DEEPSEEK]: deepseekList.status === 'ok' ? { status: 'ok' as const, models: deepseekList.value } : deepseekList,
          [NATIVE_BACKEND_CODEX]: codexList.status === 'ok' ? { status: 'ok' as const, models: codexList.value } : codexList,
          [NATIVE_BACKEND_ANTIGRAVITY]: antigravityList.status === 'ok' ? { status: 'ok' as const, models: antigravityList.value } : antigravityList,
        },
      };
    },

    async listSessions(directory: string) {
      const [claudeSessions, codexSessions, deepseekSessions, antigravitySessions] = await Promise.all([
        settled(claude.listRootSessions(directory)),
        settled(codex.listRootSessions(directory)),
        settled(deepseek.listRootSessions(directory)),
        settled(antigravity.listRootSessions(directory)),
      ]);
      const partition = async (result: SettledResult<NativeSessionRecord[]>) => {
        if (result.status !== 'ok') return result;
        const sessions = await Promise.all(result.value.map(decorate));
        return { status: 'ok' as const, sessions: sessions.filter((session) => !session.parentID) };
      };
      return {
        backends: {
          [NATIVE_BACKEND_CLAUDE]: await partition(claudeSessions),
          [NATIVE_BACKEND_CODEX]: await partition(codexSessions),
          [NATIVE_BACKEND_DEEPSEEK]: await partition(deepseekSessions),
          [NATIVE_BACKEND_ANTIGRAVITY]: await partition(antigravitySessions),
        },
      };
    },

    async managedChatDirectories(): Promise<string[]> {
      const roots = new Set<string>();
      for (const root of managedChatsRoots) {
        roots.add(path.resolve(root));
        try {
          roots.add(fs.realpathSync.native(root));
        } catch {
          void 0;
        }
      }
      const directories = new Set((await registry.listSessions()).map((entry) => entry.directory));
      return Array.from(directories).filter((directory) => {
        const resolved = path.resolve(directory);
        return Array.from(roots).some((root) => resolved.startsWith(`${root}${path.sep}`));
      });
    },

    async getSession(sessionId: string, directory: string): Promise<NativeSessionRecord> {
      const session = liveFor(sessionId).childSession(sessionId) ?? await storeFor(sessionId).getSession(sessionId, directory);
      if (!session) throw sessionNotFoundError(sessionId);
      return decorate(session);
    },

    createSession,

    async prompt(id: string, request: ConversationPromptRequest, signal?: AbortSignal): Promise<void> {
      await assertDelegationRoot(id);
      return prompt(id, request, signal);
    },

    async compact(sessionId: string, request: ConversationCompactRequest): Promise<void> {
      await assertDelegationRoot(sessionId);
      const { backend } = decodeOwnSession(sessionId);
      assertSessionBackend(backend, request.model.providerID);
      if (backend === NATIVE_BACKEND_ANTIGRAVITY) throw antigravityUnsupported('compaction');
      if (backend === NATIVE_BACKEND_DEEPSEEK) {
        await deepseek.executeCommand(sessionId, request.directory, request.instructions ? `/compact ${request.instructions}` : '/compact');
        return;
      }
      planDecisions.cancel(sessionId);
      if (backend === NATIVE_BACKEND_CLAUDE) {
        const text = request.instructions === undefined ? '/compact' : `/compact ${request.instructions}`;
        const command: PromptRequest = { ...request, messageID: claudeUserMessageId(randomUUID()), parts: [{ type: 'text', text }] };
        await sendToClaude(sessionId, command, sendRecordOf(request), { visible: false, launchOverride: compactLaunchOverride });
        return;
      }
      if (request.instructions !== undefined) throw invalidRequestError('Codex compacts without instructions');
      await commitCodexRevert(sessionId, request.directory);
      await codexLiveInstance.compact(sessionId, request.directory);
    },

    async commands(backend: NativeBackend, directory: string, sessionId?: string) {
      if (backend === NATIVE_BACKEND_ANTIGRAVITY) return antigravity.commands(directory);
      if (backend === NATIVE_BACKEND_DEEPSEEK) return deepseek.commands(sessionId, directory);
      if (backend === NATIVE_BACKEND_CODEX) return codexCommands.list(directory);
      const cached = claudeCommands.get(directory);
      if (cached && now() - cached.at < COMMANDS_CACHE_MS) return { commands: await cached.commands };
      const listing = { at: now(), commands: claudeLive.commands(directory) };
      claudeCommands.set(directory, listing);
      try {
        return { commands: await listing.commands };
      } catch (error) {
        if (claudeCommands.get(directory) === listing) claudeCommands.delete(directory);
        throw error;
      }
    },

    async codexCommand(input: ConversationCodexCommandInput): Promise<JsonObject> {
      let threadId: string | undefined;
      let directory = input.directory;
      if (input.sessionId) {
        const decoded = decode(input.sessionId);
        if (decoded.backend !== NATIVE_BACKEND_CODEX) throw invalidRequestError('A Codex command requires a Codex session');
        const session = await codex.getSession(input.sessionId, directory);
        if (!session) throw sessionNotFoundError(input.sessionId);
        directory = session.directory;
        threadId = decoded.threadId;
      }
      if (input.name === 'review') {
        planDecisions.cancel(input.sessionId);
        await commitCodexRevert(input.sessionId, directory);
        await codexLiveInstance.review({
          sessionId: input.sessionId,
          directory,
          target: input.target,
          config: { model: input.model, ...codexVariantSettings(input.variant), mode: 'default' },
        });
        return { kind: 'accepted' };
      }
      if (input.sessionId && input.name !== 'skills') await codexLiveInstance.loadSession(input.sessionId, directory);
      return { kind: 'output', ...await codexCommands.inspect({ ...input, directory, threadId }) };
    },

    deepseekCommand(input: ConversationDeepseekCommandInput): Promise<JsonObject> {
      if (decode(input.sessionId).backend !== NATIVE_BACKEND_DEEPSEEK) throw invalidRequestError('A DeepSeek Harness command requires its own session');
      return deepseek.executeCommand(input.sessionId, input.directory, input.line);
    },

    async abort(sessionId: string): Promise<boolean> {
      const preparation = antigravityPreparations.get(sessionId);
      preparation?.abort();
      let delegationError: unknown;
      let cancelledDelegation = false;
      try { cancelledDelegation = await delegation?.cancel((await registry.getSession(sessionId))?.conversationId ?? sessionId) ?? false; }
      catch (error) { delegationError = error; }
      const cancelledExecution = planExecution ? await planExecution.cancel(sessionId) : false;
      const cancelledPlan = planDecisions.cancel(sessionId);
      const cancelledAntigravity = await antigravityDecisions.cancel(sessionId);
      const aborted = await liveFor(sessionId).abort(sessionId);
      const stoppedBackground = !aborted && decode(sessionId).backend === NATIVE_BACKEND_CLAUDE && await claudeLive.stopBackgroundTasks(sessionId);
      if (delegationError) throw delegationError;
      return Boolean(preparation) || aborted || cancelledDelegation || cancelledExecution || cancelledPlan || cancelledAntigravity || stoppedBackground;
    },

    async updateSession(sessionId: string, directory: string, patch: ConversationSessionPatch): Promise<NativeSessionRecord | null> {
      await assertDelegationRoot(sessionId);
      const decoded = decodeOwnSession(sessionId);
      const { backend } = decoded;
      if (backend === NATIVE_BACKEND_DEEPSEEK) {
        if (patch.archived === true) await stopTurn(sessionId);
        if (patch.title !== undefined) await deepseek.rename(sessionId, directory, patch.title);
        if (patch.archived !== undefined) await deepseek.setArchived(sessionId, directory, patch.archived);
        if (patch.metadata !== undefined) {
          await deepseek.adopt(sessionId, directory);
          await registry.updateSession(sessionId, { metadata: withoutServerMetadata(patch.metadata) });
        }
        return publishSession(sessionId, directory);
      }
      if (backend === NATIVE_BACKEND_CODEX && (patch.title !== undefined || patch.archived !== undefined)) await codexTitles.cancel(sessionId);
      if (decoded.backend === NATIVE_BACKEND_ANTIGRAVITY) {
        const record = antigravity.childSession(sessionId) ?? await antigravity.getSession(sessionId, directory);
        if (!record) throw sessionNotFoundError(sessionId);
        if (record.parentID) throw invalidRequestError('Antigravity subagent sessions belong to their parent session');
        if (patch.archived === true) await stopTurn(sessionId);
        const createdAt = now();
        await registry.registerSession(sessionId, {
          backend: decoded.backend,
          nativeId: decoded.conversationId,
          directory,
          origin: 'adopted',
          createdAt,
          confirmedAt: createdAt,
        });
        if (patch.title !== undefined) await registry.updateSession(sessionId, { title: patch.title });
        if (patch.archived !== undefined) await registry.updateSession(sessionId, { archivedAt: patch.archived ? createdAt : null });
      } else {
        if (patch.archived === true) await stopTurn(sessionId);
        if (decoded.backend === NATIVE_BACKEND_CLAUDE) {
          const { sessionUuid } = decoded;
          const hasTranscript = await claude.hasTranscript(sessionUuid, directory);
          if (patch.title !== undefined) {
            if (hasTranscript) await claude.rename(sessionId, directory, patch.title);
            else await registry.updateSession(sessionId, { title: patch.title });
          }
          if (patch.archived !== undefined) {
            const createdAt = now();
            const adopted: RegistrySessionInput = { backend: decoded.backend, nativeId: sessionUuid, directory, origin: 'adopted', createdAt };
            if (hasTranscript) adopted.confirmedAt = createdAt;
            await registry.registerSession(sessionId, adopted);
            await registry.updateSession(sessionId, { archivedAt: patch.archived ? createdAt : null });
            for (const child of (await claude.loadHistory(sessionId, directory))?.childSessions ?? []) {
              publisher.session(directory, child, { created: false });
            }
          }
        } else {
          if (patch.title !== undefined) await codex.rename(sessionId, patch.title);
          if (patch.archived !== undefined) await codex.setArchived(sessionId, patch.archived);
        }
      }
      if (patch.metadata !== undefined) {
        await adoptSession(sessionId, directory);
        await registry.updateSession(sessionId, { metadata: withoutServerMetadata(patch.metadata) });
      }
      const session = await publishSession(sessionId, directory);
      if (!session) throw sessionNotFoundError(sessionId);
      return session;
    },

    async setSessionAssist(sessionId: string, directory: string, assist: ConversationSessionAssist): Promise<NativeSessionRecord> {
      await adoptSession(sessionId, directory);
      const stored: JsonObject = (await registry.getSession(sessionId))?.metadata ?? {};
      await registry.updateSession(sessionId, {
        metadata: { ...stored, openchamber: { ...storedOpenChamber(stored), assist } },
      });
      const session = await publishSession(sessionId, directory);
      if (!session) throw sessionNotFoundError(sessionId);
      return session;
    },

    async setSessionWork(sessionId: string, directory: string, work: ConversationSessionWork): Promise<NativeSessionRecord> {
      await adoptSession(sessionId, directory);
      const stored: JsonObject = (await registry.getSession(sessionId))?.metadata ?? {};
      await registry.updateSession(sessionId, {
        metadata: { ...stored, openchamber: { ...storedOpenChamber(stored), work } },
      });
      const session = await publishSession(sessionId, directory);
      if (!session) throw sessionNotFoundError(sessionId);
      return session;
    },

    async deleteSession(sessionId: string, directory: string, delegated = false): Promise<{ deleted: true }> {
      if (!delegated) await assertDelegationRoot(sessionId);
      await delegation?.assertDeletion(sessionId);
      const { backend } = decodeOwnSession(sessionId);
      if (backend === NATIVE_BACKEND_ANTIGRAVITY) throw antigravityUnsupported('deletion');
      if (backend === NATIVE_BACKEND_DEEPSEEK) return deepseek.deleteSession(sessionId, directory);
      if (backend === NATIVE_BACKEND_CODEX) await codexTitles.cancel(sessionId);
      const session = await storeFor(sessionId).getSession(sessionId, directory);
      if (!session) throw sessionNotFoundError(sessionId);
      await stopTurn(sessionId);
      await delegation?.removeChildren(sessionId);
      let children: NativeSessionRecord[] = [];
      if (backend === NATIVE_BACKEND_CLAUDE) {
        children = (await claude.loadHistory(sessionId, directory))?.childSessions ?? [];
        await claudeLive.closeSession(sessionId);
        await claude.deleteTranscript(sessionId, directory);
      } else {
        await codex.deleteThread(sessionId);
        codexLiveInstance.forget(sessionId);
      }
      await registry.removeSession(sessionId);
      checklists.forget(sessionId);
      const cleanup = await Promise.allSettled([sessionId, ...children.map((child) => child.id)].map((id) => interactions.forget(id)));
      for (const child of children) {
        checklists.forget(child.id);
        publisher.sessionDeleted(directory, child);
      }
      publisher.sessionDeleted(directory, session);
      if (cleanup.some((result) => result.status === 'rejected')) {
        throw new NativeAgentError('The native session was deleted, but its saved question choices could not be removed', {
          status: 500, code: 'NATIVE_INTERACTION_CLEANUP_FAILED',
        });
      }
      return { deleted: true };
    },

    async revert(
      sessionId: string,
      messageId: string,
      directory: string,
      { restoreFiles = true }: { restoreFiles?: boolean | undefined } = {},
    ): Promise<{ session: NativeSessionRecord } & RevertResult> {
      await assertDelegationRoot(sessionId);
      const { backend } = decode(sessionId);
      if (backend === NATIVE_BACKEND_ANTIGRAVITY) throw antigravityUnsupported('revert');
      if (backend === NATIVE_BACKEND_DEEPSEEK) return deepseek.revert(sessionId, messageId, directory, { restoreFiles });
      if (backend === NATIVE_BACKEND_CODEX) await codexTitles.cancel(sessionId);
      await stopTurn(sessionId);
      let revertInput: RevertTurnInput;
      if (backend === NATIVE_BACKEND_CLAUDE) {
        await settleClaudeRewind(sessionId, directory);
        const target = await claude.rewindTarget(sessionId, directory, messageId);
        if (target.resumeAt === null) throw revertFirstMessageError();
        revertInput = { sessionId, messageId, messageIds: target.messageIds, rewind: { resumeAt: target.resumeAt } };
      } else {
        const target = await codex.rewindTarget(sessionId, messageId);
        revertInput = { sessionId, messageId, messageIds: target.messageIds, rewind: { beforeTurnId: target.beforeTurnId } };
      }
      const { filesRestored, conversationOnly } = await reverts.revert({ ...revertInput, restoreFiles });
      const session = await publishSession(sessionId, directory);
      if (!session) throw sessionNotFoundError(sessionId);
      return { session, filesRestored, conversationOnly };
    },

    async unrevert(sessionId: string, directory: string): Promise<NativeSessionRecord> {
      const { backend } = decode(sessionId);
      if (backend === NATIVE_BACKEND_ANTIGRAVITY) throw antigravityUnsupported('unrevert');
      if (backend === NATIVE_BACKEND_DEEPSEEK) return deepseek.unrevert(sessionId, directory);
      planDecisions.cancel(sessionId);
      await reverts.unrevert(sessionId);
      const session = await publishSession(sessionId, directory);
      if (!session) throw sessionNotFoundError(sessionId);
      return session;
    },

    async fork(
      sessionId: string,
      messageId: string | null,
      directory: string,
      { beforePublish }: { beforePublish?: ((record: NativeSessionRecord) => Promise<void>) | undefined } = {},
    ): Promise<NativeSessionRecord> {
      await assertDelegationRoot(sessionId);
      const { backend } = decode(sessionId);
      if (backend === NATIVE_BACKEND_ANTIGRAVITY) throw antigravityUnsupported('fork');
      if (backend === NATIVE_BACKEND_DEEPSEEK) {
        const session = await deepseek.fork(sessionId, messageId, directory, { beforePublish });
        publisher.session(session.directory, session, { created: true });
        return decorate(session);
      }
      const sourceHistory = await (backend === NATIVE_BACKEND_CODEX ? codex : claude).loadHistory(sessionId, directory);
      const sourceRecords = sourceHistory?.records ?? [];
      const boundary = messageId === null ? sourceRecords.length : sourceRecords.findIndex((record) => record.info.id === messageId);
      if (boundary < 0) throw invalidRequestError(`Unknown fork message: ${messageId}`);
      const retained = new Set(sourceRecords.slice(0, boundary).flatMap((record) => record.parts.filter((part) => part.type === 'tool').map((part) => part.callID)));
      let forkedId: string;
      if (backend === NATIVE_BACKEND_CLAUDE) {
        const target = messageId === null ? { resumeAt: undefined } : await claude.rewindTarget(sessionId, directory, messageId);
        if (target.resumeAt === null) return createSession({ backend, directory }, { beforePublish });
        const nativeId = await claude.fork(sessionId, directory, target.resumeAt);
        forkedId = encodeClaudeSessionId(nativeId);
        const createdAt = now();
        await registry.registerSession(forkedId, { backend, nativeId, directory, origin: 'openchamber', createdAt, confirmedAt: createdAt });
      } else {
        const { beforeTurnId } = messageId === null ? { beforeTurnId: undefined } : await codex.rewindTarget(sessionId, messageId);
        const nativeId = await codex.fork(sessionId, directory, beforeTurnId);
        forkedId = encodeCodexSessionId(nativeId);
        codexLiveInstance.threadStarted(forkedId, directory);
        await registry.registerSession(forkedId, { backend, nativeId, directory, origin: 'openchamber', createdAt: now() });
      }
      const session = await storeFor(forkedId).getSession(forkedId, directory);
      if (!session) throw sessionNotFoundError(forkedId);
      await beforePublish?.(session);
      try { await interactions.fork(sessionId, forkedId, retained); }
      catch {
        publisher.session(directory, session, { created: true });
        throw new NativeAgentError(`Forked session ${forkedId} remains available, but its saved question choices could not be copied`, {
          status: 500, code: 'NATIVE_INTERACTION_FORK_INCOMPLETE',
        });
      }
      publisher.session(directory, session, { created: true });
      return session;
    },

    async loadMessages(sessionId: string, directory: string, { limit, before }: { limit: number; before?: string | undefined }) {
      const { backend } = decode(sessionId);
      if (backend === NATIVE_BACKEND_DEEPSEEK) {
        const page = await deepseek.loadMessages(sessionId, directory, { limit, before });
        const records = await interactions.attach(sessionId, page.records).catch(() => null);
        const result = { ...page, records: records ?? page.records, metadataComplete: page.metadataComplete !== false && records !== null };
        try {
          if (delegation) result.childSessions = [...result.childSessions, ...await delegation.children(sessionId)];
        } catch { result.metadataComplete = false; }
        return result;
      }
      const history = await ({ claude, codex, antigravity }[backend]).loadHistory(sessionId, directory);
      if (!history && !liveFor(sessionId).childSession(sessionId)) throw sessionNotFoundError(sessionId);
      const pending = await reverts.pending(sessionId);
      const originalRecords = overlay(untilRewound(history?.records ?? [], pending), liveFor(sessionId).liveRecords(sessionId));
      const decoratedRecords = await interactions.attach(sessionId, originalRecords).catch(() => null);
      const records = decoratedRecords ?? originalRecords;
      let end = records.length;
      if (before !== undefined) {
        end = records.findIndex((record) => record.info.id === before);
        if (end === -1) throw invalidRequestError(`Unknown message cursor: ${before}`);
      }
      const start = Math.max(0, end - limit);
      const cursorRecord = start > 0 ? records[start] : undefined;
      const result: ConversationNativeMessagePage = {
        records: records.slice(start, end),
        cursor: cursorRecord ? cursorRecord.info.id : null,
        complete: start === 0,
        childSessions: history?.childSessions ?? [],
      };
      if (history?.metadataComplete === false || decoratedRecords === null) result.metadataComplete = false;
      try {
        if (delegation) {
          const children = await delegation.children(sessionId);
          result.childSessions = [...result.childSessions, ...children.filter((child) => !result.childSessions.some((held) => held.id === child.id))];
        }
      } catch { result.metadataComplete = false; }
      return result;
    },

    async sessionExists(sessionId: string, directory?: string): Promise<boolean> {
      return storeFor(sessionId).sessionExists(sessionId, directory);
    },

    async statuses(directory: string): Promise<Record<string, { type: string }>> {
      const busy = [
        ...claudeLive.busySessionIds(directory),
        ...codexLiveInstance.busySessionIds(directory),
        ...deepseek.busySessionIds(directory),
        ...antigravity.busySessionIds(directory),
      ];
      return Object.fromEntries(busy.map((sessionId) => [sessionId, { type: 'busy' }]));
    },

    async backgroundTasks() {
      return claudeLive.backgroundTaskSnapshot();
    },

    async checklist(sessionId: string, directory: string): Promise<NativeChecklistSnapshot> {
      const decoded = decode(sessionId);
      if (decoded.backend === NATIVE_BACKEND_ANTIGRAVITY) return antigravity.checklist(sessionId, directory);
      if (decoded.backend === NATIVE_BACKEND_DEEPSEEK) return deepseek.checklist(sessionId, directory);
      if (decoded.backend !== NATIVE_BACKEND_CLAUDE) return { state: 'unavailable', reason: 'unsupported' };
      const rootId = encodeClaudeSessionId(decoded.sessionUuid);
      const boundDirectory = checklists.directory(sessionId);
      if (boundDirectory && boundDirectory !== directory) throw invalidRequestError('Checklist directory does not match its session');
      const entry = await registry.getSession(rootId);
      if (entry && entry.directory !== directory) throw invalidRequestError('Checklist directory does not match its session');
      if (!checklists.source(sessionId)) {
        const saved = entry?.claudeChecklistSource;
        if (!saved) return { state: 'unavailable', reason: 'source_unknown' };
        const source = claudeChecklistSource({ env: { CLAUDE_CONFIG_DIR: saved.configDir, CLAUDE_CODE_TASK_LIST_ID: saved.listId }, sessionUuid: decoded.sessionUuid, directory });
        if (decoded.toolUseId) {
          checklists.bind(sessionId, directory, source
            ? { ...source, identity: `todo:${sessionId}`, todoOnly: true }
            : { identity: `todo:${sessionId}`, todoOnly: true });
        } else {
          checklists.bind(sessionId, directory, source);
        }
      }
      const source = checklists.source(sessionId);
      const sdkSource = claudeChecklistSource({ env: process.env, sessionUuid: decoded.sessionUuid, directory });
      const history = source?.configDir === sdkSource?.configDir
        ? async () => {
          const result = await claude.loadHistory(sessionId, directory);
          if (!result) throw sessionNotFoundError(sessionId);
          return result.records;
        } : undefined;
      return checklists.read(sessionId, history);
    },

    async plan(sessionId: string, directory: string): Promise<JsonObject> {
      const decoded = decode(sessionId);
      if (decoded.backend !== NATIVE_BACKEND_CODEX) return { state: 'unavailable', reason: 'unsupported' };
      const entry = await registry.getSession(encodeCodexSessionId(decoded.threadId));
      if (entry && entry.directory !== directory) throw invalidRequestError('Plan directory does not match its session');
      const plan = await codex.latestPlan(sessionId);
      if (!plan) return { state: 'empty' };
      return { state: 'ready', observedAt: now(), ...plan };
    },

    async codexTodos(sessionId: string, directory: string): Promise<JsonObject> {
      const decoded = decode(sessionId);
      if (decoded.backend !== NATIVE_BACKEND_CODEX) return { state: 'unsupported', generation: null, revision: 0, todos: [] };
      const entry = await registry.getSession(encodeCodexSessionId(decoded.threadId));
      if (entry && entry.directory !== directory) throw invalidRequestError('Todo directory does not match its session');
      return codexLiveInstance.todos(sessionId);
    },

    async sessionTasks(sessionId: string, directory: string): Promise<JsonObject> {
      const decoded = decode(sessionId);
      if (decoded.backend === NATIVE_BACKEND_ANTIGRAVITY) return antigravity.sessionTasks(sessionId, directory);
      if (decoded.backend !== NATIVE_BACKEND_CLAUDE || decoded.toolUseId) return { state: 'unsupported', generation: null, revision: 0, tasks: [], omitted: 0 };
      return claudeLive.sessionTasks(sessionId, directory);
    },

    async taskOutput(sessionId: string, directory: string, taskId: string, generation: string): Promise<JsonObject> {
      const decoded = decodeOwnSession(sessionId);
      if (decoded.backend === NATIVE_BACKEND_ANTIGRAVITY) return antigravity.taskOutput(sessionId, directory, taskId, generation);
      if (decoded.backend !== NATIVE_BACKEND_CLAUDE) return { state: 'unavailable', reason: 'not_recorded' };
      return claudeLive.taskOutput(sessionId, directory, taskId, generation);
    },

    async stopTask(sessionId: string, directory: string, taskId: string, generation: string): Promise<JsonObject> {
      const decoded = decodeOwnSession(sessionId);
      if (decoded.backend !== NATIVE_BACKEND_CLAUDE) throw new NativeAgentError('Task stopping is unsupported', { status: 501, code: 'NATIVE_TASK_STOP_UNAVAILABLE' });
      return claudeLive.stopTask(sessionId, directory, taskId, generation);
    },

    async questions(directory: string, sessionIds?: ReadonlySet<string>) {
      await antigravityDecisions.restore(directory, sessionIds);
      await planExecution?.restore(directory, sessionIds);
      return questions.list(directory).filter((question) => !sessionIds || sessionIds.has(question.sessionID));
    },

    hasPendingPlanDecision(sessionId: string): boolean {
      return registry.hasPendingPlanExecution(sessionId) || planDecisions.has(sessionId) || deepseek.hasPendingPlanDecision(sessionId)
        || (decode(sessionId).backend === NATIVE_BACKEND_ANTIGRAVITY && (antigravityDecisions.has(sessionId) || registry.hasPendingAntigravityInteraction(sessionId)));
    },

    replyQuestion(requestId: string, answers: string[][], execution?: PlanExecutionChoice) {
      return questions.reply(requestId, answers, execution);
    },

    rejectQuestion(requestId: string) {
      return questions.reject(requestId);
    },

    smallModels: {
      [NATIVE_PROVIDER_CODEX]: {
        transport: 'codex-app-server',
        available: codexUtility.available,
        describe: codexUtility.describe,
        generate: codexUtility.generate,
      },
      [NATIVE_PROVIDER_CLAUDE]: {
        transport: 'claude-agent-sdk',
        available: claudeUtility.available,
        describe: claudeUtility.describe,
        generate: claudeUtility.generate,
      },
    },

    async shutdown(): Promise<void> {
      for (const preparation of antigravityPreparations.values()) preparation.abort();
      await delegation?.shutdown();
      await planExecution?.shutdown();
      await antigravityDecisions.shutdown();
      const stoppingDeepseek = Promise.all([deepseekSetup.shutdown(), deepseek.shutdown(), deepseekMaintenance.shutdown()]);
      const stoppingAntigravity = antigravity.shutdown();
      try {
        planDecisions.clear();
        await codexTitles.stop();
        codexUtility.handleExit(new Error('Codex runtime is shutting down'));
        claudeUtility.shutdown();
        await claudeLive.shutdown();
        await appServer.stop();
      } finally {
        await Promise.all([stoppingDeepseek, stoppingAntigravity]);
      }
    },
  };

  delegation = createNativeDelegation({
    dataDir,
    registry,
    native: { ...native, prompt },
    createSession,
    adoptSession,
    stopChild: (id) => sourceLifecycle[decode(id).backend].stop(id),
    deleteCapability: async (backend) => {
      if (backend !== 'deepseek') return backend !== 'antigravity';
      const executable = await deepseekInstallation.resolve();
      return Boolean(executable && await deepseekPackage(executable) && await resolveExecutable('node') && deepseek.deletionSupport() !== false);
    },
    onActivity: (id) => conversations?.delegationActivity(id),
    resolveNode: () => resolveExecutable('node'),
    now,
  });

  const readPlanHistory = async (
    sessionId: string,
    directory: string,
    request: PlanReferenceRequest | null = null,
  ): Promise<NativeMessageRecord[]> => {
    const records: NativeMessageRecord[] = [];
    const cursors = new Set<string>();
    let before: string | undefined;
    do {
      const page = await native.loadMessages(sessionId, directory, { limit: 200, before });
      records.unshift(...page.records);
      if (page.metadataComplete === false || (page.complete === false && !page.cursor)) {
        throw new NativeAgentError('The native plan history is incomplete', { status: 502, code: 'NATIVE_CONVERSATION_HISTORY_UNAVAILABLE' });
      }
      if (request && page.records.some((record) => record.parts.some((part) => part.type === 'tool'
        && (request.tool ? part.callID === request.tool.callID : part.tool === 'plan_exit')))) break;
      before = page.cursor ?? undefined;
      if (before && cursors.has(before)) throw new NativeAgentError('Native plan history paging made no progress', { status: 502, code: 'NATIVE_CONVERSATION_HISTORY_UNAVAILABLE' });
      if (before) cursors.add(before);
    } while (before);
    return records;
  };

  planExecution = createNativePlanExecution({
    registry,
    questions,
    interactions,
    readHistory: readPlanHistory,
    sourceSelection: async (sessionId, directory) => {
      const latest = [...(await registry.sendRecords(sessionId)).values()].at(-1);
      const session = await native.getSession(sessionId, directory);
      return planExecutionChoiceSchema.parse({
        model: { providerID: latest?.providerID ?? session.model?.providerID, modelID: latest?.modelID ?? session.model?.id },
        variant: latest ? latest.variant : session.model?.variant,
      });
    },
    validate: async (sessionId, directory, requestId, execution, handoff, approves) => {
      const session = await native.getSession(sessionId, directory);
      if (session.parentID) throw invalidRequestError('Subagent plans use their parent execution model');
      const unified = conversations ? await conversations.validatePlanExecution(sessionId, directory, requestId, execution, handoff, approves) : false;
      const backend = nativeBackendOfProviderId(execution.model.providerID);
      if (!backend || (!unified && backend !== decode(sessionId).backend)) throw invalidRequestError('The execution model does not belong to this session');
      if (!handoff) return;
      const partition = (await native.catalog()).backends[backend];
      const models: ReadonlyArray<CatalogModelDescriptor> = partition?.status === 'ok' ? partition.models : [];
      const model = models.find((candidate) => candidate.id === execution.model.modelID || candidate.aliases?.some((alias) => alias.id === execution.model.modelID)) ?? null;
      if (!model) throw new NativeAgentError('The selected execution model is unavailable. Select another model and retry.', { status: 409, code: 'NATIVE_CONVERSATION_MODEL_UNAVAILABLE' });
      if (execution.variant && !nativeModelSupportsVariant(model, execution.variant)) throw invalidRequestError('The execution model does not support this thinking effort');
      if (!unified) {
        const tasks = await native.backgroundTasks();
        if (tasks[sessionId]?.tasks.length || questions.list(directory).some((question) => question.sessionID === sessionId && question.id !== requestId)) throw sessionBusyError();
        for (const [id, status] of Object.entries(await native.statuses(directory))) {
          if (id !== sessionId && status.type !== 'idle' && liveFor(id).childSession(id)?.parentID === sessionId) throw sessionBusyError();
        }
      }
    },
    yieldSource: async (sessionId, directory, signal) => {
      signal.throwIfAborted();
      const backend = decode(sessionId).backend;
      if (backend === NATIVE_BACKEND_DEEPSEEK) { await deepseek.stop(sessionId, directory); return; }
      const live = { claude: claudeLive, codex: codexLiveInstance, antigravity }[backend];
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          live.whenIdle(sessionId),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(sessionBusyError()), STOP_TIMEOUT_MS); }),
        ]);
      } finally { if (timer !== undefined) clearTimeout(timer); }
      signal.throwIfAborted();
      await sourceLifecycle[backend].retire(sessionId);
    },
    prompt: (sessionId, request, signal, approval) => {
      if (!conversations) return prompt(sessionId, request, signal);
      return conversations.automaticPrompt(sessionId, request, signal, approval);
    },
    confirm: async (sessionId, directory, state) => {
      const unified = conversations ? await conversations.planExecutionOutcome(sessionId, directory, state) : null;
      if (unified !== null) return unified;
      return (await readPlanHistory(sessionId, directory)).some((record) => record.info.role === 'user' && record.info.id === state.messageID) ? 'accepted' : 'unknown';
    },
    failed: (directory, sessionId, error) => publisher.error(directory, sessionId, unknownError(error instanceof Error ? error.message : 'Could not recover plan execution')),
  });

  conversations = createNativeConversations({
    dataDir,
    native,
    registry,
    reverts,
    publishNativeEvent,
    sourceLifecycle,
    smallModels: getSmallModelService,
    managedChatsRoots,
    now,
  });

  return conversations.api;
};

export type NativeAgentsRuntime = ReturnType<typeof createNativeAgentsRuntime>;
export type { ClaudeConnectionWriteInput, CodexConnectionWrite };
