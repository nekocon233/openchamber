import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { deepseekHistorySchema, deepseekRewindSchema } from './deepseek/history.js';
import { nativeBackendSchema } from './ids.js';
import type { NativeBackend } from './ids.js';
import { planExecutionStateSchema } from './plan-execution.js';
import type { PlanExecutionState } from './plan-execution.js';
import { agentConfigurationSchema } from './agent-configuration.js';
import type { AgentConfiguration, AgentConfigurationWrite } from './agent-configuration.js';
import { antigravityMeasurementsSchema } from './antigravity/measurements.js';
import type { JsonObject } from '../shared/json-values.js';

const MAX_SENDS_PER_SESSION = 200;
const MAX_TURNS_PER_SESSION = 200;
const MAX_CHECKLIST_IDS = 2000;

const metadataSchema = z.record(z.string(), z.json());

const checklistSourceSchema = z.object({
  configDir: z.string().min(1).max(4096).refine((value) => path.isAbsolute(value) && !value.includes('\0')),
  listId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
});

const checklistIdentitySchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const checklistIdListSchema = z.array(z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/)).max(MAX_CHECKLIST_IDS);

const checklistProjectionSchema = z.object({
  baseline: checklistIdListSchema.nullable(),
  hidden: checklistIdListSchema,
  pendingCreated: checklistIdListSchema,
});

const antigravityInteractionSchema = z.object({
  callID: z.string().min(1),
  userStep: z.number().int().nonnegative(),
  revision: z.string().min(1),
  requestId: z.string().min(1),
  phase: z.enum(['open', 'dispatching', 'settled']),
  replyMessageId: z.string().min(1).optional(),
});

const delegationBindingSchema = z.object({
  parentID: z.string().min(1),
  jobID: z.string().uuid(),
});

export type RegistryAgentConfiguration =
  | (AgentConfiguration & { unavailable?: undefined })
  | { revision: 0; subagent: null; execution: null; unavailable: true };

const sessionEntrySchema = z.object({
  backend: nativeBackendSchema,
  nativeId: z.string().min(1),
  directory: z.string().min(1),
  origin: z.enum(['openchamber', 'adopted']),
  createdAt: z.number(),
  confirmedAt: z.number().optional(),
  archivedAt: z.number().optional(),
  title: z.string().optional(),
  conversationId: z.string().regex(/^ncv_[0-9a-f-]{36}$/).optional(),
  deepseekHistory: deepseekHistorySchema.optional(),
  deepseekDeletion: z.object({ root: z.string().min(1) }).optional(),
  metadata: metadataSchema.optional().catch(undefined),
  claudeChecklistSource: checklistSourceSchema.optional().catch(undefined),
  antigravityInteraction: antigravityInteractionSchema.optional().catch(undefined),
  planExecution: planExecutionStateSchema.optional().catch({ phase: 'unavailable' }),
  agentConfiguration: agentConfigurationSchema
    .transform((value): RegistryAgentConfiguration => value)
    .optional()
    .catch({ revision: 0, subagent: null, execution: null, unavailable: true }),
  delegation: delegationBindingSchema.optional(),
});

const sendRecordSchema = z.object({
  messageId: z.string().min(1),
  providerID: z.string().min(1),
  modelID: z.string(),
  variant: z.string().optional(),
  agent: z.string().min(1),
  sentAt: z.number(),
  antigravity: z.object({
    stepIndex: z.number().int().nonnegative().optional(),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    requestFingerprint: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    inputDelivery: z.enum(['reserved', 'written', 'not-written']).optional(),
    interactionReply: z.literal(true).optional(),
    denial: z.object({
      actions: z.array(z.string().min(1).max(256)).min(1).max(32),
      time: z.number().nonnegative(),
    }).optional().catch(undefined),
    completion: z.object({
      outcome: z.enum(['success', 'error', 'aborted']),
      time: z.number().nonnegative(),
    }).optional(),
    measurements: antigravityMeasurementsSchema.optional().catch(undefined),
  }).optional(),
});

const turnSnapshotSchema = z.object({
  messageId: z.string().min(1),
  root: z.string().min(1),
  before: z.string().min(1),
  after: z.string().min(1).optional(),
});

const pendingRevertSchema = z.object({
  messageId: z.string().min(1),
  messageIds: z.array(z.string().min(1)),
  phase: z.enum(['pending', 'committed']),
  root: z.string().min(1).optional(),
  preRevert: z.string().min(1).optional(),
  files: z.array(z.string()),
  resumeAt: z.string().min(1).optional(),
  beforeTurnId: z.string().min(1).optional(),
  deepseek: deepseekRewindSchema.optional(),
});

const registryFileSchema = z.object({
  version: z.literal(1),
  sessions: z.record(z.string(), z.unknown()).catch({}),
  sends: z.record(z.string(), z.array(z.unknown())).catch({}),
  turns: z.record(z.string(), z.array(z.unknown())).catch({}),
  reverts: z.record(z.string(), z.unknown()).catch({}),
  checklists: z.record(z.string(), z.unknown()).catch({}),
});

export type RegistryChecklistSource = z.infer<typeof checklistSourceSchema>;
export type RegistryChecklistProjection = z.infer<typeof checklistProjectionSchema>;
export type RegistryAntigravityInteraction = z.infer<typeof antigravityInteractionSchema>;
export type RegistryDelegationBinding = z.infer<typeof delegationBindingSchema>;
export type RegistrySessionEntry = z.infer<typeof sessionEntrySchema>;
export type RegistrySessionInput = z.input<typeof sessionEntrySchema>;
export type RegistryListedSession = RegistrySessionEntry & { sessionId: string };
export type RegistrySendRecord = z.infer<typeof sendRecordSchema>;
export type RegistrySendRecordInput = z.input<typeof sendRecordSchema>;
export type RegistryTurnSnapshot = z.infer<typeof turnSnapshotSchema>;
export type RegistryPendingRevert = z.infer<typeof pendingRevertSchema>;
export type RegistryPendingRevertInput = z.input<typeof pendingRevertSchema>;
export type RegistryDeepseekHistory = z.infer<typeof deepseekHistorySchema>;

export interface RegistrySessionPatch {
  archivedAt?: number | null | undefined;
  title?: string | undefined;
  conversationId?: string | undefined;
  claudeChecklistSource?: RegistryChecklistSource | null | undefined;
  antigravityInteraction?: RegistryAntigravityInteraction | null | undefined;
  planExecution?: PlanExecutionState | null | undefined;
  agentConfiguration?: RegistryAgentConfiguration | undefined;
  delegation?: RegistryDelegationBinding | undefined;
  metadata?: JsonObject | null | undefined;
}

export interface NativeRegistryState {
  sessions: Map<string, RegistrySessionEntry>;
  sends: Map<string, RegistrySendRecord[]>;
  turns: Map<string, RegistryTurnSnapshot[]>;
  reverts: Map<string, RegistryPendingRevert>;
  checklists: Map<string, RegistryChecklistProjection>;
}

export type NativeRegistryStatus = { reset: false } | { reset: true; resetAt: number };

export interface NativeRegistryOptions {
  filePath: string;
  now?: (() => number) | undefined;
}

export interface NativeRegistry {
  load: () => Promise<NativeRegistryState>;
  status: () => NativeRegistryStatus;
  getSession: (sessionId: string) => Promise<RegistrySessionEntry | null>;
  hasPendingAntigravityInteraction: (sessionId: string) => boolean;
  hasPendingPlanExecution: (sessionId: string) => boolean;
  listSessions: (filter?: { backend?: NativeBackend | undefined; directory?: string | undefined }) => Promise<RegistryListedSession[]>;
  unconfirmedSessions: (filter?: { backend?: NativeBackend | undefined; directory?: string | undefined; sessionId?: string | undefined }) => Promise<RegistryListedSession[]>;
  registerSession: (sessionId: string, entry: RegistrySessionInput) => Promise<RegistrySessionEntry>;
  confirmSession: (sessionId: string) => Promise<RegistrySessionEntry | null>;
  updateSession: (sessionId: string, patch: RegistrySessionPatch) => Promise<RegistrySessionEntry | null>;
  removeSession: (sessionId: string) => Promise<void>;
  setAgentConfiguration: (sessionId: string, configuration: AgentConfigurationWrite, expectedRevision: number) => Promise<AgentConfiguration | null>;
  isDelegatedSession: (sessionId: string) => boolean;
  setDeepseekHistory: (sessionId: string, history: RegistryDeepseekHistory) => Promise<void>;
  setDeepseekDeletion: (sessionId: string, intent: { root: string } | null) => Promise<RegistrySessionEntry>;
  recordTurnStart: (sessionId: string, snapshot: RegistryTurnSnapshot) => Promise<void>;
  recordTurnEnd: (sessionId: string, after: string) => Promise<void>;
  turnSnapshots: (sessionId: string) => Promise<RegistryTurnSnapshot[]>;
  dropTurns: (sessionId: string, messageIds: string[]) => Promise<void>;
  pendingRevert: (sessionId: string) => Promise<RegistryPendingRevert | null>;
  setPendingRevert: (sessionId: string, revert: RegistryPendingRevertInput | null) => Promise<void>;
  checklistProjection: (identity: string) => Promise<RegistryChecklistProjection | null>;
  setChecklistProjection: (identity: string, projection: RegistryChecklistProjection | null) => Promise<void>;
  recordSend: (sessionId: string, record: RegistrySendRecordInput) => Promise<void>;
  bindAntigravityMessage: (sessionId: string, messageId: string, stepIndex: number, record?: RegistrySendRecordInput | null) => Promise<void>;
  sendRecords: (sessionId: string) => Promise<Map<string, RegistrySendRecord>>;
}

const markAntigravityReply = (record: RegistrySendRecord, replyMessageId: string | undefined): RegistrySendRecord => (
  record.messageId === replyMessageId && record.antigravity
    ? { ...record, antigravity: { ...record.antigravity, interactionReply: true } }
    : record
);

const emptyState = (): NativeRegistryState => ({
  sessions: new Map(),
  sends: new Map(),
  turns: new Map(),
  reverts: new Map(),
  checklists: new Map(),
});

const cloneState = (state: NativeRegistryState): NativeRegistryState => ({
  sessions: new Map(state.sessions),
  sends: new Map(Array.from(state.sends, ([sessionId, records]) => [sessionId, [...records]])),
  turns: new Map(Array.from(state.turns, ([sessionId, records]) => [sessionId, [...records]])),
  reverts: new Map(state.reverts),
  checklists: new Map(state.checklists),
});

const serialize = (state: NativeRegistryState): string => JSON.stringify({
  version: 1,
  sessions: Object.fromEntries(state.sessions),
  sends: Object.fromEntries(state.sends),
  turns: Object.fromEntries(state.turns),
  reverts: Object.fromEntries(state.reverts),
  checklists: Object.fromEntries(state.checklists),
}, null, 2);

const validEntries = <Output>(values: ReadonlyArray<unknown>, schema: z.ZodType<Output>): Output[] => {
  const results: Output[] = [];
  for (const value of values) {
    const parsed = schema.safeParse(value);
    if (parsed.success) results.push(parsed.data);
  }
  return results;
};

const errorCode = z.object({ code: z.string() }).passthrough();

export const createNativeRegistry = ({ filePath, now = Date.now }: NativeRegistryOptions): NativeRegistry => {
  let state: NativeRegistryState | null = null;
  let loadPromise: Promise<NativeRegistryState> | null = null;
  let writeChain: Promise<void> = Promise.resolve();
  let resetAt: number | null = null;

  const readState = async (): Promise<NativeRegistryState> => {
    let raw: string;
    try {
      raw = await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
      if (errorCode.safeParse(error).data?.code === 'ENOENT') return emptyState();
      throw error;
    }
    let parsed: z.infer<typeof registryFileSchema>;
    try {
      parsed = registryFileSchema.parse(JSON.parse(raw));
    } catch (error) {
      const backup = `${filePath}.corrupt-${now()}`;
      await fs.promises.rename(filePath, backup).catch(() => undefined);
      console.warn(`[native-agents] registry was unreadable and moved to ${backup}: ${error instanceof Error ? error.message : error}`);
      resetAt = now();
      return emptyState();
    }
    const next = emptyState();
    for (const [sessionId, value] of Object.entries(parsed.sessions)) {
      const entry = sessionEntrySchema.safeParse(value);
      if (entry.success) next.sessions.set(sessionId, entry.data);
    }
    for (const [sessionId, values] of Object.entries(parsed.sends)) {
      const records = validEntries(values, sendRecordSchema);
      if (records.length > 0) next.sends.set(sessionId, records.slice(-MAX_SENDS_PER_SESSION));
    }
    for (const [sessionId, values] of Object.entries(parsed.turns)) {
      const records = validEntries(values, turnSnapshotSchema);
      if (records.length > 0) next.turns.set(sessionId, records.slice(-MAX_TURNS_PER_SESSION));
    }
    for (const [sessionId, value] of Object.entries(parsed.reverts)) {
      const revert = pendingRevertSchema.safeParse(value);
      if (revert.success) next.reverts.set(sessionId, revert.data);
    }
    for (const [identity, value] of Object.entries(parsed.checklists)) {
      const projection = checklistProjectionSchema.safeParse(value);
      if (identity.length > 0 && projection.success) next.checklists.set(identity, projection.data);
    }
    return next;
  };

  const load = (): Promise<NativeRegistryState> => {
    if (state) return Promise.resolve(state);
    if (!loadPromise) {
      loadPromise = readState().then((loaded) => {
        state = loaded;
        loadPromise = null;
        return loaded;
      }, (error) => {
        loadPromise = null;
        throw error;
      });
    }
    return loadPromise;
  };

  const writeState = async (next: NativeRegistryState): Promise<void> => {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmpPath, serialize(next), 'utf8');
    await fs.promises.rename(tmpPath, filePath);
  };

  const mutate = <Result>(update: (next: NativeRegistryState) => Result): Promise<Result> => {
    const run = writeChain.then(async () => {
      const current = await load();
      const next = cloneState(current);
      const result = update(next);
      await writeState(next);
      state = next;
      return result;
    });
    writeChain = run.then(() => undefined, () => undefined);
    return run;
  };

  return {
    load,

    status() {
      return resetAt === null ? { reset: false } : { reset: true, resetAt };
    },

    async getSession(sessionId) {
      const loaded = await load();
      return loaded.sessions.get(sessionId) ?? null;
    },

    hasPendingAntigravityInteraction(sessionId) {
      if (state === null) return true;
      const phase = state.sessions.get(sessionId)?.antigravityInteraction?.phase;
      return phase === 'open' || phase === 'dispatching';
    },

    hasPendingPlanExecution(sessionId) {
      if (state === null) return true;
      const phase = state.sessions.get(sessionId)?.planExecution?.phase;
      return phase !== undefined && phase !== 'settled';
    },

    async listSessions(filter = {}) {
      const loaded = await load();
      return Array.from(loaded.sessions, ([sessionId, entry]) => ({ sessionId, ...entry }))
        .filter((entry) => filter.backend === undefined || entry.backend === filter.backend)
        .filter((entry) => filter.directory === undefined || entry.directory === filter.directory);
    },

    async unconfirmedSessions(filter = {}) {
      const loaded = await load();
      return Array.from(loaded.sessions, ([sessionId, entry]) => ({ sessionId, ...entry }))
        .filter((entry) => entry.origin === 'openchamber' && entry.confirmedAt === undefined)
        .filter((entry) => filter.sessionId === undefined || entry.sessionId === filter.sessionId)
        .filter((entry) => filter.backend === undefined || entry.backend === filter.backend)
        .filter((entry) => filter.directory === undefined || entry.directory === filter.directory);
    },

    registerSession(sessionId, entry) {
      const parsed = sessionEntrySchema.parse(entry);
      return mutate((next) => {
        const existing = next.sessions.get(sessionId);
        if (existing) return existing;
        next.sessions.set(sessionId, parsed);
        return parsed;
      });
    },

    confirmSession(sessionId) {
      return mutate((next) => {
        const existing = next.sessions.get(sessionId);
        if (!existing || existing.confirmedAt !== undefined) return existing ?? null;
        const confirmed: RegistrySessionEntry = { ...existing, confirmedAt: now() };
        next.sessions.set(sessionId, confirmed);
        return confirmed;
      });
    },

    updateSession(sessionId, patch) {
      return mutate((next) => {
        const existing = next.sessions.get(sessionId);
        if (!existing) return null;
        const updated: RegistrySessionEntry = { ...existing };
        if (patch.archivedAt === null) delete updated.archivedAt;
        else if (patch.archivedAt !== undefined) updated.archivedAt = patch.archivedAt;
        if (patch.title !== undefined) updated.title = patch.title;
        if (patch.conversationId !== undefined) updated.conversationId = patch.conversationId;
        if (patch.claudeChecklistSource === null) delete updated.claudeChecklistSource;
        else if (patch.claudeChecklistSource !== undefined) updated.claudeChecklistSource = checklistSourceSchema.parse(patch.claudeChecklistSource);
        const existingReplyId = existing.antigravityInteraction?.replyMessageId;
        if (patch.antigravityInteraction !== undefined && existingReplyId) {
          const records = next.sends.get(sessionId);
          if (records) next.sends.set(sessionId, records.map((record) => markAntigravityReply(record, existingReplyId)));
        }
        if (patch.antigravityInteraction === null) delete updated.antigravityInteraction;
        else if (patch.antigravityInteraction !== undefined) updated.antigravityInteraction = patch.antigravityInteraction;
        if (patch.planExecution === null) delete updated.planExecution;
        else if (patch.planExecution !== undefined) updated.planExecution = patch.planExecution;
        if (patch.agentConfiguration !== undefined) updated.agentConfiguration = patch.agentConfiguration;
        if (patch.delegation !== undefined) updated.delegation = patch.delegation;
        if (patch.metadata === null) delete updated.metadata;
        else if (patch.metadata !== undefined) updated.metadata = metadataSchema.parse(patch.metadata);
        const saved = sessionEntrySchema.parse(updated);
        next.sessions.set(sessionId, saved);
        return saved;
      });
    },

    removeSession(sessionId) {
      return mutate((next) => {
        next.sessions.delete(sessionId);
        next.sends.delete(sessionId);
        next.turns.delete(sessionId);
        next.reverts.delete(sessionId);
      });
    },

    setAgentConfiguration(sessionId, configuration, expectedRevision) {
      return mutate((next) => {
        const entry = next.sessions.get(sessionId);
        if (!entry) throw new Error('Unknown native session');
        if ((entry.agentConfiguration?.revision ?? 0) !== expectedRevision) return null;
        const value = agentConfigurationSchema.parse({ ...configuration, revision: expectedRevision + 1 });
        next.sessions.set(sessionId, { ...entry, agentConfiguration: value });
        return value;
      });
    },

    isDelegatedSession(sessionId) {
      return Boolean(state?.sessions.get(sessionId)?.delegation);
    },

    setDeepseekHistory(sessionId, history) {
      const parsed = deepseekHistorySchema.parse(history);
      return mutate((next) => {
        const entry = next.sessions.get(sessionId);
        if (!entry || entry.backend !== 'deepseek') throw new Error('Unknown DeepSeek session');
        next.sessions.set(sessionId, { ...entry, deepseekHistory: parsed });
      });
    },

    setDeepseekDeletion(sessionId, intent) {
      return mutate((next) => {
        const entry = next.sessions.get(sessionId);
        if (!entry || entry.backend !== 'deepseek') throw new Error('Unknown DeepSeek session');
        const updated: RegistrySessionEntry = { ...entry };
        if (intent === null) delete updated.deepseekDeletion;
        else updated.deepseekDeletion = intent;
        const parsed = sessionEntrySchema.parse(updated);
        next.sessions.set(sessionId, parsed);
        return parsed;
      });
    },

    recordTurnStart(sessionId, snapshot) {
      const parsed = turnSnapshotSchema.parse(snapshot);
      return mutate((next) => {
        const records = (next.turns.get(sessionId) ?? []).filter((existing) => existing.messageId !== parsed.messageId);
        records.push(parsed);
        next.turns.set(sessionId, records.slice(-MAX_TURNS_PER_SESSION));
      });
    },

    recordTurnEnd(sessionId, after) {
      return mutate((next) => {
        const records = next.turns.get(sessionId);
        if (!records?.some((record) => record.after === undefined)) return;
        next.turns.set(sessionId, records.map((record) => (record.after === undefined ? { ...record, after } : record)));
      });
    },

    async turnSnapshots(sessionId) {
      const loaded = await load();
      return [...(loaded.turns.get(sessionId) ?? [])];
    },

    dropTurns(sessionId, messageIds) {
      const dropped = new Set(messageIds);
      return mutate((next) => {
        const records = next.turns.get(sessionId);
        if (records) next.turns.set(sessionId, records.filter((record) => !dropped.has(record.messageId)));
      });
    },

    async pendingRevert(sessionId) {
      const loaded = await load();
      return loaded.reverts.get(sessionId) ?? null;
    },

    setPendingRevert(sessionId, revert) {
      const parsed = revert === null ? null : pendingRevertSchema.parse(revert);
      return mutate((next) => {
        if (parsed === null) next.reverts.delete(sessionId);
        else next.reverts.set(sessionId, parsed);
      });
    },

    async checklistProjection(identity) {
      const loaded = await load();
      return loaded.checklists.get(identity) ?? null;
    },

    setChecklistProjection(identity, projection) {
      const key = checklistIdentitySchema.parse(identity);
      const parsed = projection === null ? null : checklistProjectionSchema.parse(projection);
      return mutate((next) => {
        if (parsed === null) next.checklists.delete(key);
        else next.checklists.set(key, parsed);
      });
    },

    recordSend(sessionId, record) {
      const parsed = sendRecordSchema.parse(record);
      return mutate((next) => {
        const previous = next.sends.get(sessionId) ?? [];
        const existing = previous.find((entry) => entry.messageId === parsed.messageId);
        const antigravity = existing?.antigravity || parsed.antigravity
          ? { ...existing?.antigravity, ...parsed.antigravity }
          : undefined;
        if (antigravity && existing?.antigravity?.inputDelivery === 'written') antigravity.inputDelivery = 'written';
        const records = previous.filter((entry) => entry.messageId !== parsed.messageId);
        const merged: RegistrySendRecord = antigravity ? { ...parsed, antigravity } : { ...parsed };
        records.push(markAntigravityReply(merged, next.sessions.get(sessionId)?.antigravityInteraction?.replyMessageId));
        next.sends.set(sessionId, records.slice(-MAX_SENDS_PER_SESSION));
      });
    },

    bindAntigravityMessage(sessionId, messageId, stepIndex, record = null) {
      if (!Number.isInteger(stepIndex) || stepIndex < 0) throw new Error('Invalid Antigravity step index');
      return mutate((next) => {
        const records = [...(next.sends.get(sessionId) ?? [])];
        const index = records.findIndex((existing) => existing.messageId === messageId);
        const found = index === -1 ? undefined : records[index];
        if (!found && !record) throw new Error('Antigravity send is not registered');
        const existing = found ?? sendRecordSchema.parse(record);
        const currentStep = existing.antigravity?.stepIndex;
        if (currentStep !== undefined && currentStep !== stepIndex) throw new Error('Antigravity message is already bound to another step');
        const updated = markAntigravityReply({
          ...existing,
          antigravity: { ...existing.antigravity, stepIndex },
        }, next.sessions.get(sessionId)?.antigravityInteraction?.replyMessageId);
        if (index === -1) records.push(updated);
        else records[index] = updated;
        next.sends.set(sessionId, records.slice(-MAX_SENDS_PER_SESSION));
      });
    },

    async sendRecords(sessionId) {
      const loaded = await load();
      const replyMessageId = loaded.sessions.get(sessionId)?.antigravityInteraction?.replyMessageId;
      return new Map((loaded.sends.get(sessionId) ?? []).map((record) => [record.messageId, markAntigravityReply(record, replyMessageId)]));
    },
  };
};
