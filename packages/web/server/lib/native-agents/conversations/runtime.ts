import path from 'node:path';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

import { isSpaceDirectory } from '../../spaces/dispatcher.js';
import { isEnterpriseMode } from '../../enterprise-mode.js';
import { isRecord, isString } from '../../shared/guards.js';
import type { JsonObject, JsonValue } from '../../shared/json-values.js';
import { NativeAgentError, invalidRequestError, sessionBusyError } from '../errors.js';
import {
  NATIVE_BACKEND_ANTIGRAVITY,
  NATIVE_BACKEND_CLAUDE,
  NATIVE_BACKEND_CODEX,
  NATIVE_BACKEND_DEEPSEEK,
  NATIVE_BACKENDS,
  NATIVE_PROVIDER_ANTIGRAVITY,
  NATIVE_PROVIDER_CLAUDE,
  NATIVE_PROVIDER_CODEX,
  NATIVE_PROVIDER_DEEPSEEK,
  nativeBackendSchema,
  nativeBackendOfProviderId,
  newNativeClientUserMessageId,
  isUnifiedNativeSessionId as isConversationId,
} from '../ids.js';
import type { NativeBackend, NativeProviderId } from '../ids.js';
import { JsonRpcError } from '../codex/rpc.js';
import { createConversationStore, conversationSelectionSchema } from './store.js';
import type {
  ConversationCreateInput,
  ConversationManifest,
  ConversationRollback,
  ConversationSegment,
  ConversationSelection,
} from './store.js';
import {
  conversationMessageId,
  conversationPartId,
  projectConversationRecord,
  projectConversationPart,
  readConversationHistory,
  readConversationSegment,
  readConversationPage,
  conversationPrefix,
} from './history.js';
import type { ConversationHistory, ConversationNativeMessagePage, ConversationPage } from './history.js';
import { prepareConversationContext } from './context.js';
import type { ContextCatalogModel, ContextSmallModelService } from './context.js';
import { agentConfigurationWriteSchema } from '../agent-configuration.js';
import type { AgentConfigurationWrite, AgentModel } from '../agent-configuration.js';
import { conversationTitlePreview, createConversationAutoTitles } from './auto-title.js';
import type { AutoTitleSmallModelService } from './auto-title.js';
import { antigravityChecklistSnapshot } from '../antigravity/checklist.js';
import type { NativeChecklistSnapshot, NativePublishedEvent } from '../publisher.js';
import type { PromptPart } from '../prompt-parts.js';
import type { PlanExecutionActiveState, PlanExecutionChoice, PlanExecutionResult } from '../plan-execution.js';
import type { QuestionRequest } from '../questions.js';
import type { NativeMessageInfo, NativePart, NativeSessionRecord } from '../records.js';
import type { NativeRegistry } from '../registry.js';
import type { NativeReverts, RevertResult } from '../revert.js';

const namespaceSchema = z.record(z.string(), z.json()).catch({});
const telemetryCorrection = z.object({
  messageID: z.string().min(1),
  patch: z.object({ telemetry: z.object({ toolWaitDurationMs: z.number().nonnegative() }).strict() }).strict(),
});
const lifecycleSchema = z.record(nativeBackendSchema, z.object({
  stop: z.function(),
  retire: z.function(),
  delete: z.boolean(),
  compact: z.boolean(),
  rewind: z.boolean(),
}));

const PROVIDER_BACKENDS = {
  [NATIVE_PROVIDER_CLAUDE]: NATIVE_BACKEND_CLAUDE,
  [NATIVE_PROVIDER_CODEX]: NATIVE_BACKEND_CODEX,
  [NATIVE_PROVIDER_DEEPSEEK]: NATIVE_BACKEND_DEEPSEEK,
  [NATIVE_PROVIDER_ANTIGRAVITY]: NATIVE_BACKEND_ANTIGRAVITY,
} satisfies Record<NativeProviderId, NativeBackend>;

const unsupportedRewind = (cause: unknown): boolean => cause instanceof NativeAgentError && [
  'NATIVE_REVERT_FIRST_MESSAGE', 'NATIVE_REVERT_MID_TURN', 'NATIVE_REWIND_BEFORE_COMPACTION',
].includes(cause.code);

const selectionOf = (request: { model: { providerID: string; modelID: string }; agent: 'build' | 'plan'; variant?: string | undefined }): ConversationSelection => (
  conversationSelectionSchema.parse({ model: request.model, agent: request.agent, variant: request.variant })
);

const checklistIdentity = (manifest: ConversationManifest, segment: ConversationSegment): string => (
  `antigravity:${manifest.id}:${segment.id}:${manifest.cut ?? 'full'}`
);

function requireHostDirectory(directory: string) {
  if (isSpaceDirectory(directory)) throw new NativeAgentError('Native CLI sessions are unavailable in isolated spaces', {
    code: 'NATIVE_SPACE_UNSUPPORTED', status: 409,
  });
}

const directoryKey = (directory: string): string => {
  try { return fs.realpathSync.native(directory); }
  catch { return path.resolve(directory); }
};

const enterpriseError = (): NativeAgentError => new NativeAgentError('Unified native conversations are unavailable in enterprise mode.', {
  status: 403, code: 'enterprise_mode',
});

const unknownAdmission = (): NativeAgentError => new NativeAgentError('The previous send is unconfirmed. Reload its history before sending again.', {
  status: 409, code: 'NATIVE_PROMPT_OUTCOME_UNKNOWN',
});

const definiteRefusal = (cause: unknown): boolean => cause instanceof JsonRpcError
  ? cause.kind === 'response'
  : cause instanceof NativeAgentError && !cause.code.endsWith('_UNKNOWN');

const isNativePartValue = (value: unknown): value is NativePart => isRecord(value) && isString(value.id) && isString(value.messageID) && isString(value.type);
const isNativeMessageInfoValue = (value: unknown): value is NativeMessageInfo => isRecord(value) && isString(value.id) && isString(value.role) && isRecord(value.time);
const isToolRef = (value: unknown): value is { messageID: string; callID: string } => isRecord(value) && isString(value.messageID) && isString(value.callID);

export interface ConversationSourceLifecycle {
  stop: (sessionId: string) => Promise<boolean | void>;
  retire: (sessionId: string) => Promise<void>;
  delete: boolean;
  compact: boolean;
  rewind: boolean;
}

export interface ConversationPromptRequest {
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

export interface ConversationApprovalHook {
  requestId?: string | undefined;
  logicalMessageId?: string | undefined;
  expectedRevision?: number | undefined;
  allowedForeground?: string | undefined;
  onDispatched?: (() => Promise<void>) | undefined;
  onRefused?: (() => Promise<void>) | undefined;
}

export interface ConversationCreateSessionInput {
  backend: NativeBackend;
  directory: string;
  title?: string | undefined;
  kind?: 'single' | 'unified' | undefined;
  selection?: ConversationSelection | undefined;
  configuration?: AgentConfigurationWrite | undefined;
}

export interface ConversationSessionPatch {
  title?: string | undefined;
  archived?: boolean | undefined;
  metadata?: JsonObject | undefined;
}

export interface ConversationCompactRequest {
  directory: string;
  model: { providerID: string; modelID: string };
  variant?: string | undefined;
  agent: 'build' | 'plan';
  instructions?: string | undefined;
}

export type ConversationCodexCommandInput =
  | { name: 'skills'; directory: string; sessionId?: string | undefined }
  | { name: 'mcp'; directory: string; sessionId: string; verbose?: boolean | undefined }
  | { name: 'ps' | 'stop'; directory: string; sessionId: string }
  | {
    name: 'review';
    directory: string;
    sessionId: string;
    model: string;
    variant?: string | undefined;
    target:
      | { type: 'uncommittedChanges' }
      | { type: 'baseBranch'; branch: string }
      | { type: 'commit'; sha: string }
      | { type: 'custom'; instructions: string };
  };

export interface ConversationDeepseekCommandInput {
  sessionId: string;
  directory: string;
  line: string;
}

export type ConversationSessionAssist = null | {
  recap: string;
  suggestion: string;
  forMessageID: string;
  generatedAt: number;
};

export type ConversationSessionWork = {
  state: 'open' | 'done';
  openedAt?: number | undefined;
  openedBy?: 'auto' | 'jev' | 'user' | undefined;
  doneAt?: number | undefined;
  suggestDoneAt?: number | undefined;
};

export interface ConversationCatalogBackend {
  status: string;
  models?: ReadonlyArray<ContextCatalogModel> | undefined;
  message?: string | undefined;
  reason?: string | undefined;
}

export interface ConversationSessionListBackend {
  status: string;
  sessions?: NativeSessionRecord[] | undefined;
  message?: string | undefined;
  reason?: string | undefined;
}

export interface ConversationNativeRuntime {
  canDeleteDelegations?: ((id: string) => boolean) | undefined;
  canDeleteSource?: ((backend: NativeBackend) => boolean) | undefined;
  hasActiveDelegations?: ((id: string) => boolean) | undefined;
  hasPendingDelegationTool?: ((id: string) => boolean | Promise<boolean>) | undefined;
  cancelDelegations?: ((id: string) => Promise<boolean>) | undefined;
  assertDelegatedDeletion?: ((id: string) => Promise<void>) | undefined;
  removeDelegatedChildren?: ((id: string, retained?: ReadonlySet<string>) => Promise<void>) | undefined;
  delegatedChildren?: ((parentID: string) => Promise<NativeSessionRecord[]>) | undefined;
  validateAgentConfiguration: (configuration: AgentConfigurationWrite, main?: ConversationSelection | null) => Promise<AgentConfigurationWrite>;
  configureAgents: (
    sessionId: string,
    directory: string,
    configuration: AgentConfigurationWrite,
    expectedRevision: number,
    main?: ConversationSelection | undefined,
  ) => Promise<NativeSessionRecord | null>;
  capabilities: () => Promise<{ supported: boolean; backends: Record<string, JsonValue | undefined>; [key: string]: JsonValue | undefined }>;
  catalog: () => Promise<{ backends: Record<string, ConversationCatalogBackend> }>;
  createSession: (
    input: { backend: NativeBackend; directory: string; title?: string | undefined },
    options?: {
      beforePublish?: ((record: NativeSessionRecord) => Promise<void>) | undefined;
      toolLaunch?: { subagentModel?: AgentModel | null | undefined; child?: boolean | undefined } | undefined;
    },
  ) => Promise<NativeSessionRecord>;
  listSessions: (directory: string) => Promise<{ backends: Record<string, ConversationSessionListBackend> }>;
  managedChatDirectories: () => Promise<string[]>;
  getSession: (sessionId: string, directory: string) => Promise<NativeSessionRecord>;
  sessionExists: (sessionId: string, directory?: string) => Promise<boolean>;
  prompt: (sessionId: string, request: ConversationPromptRequest, signal?: AbortSignal) => Promise<void>;
  loadMessages: (
    sessionId: string,
    directory: string,
    page: { limit: number; before?: string | undefined },
  ) => Promise<ConversationNativeMessagePage>;
  statuses: (directory: string) => Promise<Record<string, { type: string }>>;
  backgroundTasks: () => Promise<Record<string, { tasks: Array<{ id: string; type: string; description: string }> }>>;
  questions: (directory: string, sessionIds?: ReadonlySet<string>) => Promise<QuestionRequest[]>;
  replyQuestion: (requestId: string, answers: string[][], execution?: PlanExecutionChoice) => Promise<PlanExecutionResult | void> | void;
  rejectQuestion: (requestId: string) => Promise<PlanExecutionResult | void> | void;
  abort: (sessionId: string) => Promise<boolean>;
  updateSession: (sessionId: string, directory: string, patch: ConversationSessionPatch) => Promise<NativeSessionRecord | null>;
  revert: (
    sessionId: string,
    messageId: string,
    directory: string,
    options?: { restoreFiles?: boolean | undefined },
  ) => Promise<{ session: NativeSessionRecord } & RevertResult>;
  unrevert: (sessionId: string, directory: string) => Promise<NativeSessionRecord>;
  fork: (
    sessionId: string,
    messageId: string | null,
    directory: string,
    options?: { beforePublish?: ((record: NativeSessionRecord) => Promise<void>) | undefined },
  ) => Promise<NativeSessionRecord>;
  deleteSession: (sessionId: string, directory: string, delegated?: boolean) => Promise<{ deleted: true }>;
  compact: (sessionId: string, request: ConversationCompactRequest) => Promise<void>;
  commands: (backend: NativeBackend, directory: string, sessionId?: string) => Promise<{ commands: Array<{ name: string; description: string; argumentHint?: string | undefined }> }>;
  codexCommand: (input: ConversationCodexCommandInput) => Promise<JsonObject>;
  deepseekCommand: (input: ConversationDeepseekCommandInput) => Promise<JsonObject>;
  hasPendingPlanDecision: (sessionId: string) => boolean;
  setSessionAssist: (sessionId: string, directory: string, assist: ConversationSessionAssist) => Promise<NativeSessionRecord>;
  setSessionWork: (sessionId: string, directory: string, work: ConversationSessionWork) => Promise<NativeSessionRecord>;
  checklist: (sessionId: string, directory: string) => Promise<NativeChecklistSnapshot>;
  plan: (sessionId: string, directory: string) => Promise<JsonObject>;
  codexTodos: (sessionId: string, directory: string) => Promise<JsonObject>;
  sessionTasks: (sessionId: string, directory: string) => Promise<JsonObject>;
  taskOutput: (sessionId: string, directory: string, taskId: string, generation: string) => Promise<JsonObject>;
  stopTask: (sessionId: string, directory: string, taskId: string, generation: string) => Promise<JsonObject>;
  shutdown: () => Promise<void>;
}

export interface NativeConversationsOptions<Native extends ConversationNativeRuntime> {
  dataDir: string;
  native: Native;
  registry: Pick<NativeRegistry, 'listSessions' | 'updateSession' | 'dropTurns' | 'removeSession'>;
  reverts: NativeReverts;
  publishNativeEvent: (event: NativePublishedEvent) => void;
  sourceLifecycle: Record<NativeBackend, ConversationSourceLifecycle>;
  smallModels: () => Promise<ContextSmallModelService & AutoTitleSmallModelService>;
  managedChatsRoots: ReadonlyArray<string>;
  now?: (() => number) | undefined;
}

export type NativeConversationsApi<Native extends ConversationNativeRuntime> = Omit<
  Native,
  | 'capabilities'
  | 'createSession'
  | 'configureAgents'
  | 'listSessions'
  | 'loadMessages'
  | 'abort'
> & {
  capabilities: () => Promise<Awaited<ReturnType<ConversationNativeRuntime['capabilities']>> & { unifiedSessions: boolean; unifiedBackends: readonly NativeBackend[] }>;
  createSession: (input: ConversationCreateSessionInput) => Promise<NativeSessionRecord>;
  selectModel: (id: string, directory: string, selection: ConversationSelection, expectedRevision: number) => Promise<NativeSessionRecord>;
  configureAgents: (
    id: string,
    directory: string,
    configuration: AgentConfigurationWrite,
    expectedRevision: number,
    main?: ConversationSelection | undefined,
    expectedSelectionRevision?: number | undefined,
  ) => Promise<NativeSessionRecord | null>;
  listSessions: (directory: string) => Promise<Awaited<ReturnType<ConversationNativeRuntime['listSessions']>> & {
    unified: { status: 'ok'; sessions: NativeSessionRecord[]; unavailable: string[] };
  }>;
  loadMessages: (
    id: string,
    directory: string,
    page: { limit: number; before?: string | undefined },
  ) => Promise<ConversationNativeMessagePage | ConversationPage>;
  abort: (id: string, options?: { expectedSourceSessionId?: string | undefined }) => Promise<boolean>;
};

export interface NativeConversationsController<Native extends ConversationNativeRuntime> {
  api: NativeConversationsApi<Native>;
  delegationActivity: (id: string) => void;
  validatePlanExecution: (
    source: string,
    directory: string,
    requestId: string,
    execution: PlanExecutionChoice,
    handoff: boolean,
    approves?: boolean,
  ) => Promise<boolean>;
  planExecutionOutcome: (
    source: string,
    directory: string,
    state: PlanExecutionActiveState,
  ) => Promise<'accepted' | 'not-dispatched' | 'unknown' | null>;
  automaticPrompt: (
    source: string,
    request: ConversationPromptRequest,
    signal?: AbortSignal,
    approval?: ConversationApprovalHook | null,
  ) => Promise<void>;
  publishInteraction: (source: string, part: NativePart) => boolean;
  publish: (event: NativePublishedEvent) => void;
}

export const createNativeConversations = <Native extends ConversationNativeRuntime>({
  dataDir,
  native,
  registry,
  reverts,
  publishNativeEvent,
  sourceLifecycle,
  smallModels,
  managedChatsRoots,
  now = Date.now,
}: NativeConversationsOptions<Native>) => {
  for (const backend of NATIVE_BACKENDS) {
    if (!sourceLifecycle[backend]) throw new Error(`Native backend ${backend} needs unified conversation lifecycle support`);
  }
  lifecycleSchema.parse(sourceLifecycle);
  const lifecycles = sourceLifecycle;
  const store = createConversationStore({ directory: path.join(dataDir, 'native-agents', 'conversations'), now });
  const owned = new Set<string>();
  const undeletableOwners = new Set<string>();
  const owners = new Map<string, { id: string; segmentId: string }>();
  const childRoots = new Map<string, string>();
  const foreground = new Set<string>();
  const background = new Map<string, ReadonlyArray<{ id: string; type: string; description: string }>>();
  const waiting = new Map<string, Set<string>>();
  const questionOwners = new Map<string, { id: string; selection: ConversationSelection; plan: boolean }>();
  const preparing = new Map<string, AbortController>();
  const handoffs = new Set<string>();
  const operations = new Map<string, Promise<void>>();
  const clocks = new Map<string, number>();
  const sourcePrefixes = new Map<string, { from: string | undefined; ids: Set<string> }>();
  const recoveryFailures = new Set<string>();
  let ready: Promise<void> | undefined;
  let sequence = 0;
  let stopping = false;

  const referencedSegments = (manifest: ConversationManifest): ConversationSegment[] => [
    ...manifest.segments,
    ...(manifest.admission?.rollback.segments ?? []),
  ];

  const index = (manifest: ConversationManifest): void => {
    for (const segment of referencedSegments(manifest)) {
      owned.add(segment.sessionId);
      owners.set(segment.sessionId, { id: segment.ownerId, segmentId: segment.id });
    }
  };

  const restoreRollback = (current: ConversationManifest, rollback: ConversationRollback): void => {
    current.segments = rollback.segments;
    current.active = rollback.active;
    if (rollback.cut !== undefined) current.cut = rollback.cut;
    else delete current.cut;
    if (rollback.checkpoint !== undefined) current.checkpoint = rollback.checkpoint;
    else delete current.checkpoint;
  };

  const buildRollback = (manifest: ConversationManifest): ConversationRollback => {
    const rollback: ConversationRollback = {
      segments: structuredClone(manifest.segments),
      active: manifest.active,
    };
    if (manifest.cut !== undefined) rollback.cut = manifest.cut;
    if (manifest.checkpoint !== undefined) rollback.checkpoint = manifest.checkpoint;
    return rollback;
  };

  const update = async (id: string, change: (current: ConversationManifest) => ConversationManifest): Promise<ConversationManifest> => {
    const manifest = await store.update(id, change);
    index(manifest);
    return manifest;
  };

  const restorePreparation = async (manifest: ConversationManifest): Promise<ConversationManifest> => {
    const admission = manifest.admission;
    if (!admission || admission.phase !== 'preparing') return manifest;
    if (admission.rewindSource) await native.unrevert(admission.rewindSource, manifest.directory);
    await reverts.cancelCommit(manifest.id);
    const restored = await update(manifest.id, (current) => {
      restoreRollback(current, admission.rollback);
      current.historyRevision += 1;
      delete current.admission;
      return current;
    });
    await registry.dropTurns(manifest.id, [admission.messageId]);
    return restored;
  };

  const load = (): Promise<void> => {
    ready ??= (async () => {
      await store.load();
      for (const entry of await registry.listSessions()) if (entry.conversationId) {
        owned.add(entry.sessionId);
        if (!lifecycles[entry.backend].delete) undeletableOwners.add(entry.conversationId);
      }
      for (const manifest of store.list()) index(manifest);
      for (const manifest of store.list()) if (manifest.admission?.phase === 'preparing') {
        try { await restorePreparation(manifest); }
        catch { recoveryFailures.add(manifest.id); }
      }
    })().catch((error) => { ready = undefined; throw error; });
    return ready;
  };

  const checkPolicy = (): void => { if (isEnterpriseMode()) throw enterpriseError(); };

  const retryUnavailable = async (): Promise<void> => {
    for (const manifest of await store.retryUnavailable()) {
      index(manifest);
      if (manifest.admission?.phase === 'preparing' && !preparing.has(manifest.id)) recoveryFailures.add(manifest.id);
    }
    for (const id of [...recoveryFailures]) {
      try { await restorePreparation(store.get(id)); recoveryFailures.delete(id); }
      catch { continue; }
    }
  };

  const get = (id: string, directory?: string): ConversationManifest => {
    if (recoveryFailures.has(id)) throw new NativeAgentError('The conversation recovery could not be saved. Reload and retry.', {
      status: 500, code: 'NATIVE_CONVERSATION_STORAGE_UNAVAILABLE',
    });
    const manifest = store.get(id);
    if (directory && directoryKey(directory) !== directoryKey(manifest.directory)) throw invalidRequestError('The conversation belongs to another directory');
    return manifest;
  };

  const activeOf = (manifest: ConversationManifest): ConversationSegment | undefined => (
    manifest.segments.find((segment) => segment.id === manifest.active)
  );

  const sourceRoot = (id: string): string => childRoots.get(id) ?? id;

  const hasLiveWork = (manifest: ConversationManifest, allowedForeground: string | null = null): boolean => {
    if (native.hasActiveDelegations?.(manifest.id)) return true;
    const active = activeOf(manifest);
    if (!active) return false;
    if ((active.sessionId !== allowedForeground && foreground.has(active.sessionId)) || (background.get(active.sessionId)?.length ?? 0) > 0) return true;
    for (const child of childRoots.keys()) if (sourceRoot(child) === active.sessionId
      && (foreground.has(child) || (background.get(child)?.length ?? 0) > 0 || (waiting.get(child)?.size ?? 0) > 0)) return true;
    return false;
  };

  const blocked = (manifest: ConversationManifest, approval: ConversationApprovalHook | null = null): boolean => {
    if (hasLiveWork(manifest, approval?.allowedForeground ?? null)) return true;
    const activeSessionId = activeOf(manifest)?.sessionId;
    const requests = activeSessionId ? waiting.get(activeSessionId) : undefined;
    if (!approval) return Boolean(requests?.size);
    for (const id of requests ?? []) if (id !== approval.requestId) return true;
    return false;
  };

  const canDelete = (manifest: ConversationManifest): boolean => (
    (!native.canDeleteDelegations || native.canDeleteDelegations(manifest.id))
    && !undeletableOwners.has(manifest.id)
    && referencedSegments(manifest).every((segment) => lifecycles[segment.backend].delete && (!native.canDeleteSource || native.canDeleteSource(segment.backend)))
  );

  const recordOf = (manifest: ConversationManifest): NativeSessionRecord => {
    const active = activeOf(manifest);
    const backend = active?.backend ?? PROVIDER_BACKENDS[manifest.selection.model.providerID];
    const namespace = namespaceSchema.parse(manifest.metadata.openchamber);
    const model: NonNullable<NativeSessionRecord['model']> = manifest.selection.variant
      ? { providerID: manifest.selection.model.providerID, id: manifest.selection.model.modelID, variant: manifest.selection.variant }
      : { providerID: manifest.selection.model.providerID, id: manifest.selection.model.modelID };
    const time: NativeSessionRecord['time'] = manifest.archivedAt === undefined
      ? { created: manifest.createdAt, updated: manifest.updatedAt }
      : { created: manifest.createdAt, updated: manifest.updatedAt, archived: manifest.archivedAt };
    const nativeMeta: NativeSessionRecord['metadata']['openchamber']['native'] = {
      kind: 'unified',
      backend,
      unifiedBackends: [...NATIVE_BACKENDS],
      revision: manifest.selectionRevision,
      recordRevision: manifest.revision,
      historyRevision: manifest.historyRevision,
      sourceSessionID: active?.sessionId ?? null,
      switchReady: !blocked(manifest) && !preparing.has(manifest.id) && !manifest.admission && !manifest.deletion,
      preparing: handoffs.has(manifest.id),
      actions: { revert: !manifest.deletion, delete: canDelete(manifest), fork: !manifest.deletion, compact: lifecycles[backend].compact },
    };
    if (manifest.agents) nativeMeta.agents = manifest.agents;
    const record: NativeSessionRecord = {
      id: manifest.id,
      slug: manifest.id,
      projectID: '',
      directory: manifest.directory,
      title: manifest.title,
      version: 'unified-native',
      agent: manifest.selection.agent,
      model,
      time,
      metadata: {
        ...manifest.metadata,
        openchamber: { ...namespace, native: nativeMeta },
      },
    };
    if (manifest.parentID) record.parentID = manifest.parentID;
    if (manifest.cut) record.revert = { messageID: manifest.cut };
    return record;
  };

  const emit = (manifest: ConversationManifest, type: string, properties: JsonObject): void => publishNativeEvent({
    directory: manifest.directory,
    payload: { id: `ncvevt_${now()}_${++sequence}`, type, properties },
  });

  const publish = (manifest: ConversationManifest, created = false): NativeSessionRecord => {
    const info = recordOf(manifest);
    emit(manifest, created ? 'session.created' : 'session.updated', { info });
    return info;
  };

  const titles = createConversationAutoTitles({ store, native, smallModels, publish });

  const locked = <Result>(id: string, work: () => Promise<Result>): Promise<Result> => {
    const previous = operations.get(id) ?? Promise.resolve();
    const run = previous.then(async () => { await load(); return work(); });
    const settled = run.then(() => undefined, () => undefined);
    operations.set(id, settled);
    void settled.finally(() => { if (operations.get(id) === settled) operations.delete(id); });
    return run;
  };

  const assertStandalone = (id: string): void => {
    if (owned.has(id)) throw new NativeAgentError('This native session is managed by a unified conversation. Open that conversation to continue.', {
      status: 409, code: 'NATIVE_CONVERSATION_OWNS_SESSION',
    });
  };

  const refreshActivity = async (manifest: ConversationManifest): Promise<void> => {
    const active = activeOf(manifest);
    if (!active) return;
    const sessionIds = new Set([active.sessionId]);
    for (const [id, root] of childRoots) if (root === active.sessionId) sessionIds.add(id);
    const [statuses, tasks, questions] = await Promise.all([
      native.statuses(manifest.directory), native.backgroundTasks(), native.questions(manifest.directory, sessionIds),
    ]);
    for (const id of sessionIds) {
      const status = statuses[id];
      if (status && status.type !== 'idle') foreground.add(id);
      else foreground.delete(id);
      background.set(id, tasks[id]?.tasks ?? []);
      waiting.set(id, new Set(questions.filter((question) => question.sessionID === id).map((question) => question.id)));
    }
  };

  const assertQuiet = async (manifest: ConversationManifest, approval: ConversationApprovalHook | null = null): Promise<void> => {
    await refreshActivity(manifest);
    if (native.hasActiveDelegations?.(manifest.id)) throw sessionBusyError();
    const active = activeOf(manifest);
    if (approval && active && await native.hasPendingDelegationTool?.(active.sessionId)) throw sessionBusyError();
    if (blocked(manifest, approval)) throw sessionBusyError();
  };

  const observePrefix = (segment: ConversationSegment, ids: string[]): void => {
    sourcePrefixes.set(segment.sessionId, { from: segment.from, ids: new Set(ids) });
  };

  const includesSourceMessage = (segment: ConversationSegment, messageId: string | undefined): boolean => {
    if (!segment.from) return true;
    const prefix = sourcePrefixes.get(segment.sessionId);
    return prefix?.from === segment.from && Boolean(messageId) && !prefix.ids.has(messageId ?? '');
  };

  const historyOf = async (manifest: ConversationManifest): Promise<ConversationHistory> => {
    const history = await readConversationHistory(native, manifest, observePrefix);
    if (get(manifest.id).historyRevision !== manifest.historyRevision) throw new NativeAgentError('Conversation history changed. Reload and retry.', {
      status: 409, code: 'NATIVE_HISTORY_CHANGED',
    });
    return history;
  };

  const publishRetainedTelemetry = (
    owner: { id: string; segmentId: string },
    source: string,
    correction: z.infer<typeof telemetryCorrection>,
  ): Promise<void> => locked(owner.id, async () => {
    const manifest = get(owner.id);
    const segment = manifest.segments.find((entry) => entry.id === owner.segmentId && entry.sessionId === source);
    if (!segment) return;
    const history = await readConversationSegment(native, manifest, segment, observePrefix);
    const messageID = conversationMessageId(manifest.id, segment, correction.messageID);
    const ids = history.records.map((record) => conversationMessageId(manifest.id, segment, record.info.id));
    const index = ids.indexOf(messageID);
    let cut = ids.length;
    if (manifest.cut) {
      const localCut = ids.indexOf(manifest.cut);
      if (localCut >= 0) cut = localCut;
      else {
        const cutSegment = manifest.segments.findIndex((entry) => entry.sends.some((send) => (
          conversationMessageId(manifest.id, entry, send.nativeMessageId) === manifest.cut
        )));
        if (cutSegment <= manifest.segments.indexOf(segment)) return;
      }
    }
    if (index < 0 || index >= cut) return;
    emit(manifest, 'message.patched', { sessionID: manifest.id, messageID, patch: correction.patch });
  });

  const stop = async (manifest: ConversationManifest): Promise<boolean> => {
    let delegationError: unknown;
    try { await native.cancelDelegations?.(manifest.id); }
    catch (error) { delegationError = error; }
    preparing.get(manifest.id)?.abort(new Error('Conversation preparation stopped'));
    const active = activeOf(manifest);
    if (!active) { if (delegationError) throw delegationError; return false; }
    try { await lifecycles[active.backend].stop(active.sessionId); }
    catch (error) {
      if (error instanceof NativeAgentError && error.status === 404) return false;
      throw error;
    }
    for (const [child, root] of childRoots) if (root === active.sessionId && foreground.has(child)) await native.abort(child);
    await refreshActivity(manifest);
    if (delegationError) throw delegationError;
    if (blocked(manifest)) throw sessionBusyError();
    return true;
  };

  const recoverAdmission = async (manifest: ConversationManifest, messageId?: string): Promise<boolean> => {
    if (!manifest.admission) return false;
    if (manifest.admission.phase === 'preparing') {
      if (preparing.has(manifest.id)) throw unknownAdmission();
      await restorePreparation(manifest);
      return false;
    }
    const admission = manifest.admission;
    const segment = manifest.segments.find((entry) => entry.id === admission.segmentId);
    const send = segment?.sends.find((entry) => entry.messageId === admission.messageId);
    if (!segment || !send) throw unknownAdmission();
    const history = await readConversationSegment(native, manifest, segment, observePrefix);
    if (!history.records.some((record) => record.info.id === send.nativeMessageId)) throw unknownAdmission();
    await update(manifest.id, (current) => {
      const admitted = current.segments.find((entry) => entry.id === segment.id)?.sends.find((entry) => entry.messageId === send.messageId);
      if (admitted) admitted.state = 'accepted';
      delete current.admission;
      return current;
    });
    if (send.messageId === messageId) return true;
    return false;
  };

  const prompt = (
    id: string,
    request: ConversationPromptRequest,
    signal?: AbortSignal,
    automaticSource: string | null = null,
    automaticMessageId: string | null = null,
    approval: ConversationApprovalHook | null = null,
  ): Promise<void> => locked(id, async () => {
    checkPolicy();
    if (stopping) throw sessionBusyError();
    let manifest = get(id, request.directory);
    if (manifest.archivedAt !== undefined || manifest.deletion) throw invalidRequestError('Restore this conversation before sending');
    const fingerprint = createHash('sha256').update(JSON.stringify({
      parts: request.parts, model: request.model, variant: request.variant, agent: request.agent, instructions: request.instructions,
    })).digest('hex');
    let previousSend = manifest.segments.filter((segment) => segment.ownerId === id).flatMap((segment) => segment.sends).find((send) => send.messageId === request.messageID);
    let replacesRevertedSend = false;
    if (manifest.cut && previousSend) {
      const history = await historyOf(manifest);
      const cut = history.entries.findIndex((entry) => entry.record.info.id === manifest.cut);
      const previous = history.entries.findIndex((entry) => entry.record.info.id === request.messageID);
      if (cut === -1) throw invalidRequestError('Unknown conversation rewind point');
      if (previous >= cut) { previousSend = undefined; replacesRevertedSend = true; }
    }
    if (previousSend && previousSend.fingerprint !== fingerprint) throw new NativeAgentError('This message id already belongs to another send.', {
      status: 409, code: 'NATIVE_CONVERSATION_MESSAGE_CONFLICT',
    });
    if (await recoverAdmission(manifest, request.messageID)) return;
    manifest = get(id);
    const existing = replacesRevertedSend ? undefined : manifest.segments.filter((segment) => segment.ownerId === id).flatMap((segment) => segment.sends).find((send) => send.messageId === request.messageID);
    if (existing?.state === 'accepted') return;
    const target = selectionOf(request);
    const backend = PROVIDER_BACKENDS[target.model.providerID];
    const old = activeOf(manifest);
    if (automaticSource && (!old || old.sessionId !== automaticSource)) throw invalidRequestError('The original planning session is no longer active');
    if (approval?.expectedRevision !== undefined && manifest.selectionRevision !== approval.expectedRevision) throw new NativeAgentError('The conversation selection changed. Reload and retry.', {
      status: 409, code: 'NATIVE_CONVERSATION_SELECTION_CONFLICT',
    });
    const switching = !old || old.backend !== backend || manifest.cut !== undefined || old.ownerId !== id || old.through !== undefined;
    if (switching || approval) await assertQuiet(manifest, approval);
    if (!request.preserveSelection && !automaticSource && JSON.stringify(manifest.selection) !== JSON.stringify(target)) {
      manifest = await update(id, (current) => ({ ...current, selection: target, selectionRevision: current.selectionRevision + 1 }));
    }
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    preparing.set(id, controller);
    if (switching && manifest.segments.length > 0) handoffs.add(id);
    publish(manifest);
    const prior = buildRollback(manifest);
    let segment: ConversationSegment | undefined = old;
    let nativeMessageId: string | null = automaticSource && old?.backend !== backend ? null : automaticMessageId;
    let dispatched = false;
    let accepted = false;
    let reverting = false;
    let rewindSource: string | undefined;
    let createdSource = false;
    try {
      let instructions: string | undefined;
      if (switching) {
        const history = await historyOf(manifest);
        if (!history.metadataComplete) throw new NativeAgentError('Some conversation history is unavailable. Reload before preparing the handoff.', {
          status: 502, code: 'NATIVE_CONVERSATION_HISTORY_UNAVAILABLE',
        });
        const end = manifest.cut ? history.entries.findIndex((entry) => entry.record.info.id === manifest.cut) : history.entries.length;
        if (end === -1) throw invalidRequestError('Unknown conversation rewind point');
        const retained = manifest.cut ? conversationPrefix(manifest, history, manifest.cut) : structuredClone(manifest.segments);
        const boundary = manifest.cut ? history.entries[end] ?? null : null;
        const source = boundary ? manifest.segments.find((entry) => entry.id === boundary.segmentId) ?? null : null;
        let prepared = false;
        const bindSource = async (createdRecord: NativeSessionRecord, inherited = false): Promise<void> => {
          createdSource = true;
          owned.add(createdRecord.id);
          await registry.updateSession(createdRecord.id, { conversationId: id });
          if (!lifecycles[backend].delete) undeletableOwners.add(id);
          nativeMessageId = newNativeClientUserMessageId(createdRecord.id);
          const nextSegment: ConversationSegment = { id: randomUUID(), ownerId: id, sessionId: createdRecord.id, backend, createdAt: now(), sends: [] };
          if (inherited) nextSegment.from = nativeMessageId;
          nextSegment.sends.push({ messageId: request.messageID, nativeMessageId, createdAt: now(), state: 'pending', fingerprint, selection: target });
          segment = nextSegment;
          manifest = await update(id, (current) => {
            current.segments = [...retained, nextSegment];
            current.active = nextSegment.id;
            current.admission = { segmentId: nextSegment.id, messageId: request.messageID, phase: 'preparing', rollback: prior };
            if (current.cut) {
              current.historyRevision += 1;
              delete current.cut;
              delete current.checkpoint;
            }
            return current;
          });
        };
        if (source?.backend === backend && lifecycles[backend].rewind && boundary) {
          const exclusive = source.ownerId === id && store.unavailable().length === 0
            && manifest.segments.filter((entry) => entry.sessionId === source.sessionId).length === 1
            && !store.list().some((other) => other.id !== id && referencedSegments(other).some((entry) => entry.sessionId === source.sessionId));
          if (exclusive) {
            rewindSource = source.sessionId;
            manifest = await update(id, (current) => {
              current.admission = { segmentId: source.id, messageId: request.messageID, phase: 'preparing', rollback: prior, rewindSource };
              return current;
            });
            try {
              await native.revert(source.sessionId, boundary.nativeMessageId, manifest.directory, { restoreFiles: false });
              controller.signal.throwIfAborted();
              nativeMessageId = newNativeClientUserMessageId(source.sessionId);
              const prefix = retained.find((entry) => entry.id === source.id);
              const rewoundSegment: ConversationSegment = { ...(prefix ?? source), sends: [...(prefix?.sends ?? [])] };
              delete rewoundSegment.through;
              delete rewoundSegment.before;
              if (source.from && !prefix) rewoundSegment.from = nativeMessageId;
              rewoundSegment.sends.push({ messageId: request.messageID, nativeMessageId, createdAt: now(), state: 'pending', fingerprint, selection: target });
              segment = rewoundSegment;
              reverting = true;
              manifest = await update(id, (current) => {
                current.segments = [...retained.filter((entry) => entry.id !== source.id), rewoundSegment];
                current.active = rewoundSegment.id;
                current.historyRevision += 1;
                delete current.cut;
                delete current.checkpoint;
                return current;
              });
              prepared = true;
            } catch (error) {
              if (!unsupportedRewind(error)) throw error;
              await native.unrevert(source.sessionId, manifest.directory);
              rewindSource = undefined;
              manifest = await update(id, (current) => { delete current.admission; return current; });
            }
          }
          if (!prepared && (retained.some((entry) => entry.id === source.id) || retained.length === 0)) {
            try {
              if (old) await lifecycles[old.backend].retire(old.sessionId);
              await native.fork(source.sessionId, boundary.nativeMessageId, manifest.directory, {
                beforePublish: (fork) => bindSource(fork, true),
              });
              reverting = true;
              prepared = true;
            } catch (error) {
              if (!unsupportedRewind(error)) throw error;
            }
          }
        }
        if (!prepared) {
          const catalog = (await native.catalog()).backends[backend];
          if (catalog?.status !== 'ok' || !catalog.models) throw new NativeAgentError('The selected native model catalog is unavailable. Retry after reconnecting the backend.', {
            status: 503, code: 'NATIVE_CONVERSATION_MODEL_UNAVAILABLE',
          });
          instructions = await prepareConversationContext({
            manifest,
            entries: history.entries.slice(0, end),
            target,
            catalog: { models: catalog.models },
            smallModels,
            signal: controller.signal,
            saveCheckpoint: async (checkpoint) => { await update(id, (current) => ({ ...current, checkpoint })); },
          });
          controller.signal.throwIfAborted();
          if (old) await lifecycles[old.backend].retire(old.sessionId);
          if (manifest.cut) {
            reverting = true;
          }
          if (!manifest.cut && old) {
            const last = history.entries.findLast((entry) => entry.segmentId === old.id);
            const previous = retained.find((entry) => entry.id === old.id);
            if (last && previous) previous.through = last.nativeMessageId;
          }
          const createInput = manifest.manualTitle
            ? { backend, directory: manifest.directory, title: manifest.title }
            : { backend, directory: manifest.directory };
          await native.createSession(createInput, {
            toolLaunch: { subagentModel: request.subagentModel !== undefined ? request.subagentModel : manifest.agents?.subagent ?? null },
            beforePublish: bindSource,
          });
        }
      }
      controller.signal.throwIfAborted();
      if (!segment) throw new NativeAgentError('Conversation segment could not be prepared', { status: 500, code: 'NATIVE_CONVERSATION_STORAGE_UNAVAILABLE' });
      const activeSegment = segment;
      const finalNativeMessageId = nativeMessageId ?? newNativeClientUserMessageId(activeSegment.sessionId);
      nativeMessageId = finalNativeMessageId;
      manifest = await update(id, (current) => {
        const firstSegment = current.segments[0];
        if (!current.manualTitle && !current.generatedTitle && current.segments.length === 1
          && firstSegment && firstSegment.sends.every((send) => send.messageId === request.messageID)) {
          const preview = conversationTitlePreview(request.parts);
          if (preview) current.title = preview;
        }
        if (!switching) {
          const active = current.segments.find((entry) => entry.id === activeSegment.id);
          if (active) {
            if (active.from && active.sends.length === 0) active.from = finalNativeMessageId;
            active.sends.push({
              messageId: request.messageID, nativeMessageId: finalNativeMessageId, createdAt: now(), state: 'pending', fingerprint, selection: target,
            });
          }
        }
        current.admission = { segmentId: activeSegment.id, messageId: request.messageID, phase: 'preparing', rollback: prior };
        if (rewindSource) current.admission.rewindSource = rewindSource;
        return current;
      });
      const updatedSegment = manifest.segments.find((entry) => entry.id === activeSegment.id);
      if (!updatedSegment) throw new NativeAgentError('Conversation segment missing after update', { status: 500, code: 'NATIVE_CONVERSATION_STORAGE_UNAVAILABLE' });
      segment = updatedSegment;
      await reverts.beforePrompt(id, manifest.directory, request.messageID);
      controller.signal.throwIfAborted();
      if (reverting) await reverts.beginCommit(id);
      if (manifest.agents) await registry.updateSession(updatedSegment.sessionId, { agentConfiguration: manifest.agents });
      if (updatedSegment.from) await readConversationSegment(native, manifest, updatedSegment, observePrefix);
      await update(id, (current) => {
        if (current.admission) current.admission.phase = 'dispatched';
        return current;
      });
      controller.signal.throwIfAborted();
      await approval?.onDispatched?.();
      controller.signal.throwIfAborted();
      dispatched = true;
      await native.prompt(updatedSegment.sessionId, {
        ...request,
        directory: manifest.directory,
        messageID: finalNativeMessageId,
        instructions: [request.instructions, instructions].filter(Boolean).join('\n\n') || undefined,
      }, controller.signal);
      accepted = true;
      await update(id, (current) => {
        const targetSend = current.segments.find((entry) => entry.id === updatedSegment.id)?.sends.find((entry) => entry.messageId === request.messageID);
        if (targetSend) targetSend.state = 'accepted';
        delete current.admission;
        return current;
      });
      if (reverting) await reverts.finishCommit(id);
      if (!foreground.has(updatedSegment.sessionId)) void titles.generate(id);
    } catch (error) {
      const definitelyRefused = !accepted && (!dispatched || definiteRefusal(error));
      if (definitelyRefused) {
        let rewindCommitted = false;
        if (rewindSource && dispatched) {
          const original = prior.segments.find((entry) => entry.sessionId === rewindSource);
          if (original) {
            const fullOriginal = structuredClone(original);
            delete fullOriginal.from;
            delete fullOriginal.through;
            delete fullOriginal.before;
            const history = await readConversationSegment(native, manifest, fullOriginal);
            rewindCommitted = !history.records.some((record) => conversationMessageId(id, original, record.info.id) === prior.cut);
          }
        }
        if (rewindSource && !rewindCommitted) await native.unrevert(rewindSource, manifest.directory);
        const currentSegmentId = segment?.id;
        await update(id, (current) => {
          if (switching && !rewindCommitted) {
            restoreRollback(current, prior);
            if (reverting) current.historyRevision += 1;
          } else if (currentSegmentId) {
            const active = current.segments.find((entry) => entry.id === currentSegmentId);
            if (active) active.sends = active.sends.filter((entry) => entry.messageId !== request.messageID);
          }
          delete current.admission;
          return current;
        });
        if (reverting) {
          if (rewindCommitted) await reverts.finishCommit(id);
          else await reverts.cancelCommit(id);
        }
        await registry.dropTurns(id, [request.messageID]);
        if (createdSource && segment) {
          try {
            await lifecycles[segment.backend].retire(segment.sessionId);
            if (lifecycles[segment.backend].delete) {
              await native.deleteSession(segment.sessionId, manifest.directory);
              sourcePrefixes.delete(segment.sessionId);
            }
          } catch {
            void 0;
          }
        }
        await approval?.onRefused?.();
      } else {
        throw new NativeAgentError('The native send may have been accepted. Reload to confirm it before retrying.', {
          status: 502, code: 'NATIVE_PROMPT_OUTCOME_UNKNOWN',
        });
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      preparing.delete(id);
      handoffs.delete(id);
      publish(get(id));
    }
  });

  const sourceFor = async (id: string, directory: string): Promise<{ manifest: ConversationManifest; segment: ConversationSegment | undefined }> => {
    await load();
    const manifest = get(id, directory);
    const segment = activeOf(manifest);
    return { manifest, segment };
  };

  const { capabilities: readCapabilities, listSessions: listNativeSessions, ...nativeMethods } = native;
  const api = {
    ...nativeMethods,
    async capabilities() {
      await load();
      const capabilities = await readCapabilities.call(native);
      for (const backend of Object.keys(capabilities.backends)) {
        if (!Object.hasOwn(lifecycles, backend)) throw new Error(`Native backend ${backend} needs unified conversation lifecycle support`);
      }
      const enabled = !isEnterpriseMode();
      return { ...capabilities, unifiedSessions: enabled, unifiedBackends: enabled ? NATIVE_BACKENDS : [] };
    },
    async createSession(input: ConversationCreateSessionInput): Promise<NativeSessionRecord> {
      requireHostDirectory(input.directory);
      await load();
      if (input.kind !== 'unified') return native.createSession(input);
      checkPolicy();
      if (stopping) throw sessionBusyError();
      const selection = conversationSelectionSchema.parse(input.selection);
      const agents = input.configuration ? { ...await native.validateAgentConfiguration(input.configuration, selection), revision: 1 } : undefined;
      if (nativeBackendOfProviderId(selection.model.providerID) !== input.backend) throw invalidRequestError('The initial model does not match its native backend');
      const createInput: ConversationCreateInput = {
        directory: directoryKey(input.directory),
        selection,
        manualTitle: Boolean(input.title),
      };
      if (agents) createInput.agents = agents;
      if (input.title) createInput.title = input.title;
      return publish(await store.create(createInput), true);
    },
    async selectModel(id: string, directory: string, selection: ConversationSelection, expectedRevision: number): Promise<NativeSessionRecord> {
      await load();
      checkPolicy();
      get(id, directory);
      const next = conversationSelectionSchema.parse(selection);
      return publish(await update(id, (current) => {
        if (current.selectionRevision !== expectedRevision) throw new NativeAgentError('The conversation selection changed. Reload and retry.', {
          status: 409, code: 'NATIVE_CONVERSATION_SELECTION_CONFLICT',
        });
        current.selection = next;
        current.selectionRevision += 1;
        return current;
      }));
    },
    async configureAgents(
      id: string,
      directory: string,
      configuration: AgentConfigurationWrite,
      expectedRevision: number,
      main?: ConversationSelection | undefined,
      expectedSelectionRevision?: number | undefined,
    ): Promise<NativeSessionRecord | null> {
      await load();
      checkPolicy();
      if (!isConversationId(id)) { assertStandalone(id); return native.configureAgents(id, directory, configuration, expectedRevision, main); }
      get(id, directory);
      const parsed = agentConfigurationWriteSchema.parse(configuration);
      await native.validateAgentConfiguration(parsed, main);
      const selection = main ? conversationSelectionSchema.parse(main) : null;
      return publish(await update(id, (current) => {
        if ((current.agents?.revision ?? 0) !== expectedRevision || (selection && current.selectionRevision !== expectedSelectionRevision)) {
          throw new NativeAgentError('The conversation selection changed. Reload and retry.', { status: 409, code: 'NATIVE_CONVERSATION_SELECTION_CONFLICT' });
        }
        current.agents = { ...parsed, revision: expectedRevision + 1 };
        if (selection) { current.selection = selection; current.selectionRevision += 1; }
        return current;
      }));
    },
    async listSessions(directory: string) {
      await load();
      await retryUnavailable();
      const result = await listNativeSessions.call(native, directory);
      for (const partition of Object.values(result.backends)) {
        if (partition.status === 'ok' && partition.sessions) {
          partition.sessions = partition.sessions.filter((session) => !owned.has(session.id));
        }
      }
      return {
        ...result,
        unified: {
          status: 'ok' as const,
          sessions: store.list().filter((manifest) => !recoveryFailures.has(manifest.id) && directoryKey(manifest.directory) === directoryKey(directory)).map(recordOf),
          unavailable: [...store.unavailable(), ...recoveryFailures],
        },
      };
    },
    async managedChatDirectories(): Promise<string[]> {
      await load();
      const roots = new Set(managedChatsRoots.flatMap((root) => [path.resolve(root), directoryKey(root)]));
      const unified = store.list().filter((manifest) => [...roots].some((root) => manifest.directory.startsWith(`${root}${path.sep}`)));
      return [...new Set([...await native.managedChatDirectories(), ...unified.map((manifest) => manifest.directory)])];
    },
    async getSession(id: string, directory: string): Promise<NativeSessionRecord> {
      await load();
      if (!isConversationId(id)) return native.getSession(id, directory);
      if (store.unavailable().includes(id) || recoveryFailures.has(id)) await retryUnavailable();
      let manifest = get(id, directory);
      if (manifest.admission) {
        try { await recoverAdmission(manifest); manifest = get(id, directory); }
        catch (error) { if (!(error instanceof NativeAgentError) || error.code !== 'NATIVE_PROMPT_OUTCOME_UNKNOWN') throw error; }
      }
      await refreshActivity(manifest);
      return recordOf(manifest);
    },
    async sessionExists(id: string, directory?: string): Promise<boolean> {
      await load();
      if (!isConversationId(id)) return native.sessionExists(id, directory);
      if (store.unavailable().includes(id)) get(id, directory);
      if (!store.peek(id)) return false;
      get(id, directory);
      return true;
    },
    async prompt(id: string, request: ConversationPromptRequest, signal?: AbortSignal): Promise<void> {
      requireHostDirectory(request.directory);
      await load();
      if (isConversationId(id)) return prompt(id, request, signal);
      assertStandalone(id);
      return native.prompt(id, request, signal);
    },
    async loadMessages(id: string, directory: string, page: { limit: number; before?: string | undefined }): Promise<ConversationNativeMessagePage | ConversationPage> {
      await load();
      if (!isConversationId(id)) return native.loadMessages(id, directory, page);
      const manifest = get(id, directory);
      const result = await readConversationPage(native, manifest, page, observePrefix);
      if (native.delegatedChildren) {
        try {
          const children = await native.delegatedChildren(id);
          result.childSessions = [...result.childSessions, ...children.filter((child) => !result.childSessions.some((entry) => entry.id === child.id))];
        } catch { result.metadataComplete = false; }
      }
      if (get(id).historyRevision !== manifest.historyRevision) throw new NativeAgentError('Conversation history changed. Reload and retry.', { status: 409, code: 'NATIVE_HISTORY_CHANGED' });
      return result;
    },
    async statuses(directory: string): Promise<Record<string, { type: string }>> {
      await load();
      const statuses = await native.statuses(directory);
      const result: Record<string, { type: string }> = Object.fromEntries(Object.entries(statuses).filter(([id]) => !owned.has(id)));
      for (const manifest of store.list()) {
        if (directoryKey(manifest.directory) !== directoryKey(directory)) continue;
        const source = activeOf(manifest)?.sessionId;
        const sourceStatus = source ? statuses[source] : undefined;
        if (preparing.has(manifest.id) || sourceStatus) result[manifest.id] = sourceStatus ?? { type: 'busy' };
      }
      return result;
    },
    async backgroundTasks(): Promise<Record<string, { tasks: Array<{ id: string; type: string; description: string }> }>> {
      await load();
      const result: Record<string, { tasks: Array<{ id: string; type: string; description: string }> }> = {};
      for (const [id, tasks] of Object.entries(await native.backgroundTasks())) {
        const owner = owners.get(id);
        if (owner) result[owner.id] = tasks;
        else if (!owned.has(id)) result[id] = tasks;
      }
      return result;
    },
    async questions(directory: string): Promise<QuestionRequest[]> {
      await load();
      return (await native.questions(directory)).map((question) => {
        const owner = owners.get(question.sessionID);
        const manifest = owner ? store.peek(owner.id) : undefined;
        const segment = manifest?.segments.find((entry) => entry.id === owner?.segmentId);
        if (!manifest || !segment) return question;
        questionOwners.set(question.id, { id: manifest.id, selection: manifest.selection, plan: question.kind?.endsWith('-plan-exit') === true });
        if (question.tool) {
          return {
            ...question,
            sessionID: manifest.id,
            tool: { ...question.tool, messageID: conversationMessageId(manifest.id, segment, question.tool.messageID) },
          };
        }
        return { ...question, sessionID: manifest.id };
      }).filter((question) => !owned.has(question.sessionID));
    },
    async replyQuestion(requestId: string, answers: string[][], execution?: PlanExecutionChoice) {
      await load();
      const decision = questionOwners.get(requestId);
      const firstList = answers[0];
      const firstAnswer = firstList?.[0];
      const singleAnswer = answers.length === 1 && firstList?.length === 1;
      const approves = singleAnswer && firstAnswer === 'build';
      if (decision && !(decision.plan && singleAnswer && firstAnswer === 'plan')) checkPolicy();
      const result = await (execution ? native.replyQuestion(requestId, answers, execution) : native.replyQuestion(requestId, answers));
      if (decision?.plan && approves && store.peek(decision.id)) {
        const expected = JSON.stringify(decision.selection);
        publish(await update(decision.id, (current) => {
          const applied = result?.execution ?? execution;
          if (applied && current.selectionRevision === applied.expectedRevision) {
            current.selection = conversationSelectionSchema.parse({ model: applied.model, variant: applied.variant, agent: 'build' });
            current.selectionRevision += 1;
          } else if (!applied && JSON.stringify(current.selection) === expected && current.selection.agent !== 'build') {
            current.selection = { ...current.selection, agent: 'build' };
            current.selectionRevision += 1;
          }
          return current;
        }));
      }
      return result;
    },
    async abort(id: string, { expectedSourceSessionId }: { expectedSourceSessionId?: string | undefined } = {}): Promise<boolean> {
      await load();
      if (!isConversationId(id)) {
        if (expectedSourceSessionId !== undefined) throw invalidRequestError('A source-bound stop requires a unified conversation');
        assertStandalone(id);
        return native.abort(id);
      }
      if (expectedSourceSessionId !== undefined) return locked(id, async () => {
        const source = activeOf(get(id))?.sessionId;
        if (source !== expectedSourceSessionId) throw new NativeAgentError('The executing source changed before it could be stopped.', {
          status: 409, code: 'NATIVE_CONVERSATION_SOURCE_CHANGED',
        });
        return native.abort(source);
      });
      const controller = preparing.get(id);
      controller?.abort(new Error('Conversation preparation stopped'));
      const source = activeOf(get(id))?.sessionId;
      return source ? await native.abort(source) || Boolean(controller) : Boolean(controller);
    },
    async updateSession(id: string, directory: string, patch: ConversationSessionPatch): Promise<NativeSessionRecord | null> {
      await load();
      if (!isConversationId(id)) { assertStandalone(id); return native.updateSession(id, directory, patch); }
      if (patch.title !== undefined || patch.archived) titles.cancel(id);
      if (patch.archived) preparing.get(id)?.abort(new Error('Conversation archived'));
      return locked(id, async () => {
        const manifest = get(id, directory);
        if (patch.archived) await stop(manifest);
        return publish(await update(id, (current) => {
          if (patch.title !== undefined) { current.title = patch.title; current.manualTitle = true; }
          if (patch.archived === true) current.archivedAt = now();
          if (patch.archived === false) delete current.archivedAt;
          if (patch.metadata !== undefined) {
            const namespace = namespaceSchema.parse(patch.metadata.openchamber);
            delete namespace.native;
            current.metadata = { ...namespaceSchema.parse(patch.metadata), openchamber: namespace };
          }
          return current;
        }));
      });
    },
    async revert(id: string, messageId: string, directory: string): Promise<{ session: NativeSessionRecord } & RevertResult> {
      await load();
      if (!isConversationId(id)) { assertStandalone(id); return native.revert(id, messageId, directory); }
      titles.cancel(id);
      preparing.get(id)?.abort(new Error('Conversation rewound'));
      return locked(id, async () => {
        const manifest = get(id, directory);
        await stop(manifest);
        if (manifest.admission) await recoverAdmission(manifest);
        const history = await historyOf(manifest);
        const index = history.entries.findIndex((entry) => entry.record.info.id === messageId && entry.record.info.role === 'user');
        if (index === -1) throw invalidRequestError('Unknown conversation user message');
        const result = await reverts.revert({
          sessionId: id,
          messageId,
          messageIds: history.entries.slice(index).filter((entry) => entry.record.info.role === 'user').map((entry) => entry.record.info.id),
          rewind: {},
        });
        return { session: publish(await update(id, (current) => ({ ...current, cut: messageId }))), ...result };
      });
    },
    async unrevert(id: string, directory: string): Promise<NativeSessionRecord> {
      await load();
      if (!isConversationId(id)) { assertStandalone(id); return native.unrevert(id, directory); }
      return locked(id, async () => {
        get(id, directory);
        await reverts.unrevert(id);
        return publish(await update(id, (current) => { delete current.cut; return current; }));
      });
    },
    async fork(id: string, messageId: string | null, directory: string): Promise<NativeSessionRecord> {
      await load();
      if (!isConversationId(id)) return native.fork(id, messageId, directory);
      return locked(id, async () => {
        const manifest = get(id, directory);
        const history = await historyOf(manifest);
        const createInput: ConversationCreateInput = {
          directory: manifest.directory,
          title: `${manifest.title} (fork)`,
          selection: manifest.selection,
          segments: conversationPrefix(manifest, history, messageId),
          metadata: {},
          manualTitle: true,
        };
        if (manifest.agents) createInput.agents = manifest.agents;
        const child = await store.create(createInput);
        index(child);
        return publish(child, true);
      });
    },
    async deleteSession(id: string, directory: string): Promise<{ deleted: true }> {
      await load();
      if (!isConversationId(id)) { assertStandalone(id); return native.deleteSession(id, directory); }
      await native.assertDelegatedDeletion?.(id);
      preparing.get(id)?.abort(new Error('Conversation deleted'));
      return locked(id, async () => {
        let manifest = get(id, directory);
        if (!canDelete(manifest)) throw new NativeAgentError('A native source does not support deletion. Archive this conversation instead.', {
          status: 409, code: 'NATIVE_CONVERSATION_DELETE_UNSUPPORTED',
        });
        await stop(manifest);
        await retryUnavailable();
        if (store.unavailable().length > 0) throw new NativeAgentError('Unreadable conversation records prevent safe shared-history cleanup. Restore those records and retry.', {
          status: 409, code: 'NATIVE_CONVERSATION_STORAGE_UNAVAILABLE',
        });
        const sources = new Set(referencedSegments(manifest).map((segment) => segment.sessionId));
        for (const entry of await registry.listSessions()) if (entry.conversationId === id) sources.add(entry.sessionId);
        const retained = new Set(store.list().filter((entry) => entry.id !== id).flatMap((entry) => referencedSegments(entry).map((segment) => segment.sessionId)));
        await native.removeDelegatedChildren?.(id, retained);
        manifest = await update(id, (current) => ({ ...current, deletion: current.deletion ?? [...sources].filter((source) => !retained.has(source)) }));
        for (const source of [...(manifest.deletion ?? [])]) {
          try { await native.deleteSession(source, manifest.directory); }
          catch (error) {
            if (!(error instanceof NativeAgentError) || error.status !== 404) {
              throw new NativeAgentError('Some native history could not be deleted. Retry deletion to finish cleanup.', {
                status: 502, code: 'NATIVE_CONVERSATION_DELETE_INCOMPLETE',
              });
            }
          }
          manifest = await update(id, (current) => ({ ...current, deletion: (current.deletion ?? []).filter((entry) => entry !== source) }));
        }
        await registry.removeSession(id);
        await store.remove(id);
        for (const source of sources) {
          if (retained.has(source)) continue;
          owned.delete(source);
          owners.delete(source);
          foreground.delete(source);
          background.delete(source);
          waiting.delete(source);
          clocks.delete(source);
          sourcePrefixes.delete(source);
          for (const [child, root] of childRoots) if (root === source) { foreground.delete(child); childRoots.delete(child); }
        }
        emit(manifest, 'session.deleted', { sessionID: id });
        return { deleted: true };
      });
    },
    async compact(id: string, request: ConversationCompactRequest): Promise<void> {
      await load();
      if (!isConversationId(id)) { assertStandalone(id); return native.compact(id, request); }
      return locked(id, async () => {
        const { manifest, segment } = await sourceFor(id, request.directory);
        checkPolicy();
        await assertQuiet(manifest);
        if (segment && !lifecycles[segment.backend].compact) throw new NativeAgentError('This native source does not support manual compaction. Select and send to another backend before compacting.', {
          status: 409, code: 'NATIVE_CONVERSATION_COMPACT_UNSUPPORTED',
        });
        if (!segment) return;
        if (manifest.admission) throw unknownAdmission();
        if (manifest.cut || segment.ownerId !== id || segment.through !== undefined
          || segment.backend !== nativeBackendOfProviderId(request.model.providerID)) throw invalidRequestError('Send a message to the selected backend before compacting it');
        return native.compact(segment.sessionId, { ...request, directory: manifest.directory });
      });
    },
    async commands(backend: NativeBackend, directory: string, id?: string) {
      if (!id || !isConversationId(id)) return native.commands(backend, directory, id);
      const { segment } = await sourceFor(id, directory);
      return native.commands(backend, directory, segment?.backend === backend ? segment.sessionId : undefined);
    },
    async codexCommand(input: ConversationCodexCommandInput): Promise<JsonObject> {
      if (!input.sessionId || !isConversationId(input.sessionId)) {
        await load();
        if (input.sessionId) assertStandalone(input.sessionId);
        return native.codexCommand(input);
      }
      const conversationId = input.sessionId;
      return locked(conversationId, async () => {
        const { manifest, segment } = await sourceFor(conversationId, input.directory);
        checkPolicy();
        if (segment?.backend !== 'codex') throw invalidRequestError('Send a message to Codex before using its session commands');
        if (input.name === 'review') {
          await assertQuiet(manifest);
          if (manifest.cut || manifest.admission) throw sessionBusyError();
        }
        return native.codexCommand({ ...input, sessionId: segment.sessionId });
      });
    },
    async deepseekCommand(input: ConversationDeepseekCommandInput): Promise<JsonObject> {
      if (!isConversationId(input.sessionId)) { await load(); assertStandalone(input.sessionId); return native.deepseekCommand(input); }
      return locked(input.sessionId, async () => {
        const { manifest, segment } = await sourceFor(input.sessionId, input.directory);
        checkPolicy();
        if (segment?.backend !== 'deepseek') throw invalidRequestError('Send a message to DeepSeek before using its session commands');
        if (manifest.cut || manifest.admission) throw sessionBusyError();
        return native.deepseekCommand({ ...input, sessionId: segment.sessionId });
      });
    },
    hasPendingPlanDecision(id: string): boolean {
      const source = isConversationId(id) ? activeOf(get(id))?.sessionId : id;
      return source ? native.hasPendingPlanDecision(source) : false;
    },
    async setSessionAssist(id: string, directory: string, assist: ConversationSessionAssist): Promise<NativeSessionRecord> {
      if (!isConversationId(id)) return native.setSessionAssist(id, directory, assist);
      await load();
      get(id, directory);
      return publish(await update(id, (current) => ({
        ...current,
        metadata: { ...current.metadata, openchamber: { ...namespaceSchema.parse(current.metadata.openchamber), assist } },
      })));
    },
    async setSessionWork(id: string, directory: string, work: ConversationSessionWork): Promise<NativeSessionRecord> {
      if (!isConversationId(id)) return native.setSessionWork(id, directory, work);
      await load();
      get(id, directory);
      return publish(await update(id, (current) => ({
        ...current,
        metadata: { ...current.metadata, openchamber: { ...namespaceSchema.parse(current.metadata.openchamber), work: namespaceSchema.parse(work) } },
      })));
    },
    async checklist(id: string, directory: string): Promise<NativeChecklistSnapshot> {
      if (!isConversationId(id)) return native.checklist(id, directory);
      const { manifest, segment: active } = await sourceFor(id, directory);
      let segment = active ?? manifest.segments.at(-1);
      if (!segment) return { state: 'unavailable', reason: nativeBackendOfProviderId(manifest.selection.model.providerID) === 'antigravity' ? 'source_unknown' : 'unsupported' };
      if (segment.backend !== 'antigravity') return active
        ? native.checklist(active.sessionId, directory) : { state: 'unavailable', reason: 'unsupported' };
      let records;
      let complete;
      if (manifest.cut) {
        const history = await historyOf(manifest);
        const end = history.entries.findIndex((entry) => entry.record.info.id === manifest.cut);
        if (end === -1) throw invalidRequestError('Unknown conversation rewind point');
        const retained = history.entries.slice(0, end);
        const lastSegmentId = retained.at(-1)?.segmentId;
        segment = manifest.segments.find((entry) => entry.id === lastSegmentId);
        if (!segment || segment.backend !== 'antigravity') return { state: 'unavailable', reason: 'source_unknown' };
        const matchedSegmentId = segment.id;
        records = retained.filter((entry) => entry.segmentId === matchedSegmentId).map((entry) => entry.record);
        complete = history.metadataComplete;
      } else {
        const history = await readConversationSegment(native, manifest, segment);
        records = history.records;
        complete = history.metadataComplete;
      }
      const snapshot = antigravityChecklistSnapshot({ sessionId: segment.sessionId, records, complete, observedAt: now() });
      return snapshot.state === 'ready' ? { ...snapshot, identity: checklistIdentity(manifest, segment) } : snapshot;
    },
    async plan(id: string, directory: string): Promise<JsonObject> {
      if (!isConversationId(id)) return native.plan(id, directory);
      const { segment } = await sourceFor(id, directory);
      if (!segment) return { state: 'empty' };
      return native.plan(segment.sessionId, directory);
    },
    async codexTodos(id: string, directory: string): Promise<JsonObject> {
      if (!isConversationId(id)) return native.codexTodos(id, directory);
      const { segment } = await sourceFor(id, directory);
      if (!segment) return { state: 'unsupported', generation: null, revision: 0, todos: [] };
      return native.codexTodos(segment.sessionId, directory);
    },
    async sessionTasks(id: string, directory: string): Promise<JsonObject> {
      if (!isConversationId(id)) return native.sessionTasks(id, directory);
      const { segment } = await sourceFor(id, directory);
      if (!segment) return { state: 'unsupported', generation: null, revision: 0, tasks: [], omitted: 0 };
      return native.sessionTasks(segment.sessionId, directory);
    },
    async taskOutput(id: string, directory: string, taskId: string, generation: string): Promise<JsonObject> {
      if (!isConversationId(id)) return native.taskOutput(id, directory, taskId, generation);
      const { segment } = await sourceFor(id, directory);
      if (!segment) return { state: 'unavailable', reason: 'not_recorded' };
      return native.taskOutput(segment.sessionId, directory, taskId, generation);
    },
    async stopTask(id: string, directory: string, taskId: string, generation: string): Promise<JsonObject> {
      if (!isConversationId(id)) return native.stopTask(id, directory, taskId, generation);
      const { segment } = await sourceFor(id, directory);
      if (!segment) throw new NativeAgentError('Task stopping is unsupported', { status: 501, code: 'NATIVE_TASK_STOP_UNAVAILABLE' });
      return native.stopTask(segment.sessionId, directory, taskId, generation);
    },
    async shutdown(): Promise<void> {
      stopping = true;
      for (const controller of preparing.values()) controller.abort(new Error('Native conversations are shutting down'));
      const closing = native.shutdown();
      await Promise.allSettled([closing, titles.stop(), ...operations.values()]);
      await store.drain();
    },
  };

  return {
    api,
    delegationActivity(id: string): void {
      const manifest = store.peek(id);
      if (manifest) publish(manifest);
    },
    async validatePlanExecution(
      source: string,
      directory: string,
      requestId: string,
      execution: PlanExecutionChoice,
      handoff: boolean,
      approves = true,
    ): Promise<boolean> {
      await load();
      const owner = owners.get(source);
      if (!owner) { assertStandalone(source); return false; }
      checkPolicy();
      const manifest = get(owner.id, directory);
      if (activeOf(manifest)?.sessionId !== source) throw invalidRequestError('The original planning session is no longer active');
      if (approves && execution.expectedRevision !== manifest.selectionRevision) throw new NativeAgentError('The conversation selection changed. Reload and retry.', {
        status: 409, code: 'NATIVE_CONVERSATION_SELECTION_CONFLICT',
      });
      if (handoff) await assertQuiet(manifest, { requestId, allowedForeground: source });
      return true;
    },
    async planExecutionOutcome(
      source: string,
      directory: string,
      state: PlanExecutionActiveState,
    ): Promise<'accepted' | 'not-dispatched' | 'unknown' | null> {
      await load();
      const owner = owners.get(source);
      if (!owner) { assertStandalone(source); return null; }
      let manifest = get(owner.id, directory);
      try { await recoverAdmission(manifest, state.logicalMessageID); }
      catch (error) {
        if (!(error instanceof NativeAgentError) || error.code !== 'NATIVE_PROMPT_OUTCOME_UNKNOWN') throw error;
        return 'unknown';
      }
      manifest = get(owner.id, directory);
      const send = manifest.segments.flatMap((segment) => segment.sends).find((entry) => entry.messageId === state.logicalMessageID);
      if (send?.state === 'accepted') return 'accepted';
      if (send || manifest.admission || activeOf(manifest)?.sessionId !== source) return 'unknown';
      const retained = new Set(manifest.segments.map((segment) => segment.sessionId));
      const orphan = (await registry.listSessions({ directory })).some((entry) => entry.conversationId === manifest.id && !retained.has(entry.sessionId));
      return orphan ? 'unknown' : 'not-dispatched';
    },
    async automaticPrompt(
      source: string,
      request: ConversationPromptRequest,
      signal?: AbortSignal,
      approval: ConversationApprovalHook | null = null,
    ): Promise<void> {
      await load();
      const owner = owners.get(source);
      if (!owner) {
        assertStandalone(source);
        await approval?.onDispatched?.();
        try { return await native.prompt(source, request, signal); }
        catch (error) { if (definiteRefusal(error)) await approval?.onRefused?.(); throw error; }
      }
      return prompt(owner.id, { ...request, messageID: approval?.logicalMessageId ?? `ncv_u_${randomUUID()}` }, signal, source, request.messageID, approval);
    },
    publishInteraction(source: string, part: NativePart): boolean {
      const owner = owners.get(source);
      const manifest = owner ? store.peek(owner.id) : undefined;
      const segment = manifest?.segments.find((entry) => entry.id === owner?.segmentId);
      if (!manifest || !segment) return false;
      if (!includesSourceMessage(segment, part.messageID)) return true;
      emit(manifest, 'message.part.updated', {
        sessionID: manifest.id,
        part: projectConversationPart(manifest.id, { ...segment, timeOffset: segment.timeOffset ?? clocks.get(source) ?? 0 }, part),
      });
      return true;
    },
    publish(event: NativePublishedEvent): void {
      const { payload } = event;
      const properties = payload.properties;
      const infoRecord = isRecord(properties.info) ? properties.info : null;
      const partRecord = isRecord(properties.part) ? properties.part : null;
      const statusRecord = isRecord(properties.status) ? properties.status : null;
      const questionId = payload.type === 'question.asked' && isString(properties.id)
        ? properties.id
        : (payload.type === 'question.replied' || payload.type === 'question.rejected') && isString(properties.requestID)
          ? properties.requestID
          : null;
      const questionOwner = questionId ? questionOwners.get(questionId) : null;
      const source = (isString(properties.sessionID) ? properties.sessionID : undefined)
        ?? (infoRecord && isString(infoRecord.sessionID) ? infoRecord.sessionID : undefined)
        ?? (partRecord && isString(partRecord.sessionID) ? partRecord.sessionID : undefined)
        ?? (infoRecord && isString(infoRecord.id) ? infoRecord.id : undefined);
      if ((payload.type === 'session.created' || payload.type === 'session.updated') && infoRecord && isString(infoRecord.parentID) && isString(infoRecord.id)) {
        const logicalParent = store.peek(infoRecord.parentID);
        const root = logicalParent ? activeOf(logicalParent)?.sessionId : sourceRoot(infoRecord.parentID);
        if (root && owned.has(root)) {
          childRoots.set(infoRecord.id, root);
          const owner = owners.get(root);
          if (owner && infoRecord.parentID === root) properties.info = { ...infoRecord, parentID: owner.id };
        }
      }
      if (!source) {
        publishNativeEvent(event);
        return;
      }
      if (payload.type === 'session.status' && statusRecord) {
        if (statusRecord.type === 'idle') foreground.delete(source);
        else foreground.add(source);
      }
      if (payload.type === 'session.idle' || payload.type === 'session.deleted') foreground.delete(source);
      if (payload.type === 'session.background.updated' && Array.isArray(properties.tasks)) {
        const tasks = properties.tasks.filter((task): task is { id: string; type: string; description: string } => (
          isRecord(task) && isString(task.id) && isString(task.type) && isString(task.description)
        ));
        background.set(source, tasks);
      }
      if (payload.type === 'question.asked' && isString(properties.id)) {
        const questions = waiting.get(source) ?? new Set();
        questions.add(properties.id);
        waiting.set(source, questions);
      }
      if ((payload.type === 'question.replied' || payload.type === 'question.rejected') && isString(properties.requestID)) {
        waiting.get(source)?.delete(properties.requestID);
        questionOwners.delete(properties.requestID);
      }
      const owner = owners.get(source);
      if (!owner) {
        if (!owned.has(source)) publishNativeEvent(event);
        const childRoot = childRoots.get(source);
        const parent = childRoot ? owners.get(childRoot) : undefined;
        const manifest = parent ? store.peek(parent.id) : undefined;
        if (manifest && ['session.status', 'session.idle', 'session.background.updated', 'question.asked', 'question.replied', 'question.rejected'].includes(payload.type)) {
          if (!hasLiveWork(manifest)) void reverts.afterTurn(manifest.id);
          publish(manifest);
        }
        return;
      }
      const manifest = store.peek(owner.id);
      const segment = manifest?.segments.find((entry) => entry.id === owner.segmentId);
      if (!manifest || !segment) return;
      if (manifest.active !== segment.id && questionOwner?.id !== manifest.id) {
        const correction = payload.type === 'message.patched' && segment.backend === 'codex'
          ? telemetryCorrection.safeParse(properties) : null;
        if (correction?.success) void publishRetainedTelemetry(owner, source, correction.data).catch(() => undefined);
        return;
      }
      const eventMessageId = (infoRecord && isString(infoRecord.id) ? infoRecord.id : undefined)
        ?? (partRecord && isString(partRecord.messageID) ? partRecord.messageID : undefined)
        ?? (isString(properties.messageID) ? properties.messageID : undefined);
      if (payload.type.startsWith('message.') && !includesSourceMessage(segment, eventMessageId)) return;
      if (payload.type === 'question.asked' && isString(properties.id)) {
        const kind = isString(properties.kind) ? properties.kind : undefined;
        questionOwners.set(properties.id, { id: manifest.id, selection: manifest.selection, plan: kind?.endsWith('-plan-exit') === true });
      }
      if (payload.type === 'message.updated' && segment.timeOffset === undefined && !clocks.has(segment.sessionId) && isNativeMessageInfoValue(properties.info)) {
        const offset = Math.max(0, segment.createdAt - properties.info.time.created);
        clocks.set(segment.sessionId, offset);
        void update(manifest.id, (current) => {
          const matched = current.segments.find((entry) => entry.id === segment.id);
          if (matched) matched.timeOffset = offset;
          return current;
        }).catch(() => undefined);
      }
      const projection = { ...segment, timeOffset: segment.timeOffset ?? clocks.get(segment.sessionId) ?? 0 };
      if (payload.type === 'session.created' || payload.type === 'session.updated' || payload.type === 'session.deleted') {
        const infoTitle = infoRecord && isString(infoRecord.title) ? infoRecord.title : null;
        if (payload.type === 'session.updated' && manifest.segments[0]?.id === segment.id && !manifest.manualTitle && !manifest.generatedTitle
          && infoTitle && infoTitle !== manifest.title
          && infoTitle !== 'New Codex session' && infoTitle !== 'New Claude Code session'
          && infoTitle !== 'New Antigravity session') {
          void update(manifest.id, (current) => {
            if (!current.manualTitle && !current.generatedTitle) current.title = conversationTitlePreview([{ type: 'text', text: infoTitle }]) || current.title;
            return current;
          }).then(publish).catch(() => undefined);
        }
        publish(manifest);
        return;
      }
      const projected: JsonObject = { ...properties, sessionID: manifest.id };
      if (payload.type === 'session.revert.committed') {
        const admission = manifest.admission;
        if (admission?.rewindSource !== source || !admission.rollback.cut) return;
        projected.to = admission.rollback.cut;
        projected.nativeHistoryRevision = manifest.historyRevision;
      }
      if (payload.type === 'session.checklist.updated' && segment.backend === 'antigravity') {
        if (manifest.cut || segment.through || segment.before) return;
        if (isRecord(properties.snapshot) && properties.snapshot.state === 'ready') {
          projected.snapshot = { ...properties.snapshot, identity: checklistIdentity(manifest, segment) };
        }
      }
      if (payload.type === 'message.updated' && isNativeMessageInfoValue(properties.info)) {
        projected.info = projectConversationRecord(manifest.id, projection, { info: properties.info, parts: [] }).info;
      }
      if (payload.type === 'message.part.updated' && isNativePartValue(properties.part)) {
        projected.part = projectConversationPart(manifest.id, projection, properties.part);
      }
      if (payload.type === 'message.parts.replaced' && Array.isArray(properties.parts)) {
        projected.parts = properties.parts.filter(isNativePartValue).map((part) => projectConversationPart(manifest.id, projection, part));
      }
      if (isString(properties.messageID)) {
        projected.messageID = conversationMessageId(manifest.id, segment, properties.messageID);
        if (isString(properties.partID)) {
          projected.partID = conversationPartId(manifest.id, segment, properties.partID, properties.messageID);
        }
      }
      if (payload.type === 'question.asked' && isToolRef(properties.tool)) {
        projected.tool = {
          ...properties.tool,
          messageID: conversationMessageId(manifest.id, segment, properties.tool.messageID),
        };
      }
      publishNativeEvent({ ...event, payload: { ...payload, properties: projected } });
      if (payload.type === 'session.idle') {
        if (!hasLiveWork(manifest)) void reverts.afterTurn(manifest.id);
        void update(manifest.id, (current) => current).then((current) => { publish(current); void titles.generate(current.id); }).catch(() => undefined);
      } else if (payload.type === 'session.status' || payload.type === 'session.background.updated' || payload.type.startsWith('question.')) {
        if (!hasLiveWork(manifest) && !preparing.has(manifest.id)) void reverts.afterTurn(manifest.id);
        publish(manifest);
      }
    },
  };
};
