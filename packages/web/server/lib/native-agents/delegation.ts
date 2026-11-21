import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { isEnterpriseMode } from '../enterprise-mode.js';
import { isRecord, isString } from '../shared/guards.js';
import { nativeModelSupportsVariant } from './catalog.js';
import type { VariantCapableModel } from './catalog.js';
import { NativeAgentError, invalidRequestError } from './errors.js';
import { nativeBackendOfProviderId, newNativeClientUserMessageId } from './ids.js';
import type { NativeBackend } from './ids.js';
import { agentModelSchema } from './agent-configuration.js';
import type { AgentModel } from './agent-configuration.js';
import { readNativePlanReference } from './plan-execution.js';
import type { PlanExitKind } from './plan-execution.js';
import type { NativePublishedEvent } from './publisher.js';
import type { NativeMessageRecord, NativeSessionRecord, NativeToolPart } from './records.js';
import type { NativeRegistry } from './registry.js';
import { AGY_PLAN_QUESTION_PREFIX } from './antigravity/interaction-signals.js';

const callSchema = z.object({
  id: z.string().min(1).max(200),
  prompt: z.string().min(1).max(100000),
  description: z.string().max(200).optional(),
});

const jobSchema = z.object({
  id: z.string().uuid(),
  parentID: z.string(),
  sourceID: z.string(),
  callID: z.string(),
  directory: z.string(),
  childID: z.string().optional(),
  messageID: z.string().optional(),
  selection: agentModelSchema,
  agent: z.enum(['plan', 'build']),
  createdAt: z.number(),
  phase: z.enum(['preparing', 'dispatched', 'completed', 'error', 'interrupted', 'deleted']),
  error: z.string().optional(),
});

const journalSchema = z.object({ version: z.literal(1), jobs: z.array(jobSchema) });
const questionPlan = z.object({ questions: z.array(z.object({ question: z.string() })) });
const errorCode = z.object({ code: z.string() });

export type DelegationJob = z.infer<typeof jobSchema>;

export type DelegationToolConfig = {
  child: boolean;
  key: string;
  command: string;
  args: string[];
  env: {
    OPENCHAMBER_DELEGATION_URL: string;
    OPENCHAMBER_DELEGATION_TOKEN: string;
  };
};

export type DelegationAnswer = {
  taskID: string;
  sessionID: string;
  model: AgentModel['model'];
  text: string;
  error?: string | undefined;
};

export interface DelegationCatalogModel extends VariantCapableModel {
  id: string;
  aliases?: ReadonlyArray<{ id: string }> | undefined;
}

export type DelegationCatalogPartition =
  | { status: 'ok'; models: ReadonlyArray<DelegationCatalogModel> }
  | { status: 'error' | 'unavailable' };

export interface DelegationNativeAdapter {
  catalog: () => Promise<{ backends: Record<string, DelegationCatalogPartition> }>;
  loadMessages: (
    sessionId: string,
    directory: string,
    options: { limit: number },
  ) => Promise<{ records: NativeMessageRecord[]; metadataComplete?: boolean | undefined }>;
  prompt: (
    sessionId: string,
    request: {
      directory: string;
      messageID: string;
      parts: Array<{ type: 'text'; text: string }>;
      model: AgentModel['model'];
      variant?: string | undefined;
      agent: 'plan' | 'build';
      instructions: string;
    },
    signal: AbortSignal,
  ) => Promise<void>;
  statuses: (directory: string) => Promise<Record<string, { type: string }>>;
  getSession: (sessionId: string, directory: string) => Promise<NativeSessionRecord>;
  deleteSession: (sessionId: string, directory: string, force?: boolean) => Promise<{ deleted: true }>;
  abort: (sessionId: string) => Promise<boolean | void>;
  backgroundTasks?: (() => Promise<Record<string, { tasks?: ReadonlyArray<{ id: string }> | undefined }>>) | undefined;
}

export interface DelegationLaunchHandle {
  tools: DelegationToolConfig;
  bind: (sourceID: string) => Promise<void>;
  cancel: () => void;
}

export interface NativeDelegationOptions {
  dataDir: string;
  registry: Pick<NativeRegistry, 'getSession' | 'updateSession'>;
  native: DelegationNativeAdapter;
  createSession: (
    input: { backend: NativeBackend; directory: string; title: string },
    options: { toolLaunch: { child: boolean }; beforePublish: (record: NativeSessionRecord) => Promise<void> },
  ) => Promise<NativeSessionRecord>;
  resolveNode: () => Promise<string | null>;
  adoptSession: (sessionId: string, directory: string) => Promise<void>;
  stopChild?: ((id: string, directory: string) => Promise<boolean | void>) | undefined;
  deleteCapability?: ((backend: NativeBackend) => Promise<boolean>) | undefined;
  onActivity?: ((parentID: string, directory: string) => void) | undefined;
  now?: (() => number) | undefined;
}

export interface NativeDelegation {
  initialize: () => Promise<void>;
  canDeleteBackend: (backend: NativeBackend | null) => boolean;
  retire: (sourceID: string) => void;
  promote: (sourceID: string) => void;
  hasActive: (parentID: string) => boolean;
  usedInTurn: (sourceID: string) => boolean;
  canDelete: (parentID: string) => boolean;
  assertDeletion: (parentID: string) => Promise<void>;
  removeChildren: (parentID: string, retained?: ReadonlySet<string>) => Promise<void>;
  validateModel: (choice: AgentModel) => Promise<NativeBackend>;
  prepareLaunch: (input: { directory: string; subagentModel?: AgentModel | null | undefined; child?: boolean | undefined }) => Promise<DelegationLaunchHandle | null>;
  prepare: (
    sourceID: string,
    request: { directory: string; messageID: string; agent: 'plan' | 'build'; subagentModel?: AgentModel | null | undefined },
  ) => Promise<DelegationToolConfig | null>;
  observe: (event: NativePublishedEvent) => void;
  children: (parentID: string) => Promise<NativeSessionRecord[]>;
  cancel: (parentID: string) => Promise<boolean>;
  shutdown: () => Promise<void>;
}

interface DelegationContext {
  token: string;
  epoch: string;
  tools: DelegationToolConfig;
  sourceID: string | null;
  parentID: string | null;
  directory: string;
  messageID: string | null;
  agent?: 'plan' | 'build' | undefined;
  selection: AgentModel | null | undefined;
  child: boolean;
  revoked?: boolean | undefined;
}

interface DelegationWaiter {
  promise: Promise<DelegationAnswer>;
  resolve: (answer: DelegationAnswer) => void;
  reject: (cause: unknown) => void;
  controller: AbortController;
  accepted: boolean;
  idle: boolean;
  finishing: boolean;
  cancelled?: boolean | undefined;
}

const hasErrorCode = (value: unknown): value is { code?: unknown } => isRecord(value);
const hasHttpErrorFields = (value: unknown): value is { status?: unknown; code?: unknown; message?: unknown } => isRecord(value);
const isNumber = (value: unknown): value is number => typeof value === 'number';
const hasErrorMessage = (value: unknown): value is { data?: { message?: string }; message?: string } => isRecord(value);

const failure = (message: string, code = 'NATIVE_DELEGATION_UNAVAILABLE', status = 409): NativeAgentError => new NativeAgentError(message, { code, status });
const checkPolicy = (): void => { if (isEnterpriseMode()) throw failure('Cross-CLI subagents are unavailable in enterprise mode', 'enterprise_mode', 403); };

const planExitKindFor = (backend: NativeBackend | null): PlanExitKind | undefined => {
  if (backend === 'claude') return 'claude-plan-exit';
  if (backend === 'codex') return 'codex-plan-exit';
  if (backend === 'deepseek') return 'deepseek-plan-exit';
  if (backend === 'antigravity') return 'antigravity-plan-exit';
  return undefined;
};

export const createNativeDelegation = ({
  dataDir,
  registry,
  native,
  createSession,
  resolveNode,
  adoptSession,
  stopChild = (id) => native.abort(id),
  deleteCapability = async (backend) => backend !== 'antigravity',
  onActivity = () => {},
  now = Date.now,
}: NativeDelegationOptions): NativeDelegation => {
  const file = path.join(dataDir, 'native-agents', 'delegations.json');
  const jobs = new Map<string, DelegationJob>();
  const contexts = new Map<string, DelegationContext>();
  const waiters = new Map<string, DelegationWaiter>();
  const requests = new Map<string, { context: DelegationContext; promise: Promise<DelegationAnswer> }>();
  let loading: Promise<void> | undefined;
  let writing: Promise<void> = Promise.resolve();
  let server: http.Server | undefined;
  let opening: Promise<void> | undefined;
  let origin: string | undefined;
  let closed = false;
  let loaded = false;
  let deleteLoading: Promise<void> | undefined;
  let deepseekDeletable = false;

  const load = (): Promise<void> => {
    loading ??= (async () => {
      try {
        const saved = journalSchema.parse(JSON.parse(await fs.readFile(file, 'utf8')));
        for (const job of saved.jobs) jobs.set(job.id, job);
      } catch (error) {
        if (!hasErrorCode(error) || error.code !== 'ENOENT') throw failure('Subagent records could not be read. Reload before dispatching.');
      }
      loaded = true;
    })().catch((error) => { loading = undefined; throw error; });
    return loading;
  };

  const save = (job: DelegationJob): Promise<DelegationJob> => {
    const result = writing.then(async () => {
      await load();
      const parsed = jobSchema.parse(job);
      const next = new Map(jobs);
      next.set(parsed.id, parsed);
      const temporary = `${file}.${randomUUID()}.tmp`;
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      try {
        await fs.writeFile(temporary, JSON.stringify({ version: 1, jobs: [...next.values()] }), { mode: 0o600, flag: 'wx' });
        await fs.rename(temporary, file);
      } finally { await fs.rm(temporary, { force: true }); }
      jobs.set(parsed.id, parsed);
      return parsed;
    });
    writing = result.then(() => undefined, () => undefined);
    return result;
  };

  const history = async (job: DelegationJob): Promise<DelegationAnswer | null> => {
    if (!job.childID) return null;
    const page = await native.loadMessages(job.childID, job.directory, { limit: 500 });
    if (page.metadataComplete === false) throw failure('The subagent history is incomplete. Reload its task before retrying.');
    const start = page.records.findIndex((record) => record.info.role === 'user' && record.info.id === job.messageID);
    if (start < 0) return null;
    const replies = page.records.slice(start + 1).filter((record) => record.info.role === 'assistant');
    const last = replies.at(-1);
    if (!last || last.info.role !== 'assistant' || last.info.time.completed === undefined) return null;
    let text = last.parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    if (job.agent === 'plan') {
      const references: Array<{ record: NativeMessageRecord; part: NativeToolPart }> = [];
      for (const record of replies) {
        for (const part of record.parts) {
          if (part.type === 'tool' && (
            part.tool === 'plan_exit'
            || (part.tool === 'question' && questionPlan.safeParse(part.state.input).data?.questions[0]?.question.startsWith(AGY_PLAN_QUESTION_PREFIX))
          )) {
            references.push({ record, part });
          }
        }
      }
      const reference = references.at(-1);
      if (reference) {
        text = readNativePlanReference({
          kind: planExitKindFor(nativeBackendOfProviderId(job.selection.model.providerID)),
          tool: { messageID: reference.record.info.id, callID: reference.part.callID },
        }, replies).plan || text;
      }
    }
    const lastError = last.info.error;
    const errorMessage = hasErrorMessage(lastError) ? (lastError.data?.message ?? lastError.message) : undefined;
    return { taskID: job.id, sessionID: job.childID, model: job.selection.model, text, error: errorMessage };
  };

  const finish = async (id: string): Promise<void> => {
    const pending = waiters.get(id);
    if (!pending?.accepted || !pending.idle || pending.finishing || pending.cancelled) return;
    pending.finishing = true;
    try {
      const job = jobs.get(id);
      if (!job) throw failure('The subagent stopped without a confirmed answer. Open its task to inspect the outcome.', 'NATIVE_DELEGATION_OUTCOME_UNKNOWN');
      const answer = await history(job);
      if (pending.cancelled) throw failure('The parent stopped this subagent', 'NATIVE_DELEGATION_INTERRUPTED');
      if (!answer) throw failure('The subagent stopped without a confirmed answer. Open its task to inspect the outcome.', 'NATIVE_DELEGATION_OUTCOME_UNKNOWN');
      await save({ ...job, phase: answer.error ? 'error' : 'completed' });
      if (pending.cancelled) throw failure('The parent stopped this subagent', 'NATIVE_DELEGATION_INTERRUPTED');
      pending.resolve(answer);
    } catch (error) { pending.reject(error); }
    finally { waiters.delete(id); }
  };

  const validateModel = async (choice: AgentModel): Promise<NativeBackend> => {
    const selected = agentModelSchema.parse(choice);
    const backend = nativeBackendOfProviderId(selected.model.providerID);
    if (!backend) throw failure('The selected native model is unavailable. Select another model and retry.', 'NATIVE_CONVERSATION_MODEL_UNAVAILABLE');
    const partition = (await native.catalog()).backends[backend];
    const model = partition?.status === 'ok'
      ? partition.models.find((candidate) => candidate.id === selected.model.modelID || candidate.aliases?.some((alias) => alias.id === selected.model.modelID))
      : undefined;
    if (!model) throw failure('The selected native model is unavailable. Select another model and retry.', 'NATIVE_CONVERSATION_MODEL_UNAVAILABLE');
    if (selected.variant && !nativeModelSupportsVariant(model, selected.variant)) throw invalidRequestError('The selected model does not support this thinking effort');
    return backend;
  };

  const assertActive = (context: DelegationContext): void => {
    checkPolicy();
    if (closed || context.revoked || !context.messageID) throw failure('The subagent turn is no longer active', 'NATIVE_DELEGATION_INTERRUPTED');
  };

  const performDispatch = async (context: DelegationContext, input: z.infer<typeof callSchema>): Promise<DelegationAnswer> => {
    const agent = context.agent ?? 'build';
    checkPolicy();
    await load();
    assertActive(context);
    if (closed || context.child) throw failure('Subagents cannot create further subagents', 'NATIVE_DELEGATION_DEPTH');
    const call = callSchema.parse(input);
    const sourceID = context.sourceID;
    const parentID = context.parentID;
    const messageID = context.messageID;
    const selection = context.selection;
    if (!sourceID || !parentID || !messageID || !selection) throw failure('The subagent turn is no longer active', 'NATIVE_DELEGATION_INTERRUPTED');
    const existing = [...jobs.values()].find((job) => job.sourceID === sourceID && job.callID === `${messageID}:${call.id}`);
    if (existing) {
      const existingWaiter = waiters.get(existing.id);
      if (existingWaiter) return existingWaiter.promise;
      const answer = await history(existing);
      if (answer) return answer;
      throw failure('This subagent dispatch has an unknown outcome. Open its task before retrying.', 'NATIVE_DELEGATION_OUTCOME_UNKNOWN');
    }
    const backend = await validateModel(selection);
    assertActive(context);
    let job = await save({
      id: randomUUID(),
      parentID,
      sourceID,
      callID: `${messageID}:${call.id}`,
      directory: context.directory,
      selection,
      agent,
      createdAt: now(),
      phase: 'preparing',
    });
    let resolve: (answer: DelegationAnswer) => void = () => undefined;
    let reject: (cause: unknown) => void = () => undefined;
    const promise = new Promise<DelegationAnswer>((yes, no) => { resolve = yes; reject = no; });
    promise.catch(() => {});
    const pending: DelegationWaiter = { promise, resolve, reject, controller: new AbortController(), accepted: false, idle: false, finishing: false };
    waiters.set(job.id, pending);
    try {
      assertActive(context);
      const child = await createSession({ backend, directory: context.directory, title: call.description || 'Subagent' }, {
        toolLaunch: { child: true },
        beforePublish: async (record) => {
          job = await save({ ...job, childID: record.id, messageID: newNativeClientUserMessageId(record.id) });
          await registry.updateSession(record.id, { delegation: { parentID: job.parentID, jobID: job.id } });
          record.parentID = job.parentID;
        },
      });
      assertActive(context);
      job = await save({ ...job, phase: 'dispatched' });
      assertActive(context);
      const childMessageID = job.messageID;
      if (!childMessageID) throw failure('Subagent dispatch failed');
      await native.prompt(child.id, {
        directory: job.directory,
        messageID: childMessageID,
        parts: [{ type: 'text', text: call.prompt }],
        model: job.selection.model,
        variant: job.selection.variant,
        agent: job.agent,
        instructions: 'Complete the delegated task and return your result to the parent. Do not create subagents. Use the current working directory.',
      }, pending.controller.signal);
      if (pending.cancelled) throw failure('The parent stopped this subagent', 'NATIVE_DELEGATION_INTERRUPTED');
      pending.accepted = true;
      if (!(await native.statuses(job.directory))[child.id]) pending.idle = true;
      void finish(job.id);
      return await promise;
    } catch (error) {
      waiters.delete(job.id);
      const code = errorCode.safeParse(error).data?.code;
      const unknown = job.phase === 'dispatched' && (!code || code.endsWith('_UNKNOWN'));
      await save({
        ...job,
        phase: pending.cancelled || unknown || code === 'NATIVE_DELEGATION_INTERRUPTED' ? 'interrupted' : 'error',
        error: pending.cancelled ? 'The parent stopped this subagent' : unknown ? 'Dispatch outcome is unknown' : 'Subagent dispatch failed',
      });
      throw error;
    }
  };

  const dispatch = (context: DelegationContext, input: z.infer<typeof callSchema>): Promise<DelegationAnswer> => {
    const call = callSchema.parse(input);
    const key = JSON.stringify([context.sourceID, context.messageID, call.id]);
    const held = requests.get(key);
    if (held) return held.promise;
    const parentID = context.parentID;
    const promise = performDispatch(context, call).finally(() => {
      if (requests.get(key)?.promise === promise) requests.delete(key);
      if (parentID) onActivity(parentID, context.directory);
    });
    requests.set(key, { context, promise });
    if (parentID) onActivity(parentID, context.directory);
    return promise;
  };

  const open = async (): Promise<void> => {
    if (origin) return;
    opening ??= (async () => {
      const created = http.createServer(async (request, response) => {
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        try {
          checkPolicy();
          if (request.method !== 'POST' || request.url !== '/delegate' || request.socket.remoteAddress !== '127.0.0.1') {
            throw failure('Unauthorized subagent request', 'NATIVE_DELEGATION_AUTH', 403);
          }
          const authorization = request.headers.authorization ?? '';
          const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
          if (!/^[a-f0-9]{64}$/.test(bearer)) throw failure('Unauthorized subagent request', 'NATIVE_DELEGATION_AUTH', 403);
          const context = [...contexts.values()].find((entry) => bearer.length === entry.token.length && timingSafeEqual(Buffer.from(bearer), Buffer.from(entry.token)));
          if (!context) throw failure('Unauthorized subagent request', 'NATIVE_DELEGATION_AUTH', 403);
          let body = '';
          for await (const chunk of request) {
            body += String(chunk);
            if (Buffer.byteLength(body) > 150000) throw invalidRequestError('Subagent input is too large');
          }
          const call = callSchema.parse(JSON.parse(body));
          assertActive(context);
          if (context.child) throw failure('Subagents cannot create further subagents', 'NATIVE_DELEGATION_DEPTH');
          heartbeat = setInterval(() => {
            if (response.destroyed) return;
            if (!response.headersSent) response.writeHead(200, { 'Content-Type': 'application/json' });
            response.write('\n');
          }, 10000);
          heartbeat.unref();
          const answer = await dispatch(context, call);
          if (!response.headersSent) response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify(answer));
        } catch (error) {
          const status = hasHttpErrorFields(error) && isNumber(error.status) ? error.status : 500;
          const message = error instanceof Error ? error.message : hasHttpErrorFields(error) && isString(error.message) ? error.message : 'Subagent dispatch failed';
          const code = hasHttpErrorFields(error) && isString(error.code) ? error.code : 'NATIVE_DELEGATION_ERROR';
          if (!response.headersSent) response.writeHead(status, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: message, code }));
        } finally {
          if (heartbeat) clearInterval(heartbeat);
        }
      });
      server = created;
      await new Promise<void>((resolve, reject) => {
        created.once('error', reject);
        created.listen(0, '127.0.0.1', resolve);
      });
      const address = created.address();
      if (!address || isString(address)) throw failure('Could not bind subagent bridge');
      origin = `http://127.0.0.1:${address.port}/delegate`;
    })().finally(() => { opening = undefined; });
    return opening;
  };

  const prepareTools = async (
    selection: AgentModel | null | undefined,
    child: boolean,
    held?: DelegationContext,
  ): Promise<{ token: string; epoch: string; tools: DelegationToolConfig }> => {
    const node = await resolveNode();
    if (!node) throw failure('Install Node.js to use cross-CLI subagents');
    await open();
    if (!origin) throw failure('Could not bind subagent bridge');
    const token = held?.token ?? randomBytes(32).toString('hex');
    const epoch = held?.epoch ?? randomUUID();
    return {
      token,
      epoch,
      tools: {
        child,
        key: `${epoch}:${child}:${selection ? JSON.stringify(selection) : ''}`,
        command: node,
        args: [process.env.OPENCHAMBER_DELEGATION_MCP_PATH ?? fileURLToPath(new URL('./delegation-mcp.mjs', import.meta.url))],
        env: { OPENCHAMBER_DELEGATION_URL: origin, OPENCHAMBER_DELEGATION_TOKEN: token },
      },
    };
  };

  const delegation: NativeDelegation = {
    async initialize() {
      await load();
      deleteLoading ??= deleteCapability('deepseek').then((supported) => { deepseekDeletable = supported; }).finally(() => { deleteLoading = undefined; });
      await deleteLoading;
    },
    canDeleteBackend(backend) {
      return backend !== 'antigravity' && (backend !== 'deepseek' || deepseekDeletable);
    },
    retire(sourceID) {
      const existing = contexts.get(sourceID);
      if (existing) existing.revoked = true;
      contexts.delete(sourceID);
      for (const request of requests.values()) if (request.context.sourceID === sourceID) request.context.revoked = true;
    },
    promote(sourceID) {
      const context = contexts.get(sourceID);
      if (context) context.agent = 'build';
    },
    hasActive(parentID) {
      return [...requests.values()].some((request) => request.context.parentID === parentID && !request.context.revoked);
    },
    usedInTurn(sourceID) {
      const context = contexts.get(sourceID);
      return Boolean(context && [...jobs.values()].some((job) => job.sourceID === sourceID && job.callID.startsWith(`${context.messageID}:`)));
    },
    canDelete(parentID) {
      return loaded && ![...jobs.values()].some((job) => job.parentID === parentID && job.childID && job.phase !== 'deleted' && !this.canDeleteBackend(nativeBackendOfProviderId(job.selection.model.providerID)));
    },
    async assertDeletion(parentID) {
      await this.initialize();
      if (!this.canDelete(parentID)) throw failure('A subagent retains native history that cannot be deleted. Archive this conversation instead.', 'NATIVE_CONVERSATION_DELETE_UNSUPPORTED');
    },
    async removeChildren(parentID, retained = new Set()) {
      await this.assertDeletion(parentID);
      await this.cancel(parentID);
      for (const job of jobs.values()) {
        if (job.parentID !== parentID || !job.childID || job.phase === 'deleted' || retained.has(job.sourceID)) continue;
        try { await native.deleteSession(job.childID, job.directory, true); }
        catch (error) { if (!hasHttpErrorFields(error) || error.status !== 404) throw error; }
        await save({ ...job, phase: 'deleted' });
      }
    },
    validateModel,
    async prepareLaunch({ directory, subagentModel = null, child = false }) {
      if (!subagentModel && !child) return null;
      checkPolicy();
      if (subagentModel) await validateModel(subagentModel);
      const context: DelegationContext = {
        ...await prepareTools(subagentModel, child),
        directory,
        selection: subagentModel,
        child,
        sourceID: null,
        parentID: null,
        messageID: null,
        revoked: false,
      };
      return {
        tools: context.tools,
        async bind(sourceID) {
          checkPolicy();
          if (closed || context.revoked) throw failure('The subagent launch was cancelled', 'NATIVE_DELEGATION_INTERRUPTED');
          const entry = await registry.getSession(sourceID);
          checkPolicy();
          if (closed || context.revoked) throw failure('The subagent launch was cancelled', 'NATIVE_DELEGATION_INTERRUPTED');
          if (!entry || entry.directory !== directory || Boolean(entry.delegation) !== child) throw invalidRequestError('The subagent launch does not match its native source');
          context.sourceID = sourceID;
          context.parentID = entry.conversationId ?? sourceID;
          contexts.set(sourceID, context);
        },
        cancel() {
          context.revoked = true;
          if (context.sourceID && contexts.get(context.sourceID) === context) contexts.delete(context.sourceID);
        },
      };
    },
    async prepare(sourceID, request) {
      let entry = await registry.getSession(sourceID);
      const selection = request.subagentModel !== undefined ? request.subagentModel : entry?.agentConfiguration?.subagent;
      const held = contexts.get(sourceID);
      if (entry?.agentConfiguration?.unavailable) throw failure('The subagent configuration is unreadable. Select a combination or reset the subagent selection before sending.');
      if (!selection && !entry?.delegation && !held) return null;
      if (!entry) { await adoptSession(sourceID, request.directory); entry = await registry.getSession(sourceID); }
      if (!entry) throw invalidRequestError('Unknown native session');
      if (selection && !entry.agentConfiguration && !entry.delegation && (await native.getSession(sourceID, request.directory)).parentID) {
        throw failure('Subagents cannot create further subagents', 'NATIVE_DELEGATION_DEPTH');
      }
      if (path.resolve(entry.directory) !== path.resolve(request.directory)) {
        const [registered, requested] = await Promise.all([fs.realpath(entry.directory), fs.realpath(request.directory)]);
        if (registered !== requested) throw invalidRequestError('The subagent directory does not match its parent session');
      }
      if (held && (await native.statuses(request.directory))[sourceID]) {
        if (JSON.stringify(held.selection ?? null) === JSON.stringify(selection ?? null) && held.agent === request.agent) return held.tools;
        throw failure('Wait for the current turn before sending another delegated turn', 'NATIVE_SESSION_BUSY');
      }
      if (!selection && !entry.delegation) { contexts.delete(sourceID); return null; }
      checkPolicy();
      if (selection) await validateModel(selection);
      const child = Boolean(entry.delegation);
      const context: DelegationContext = {
        ...await prepareTools(selection, child, held),
        sourceID,
        parentID: entry.conversationId ?? sourceID,
        directory: request.directory,
        messageID: request.messageID,
        agent: request.agent,
        selection,
        child,
      };
      contexts.set(sourceID, context);
      return context.tools;
    },
    observe(event) {
      const payload = event.payload;
      const status = isRecord(payload.properties.status) ? payload.properties.status : null;
      const sessionID = isString(payload.properties.sessionID) ? payload.properties.sessionID : null;
      if (payload.type !== 'session.status' || status?.type !== 'idle' || !sessionID) return;
      for (const job of jobs.values()) {
        if (job.childID === sessionID) {
          const waiter = waiters.get(job.id);
          if (waiter) { waiter.idle = true; void finish(job.id); }
          onActivity(job.parentID, job.directory);
        }
      }
    },
    async children(parentID) {
      await load();
      const matched = [...jobs.values()].filter(
        (job): job is DelegationJob & { childID: string } => (job.parentID === parentID || job.sourceID === parentID) && Boolean(job.childID) && job.phase !== 'deleted',
      );
      return Promise.all(matched.map(async (job) => ({ ...await native.getSession(job.childID, job.directory), parentID: job.parentID })));
    },
    async cancel(parentID) {
      for (const [id, context] of contexts) if (context.parentID === parentID) { context.revoked = true; contexts.delete(id); }
      for (const request of requests.values()) if (request.context.parentID === parentID) request.context.revoked = true;
      await load();
      const background = await native.backgroundTasks?.() ?? {};
      const active = new Set<string>();
      for (const job of jobs.values()) {
        if (job.parentID === parentID && job.childID) {
          if ((await native.statuses(job.directory))[job.childID] || background[job.childID]?.tasks?.length) active.add(job.id);
        }
      }
      const pending = [...jobs.values()].filter((job) => job.parentID === parentID && (['preparing', 'dispatched'].includes(job.phase) || active.has(job.id)));
      const outcomes = await Promise.allSettled(pending.map(async (job) => {
        const waiter = waiters.get(job.id);
        if (waiter) waiter.cancelled = true;
        waiter?.controller.abort(failure('The parent stopped this subagent', 'NATIVE_DELEGATION_INTERRUPTED'));
        try {
          if (job.childID) await stopChild(job.childID, job.directory);
          await save({ ...job, phase: 'interrupted' });
        } finally {
          waiters.get(job.id)?.reject(failure('The parent stopped this subagent', 'NATIVE_DELEGATION_INTERRUPTED'));
          waiters.delete(job.id);
        }
      }));
      if (outcomes.some((outcome) => outcome.status === 'rejected')) {
        throw failure('Some subagents could not be confirmed stopped. Inspect their tasks before retrying.', 'NATIVE_DELEGATION_STOP_INCOMPLETE');
      }
      return pending.length > 0;
    },
    async shutdown() {
      closed = true;
      contexts.clear();
      for (const pending of waiters.values()) pending.reject(failure('Subagent dispatch interrupted by server shutdown', 'NATIVE_DELEGATION_OUTCOME_UNKNOWN'));
      waiters.clear();
      const activeServer = server;
      activeServer?.closeAllConnections();
      if (activeServer) await new Promise<void>((resolve) => activeServer.close(() => resolve()));
      await writing;
    },
  };

  return delegation;
};
