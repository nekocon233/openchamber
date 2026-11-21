import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { NativeAgentError, invalidRequestError } from './errors.js';
import { newNativeClientUserMessageId } from './ids.js';
import { AGY_PLAN_QUESTION_PREFIX } from './antigravity/interaction-signals.js';
import type { NativeMessageRecord, NativeToolPart } from './records.js';
import type { PromptPart } from './prompt-parts.js';
import type { QuestionOutcome, QuestionRegistry, QuestionRepliedOutcome, QuestionRequest, QuestionToolLink } from './questions.js';

export type PlanExitKind = 'claude-plan-exit' | 'codex-plan-exit' | 'deepseek-plan-exit' | 'antigravity-plan-exit';

export const planExecutionChoiceSchema = z.object({
  model: z.object({ providerID: z.string().min(1), modelID: z.string().min(1) }),
  variant: z.string().min(1).optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
}).strict();

export type PlanExecutionChoice = z.infer<typeof planExecutionChoiceSchema>;

const requestIdentity = z.object({
  id: z.string().min(1),
  sessionID: z.string().min(1),
  kind: z.enum(['claude-plan-exit', 'codex-plan-exit', 'deepseek-plan-exit', 'antigravity-plan-exit']),
  tool: z.object({ messageID: z.string().min(1), callID: z.string().min(1) }),
});

export const planExecutionStateSchema = z.object({
  request: requestIdentity,
  source: planExecutionChoiceSchema,
  execution: planExecutionChoiceSchema,
  phase: z.enum(['open', 'preparing', 'dispatching', 'settled']),
  messageID: z.string().min(1),
  logicalMessageID: z.string().min(1),
}).or(z.object({ phase: z.literal('unavailable') }));

export type PlanExecutionState = z.infer<typeof planExecutionStateSchema>;
export type PlanExecutionActiveState = Exclude<PlanExecutionState, { phase: 'unavailable' }>;
export type PlanExecutionResult = { execution: PlanExecutionChoice } | undefined;

export type PlanReference = {
  tool: QuestionToolLink;
  plan: string;
};

export interface PlanReferenceRequest {
  kind?: PlanExitKind | undefined;
  tool?: QuestionToolLink | undefined;
}

export interface PlanExecutionContext {
  request: QuestionRequest;
  directory: string;
  transferred: boolean;
}

export interface PlanExecutionActions {
  transfer: () => Promise<void>;
  deliver: () => Promise<void> | void;
  link?: ((tool: QuestionToolLink) => void) | undefined;
  isCurrent?: (() => boolean) | undefined;
  pending: (executionPending?: PlanExecutionChoice) => void;
}

export interface PlanExecutionContinuation {
  directory: string;
  messageID: string;
  parts: PromptPart[];
  model: { providerID: string; modelID: string };
  variant?: string | undefined;
  agent: 'build' | 'plan';
  preserveSelection: boolean;
  instructions?: string | undefined;
}

export interface PlanExecutionPromptCallbacks {
  requestId: string;
  logicalMessageId: string;
  expectedRevision?: number | undefined;
  onDispatched: () => Promise<void>;
  onRefused: () => Promise<void>;
}

export interface PlanExecutionRegistry {
  getSession: (sessionId: string) => Promise<{ planExecution?: PlanExecutionState | undefined } | null>;
  updateSession: (sessionId: string, patch: { planExecution: PlanExecutionState }) => Promise<{ nativeId: string } | null>;
  listSessions: (filter: { directory: string }) => Promise<Array<{ sessionId: string; planExecution?: PlanExecutionState | undefined }>>;
}

export interface NativePlanExecutionOptions {
  registry: PlanExecutionRegistry;
  questions: QuestionRegistry;
  interactions: { record: (request: QuestionRequest, outcome: QuestionOutcome) => Promise<void> };
  sourceSelection: (sessionId: string, directory: string) => Promise<PlanExecutionChoice>;
  validate: (
    sessionId: string,
    directory: string,
    requestId: string,
    execution: PlanExecutionChoice,
    handoff: boolean,
    approves: boolean,
  ) => Promise<void>;
  readHistory: (sessionId: string, directory: string, request: PlanReferenceRequest) => Promise<NativeMessageRecord[]>;
  yieldSource: (sessionId: string, directory: string, signal: AbortSignal) => Promise<void>;
  prompt: (
    sessionId: string,
    continuation: PlanExecutionContinuation,
    signal: AbortSignal,
    callbacks: PlanExecutionPromptCallbacks,
  ) => Promise<void>;
  confirm: (sessionId: string, directory: string, state: PlanExecutionActiveState) => Promise<'accepted' | 'not-dispatched' | 'unknown'>;
  failed: (directory: string, sessionId: string, cause: unknown) => void;
}

export interface NativePlanExecution {
  execute: (context: PlanExecutionContext, outcome: QuestionRepliedOutcome, actions: PlanExecutionActions) => Promise<PlanExecutionResult>;
  restore: (directory: string) => Promise<void>;
  beforePrompt: (sessionId: string, messageId: string) => Promise<void>;
  settled: (request: QuestionRequest, outcome: QuestionOutcome) => Promise<void>;
  cancel: (sessionId: string) => Promise<boolean>;
  shutdown: () => Promise<void>;
}

const planInput = z.object({ plan: z.string().optional() });
const questionInput = z.object({ questions: z.array(z.object({ question: z.string() })) });
const sameModel = (left: PlanExecutionChoice, right: PlanExecutionChoice): boolean => left.model.providerID === right.model.providerID
  && left.model.modelID === right.model.modelID && left.variant === right.variant;
const unavailable = (): NativeAgentError => new NativeAgentError('The original plan is unavailable. Reload the conversation before retrying.', {
  status: 409, code: 'NATIVE_PLAN_EXECUTION_UNAVAILABLE',
});
const unknown = (): NativeAgentError => new NativeAgentError('The plan execution may have been accepted. Check its history before retrying.', {
  status: 409, code: 'NATIVE_PROMPT_OUTCOME_UNKNOWN',
});

export const readNativePlanReference = (
  request: PlanReferenceRequest,
  records: ReadonlyArray<NativeMessageRecord>,
): PlanReference => {
  const explicit: Array<{ record: NativeMessageRecord; part: NativeToolPart }> = [];
  for (const record of records) {
    for (const part of record.parts) {
      if (part.type === 'tool' && (
        part.tool === 'plan_exit' || (request.tool !== undefined && part.callID === request.tool.callID && part.tool === 'question')
      )) {
        explicit.push({ record, part });
      }
    }
  }
  const reference = request.tool
    ? explicit.find(({ part }) => part.callID === request.tool?.callID)
    : explicit.findLast(({ record }) => {
      const lastUser = records.findLast((entry) => entry.info.role === 'user');
      return !lastUser || record.info.time.created >= lastUser.info.time.created;
    });
  if (!reference) throw unavailable();
  let plan = planInput.safeParse(reference.part.state.input).data?.plan
    ?? questionInput.safeParse(reference.part.state.input).data?.questions[0]?.question ?? '';
  if (request.kind === 'antigravity-plan-exit' && plan.startsWith(AGY_PLAN_QUESTION_PREFIX)) plan = plan.slice(AGY_PLAN_QUESTION_PREFIX.length);
  return {
    tool: { messageID: reference.record.info.id, callID: reference.part.callID },
    plan,
  };
};

export const createNativePlanExecution = ({
  registry,
  questions,
  interactions,
  sourceSelection,
  validate,
  readHistory,
  yieldSource,
  prompt,
  confirm,
  failed,
}: NativePlanExecutionOptions): NativePlanExecution => {
  const active = new Map<string, AbortController>();
  let closed = false;
  const save = async (sessionId: string, state: PlanExecutionActiveState): Promise<PlanExecutionActiveState> => {
    if (!await registry.updateSession(sessionId, { planExecution: state })) throw unavailable();
    return state;
  };

  const execute = async (
    context: PlanExecutionContext,
    outcome: QuestionRepliedOutcome,
    actions: PlanExecutionActions,
  ): Promise<PlanExecutionResult> => {
    const { request, directory } = context;
    const firstList = outcome.answers[0];
    const firstAnswer = firstList?.[0];
    if (outcome.answers.length !== 1 || !firstList || firstList.length !== 1 || !firstAnswer?.trim()) {
      throw invalidRequestError('Choose a plan action or provide feedback');
    }
    const existing = (await registry.getSession(request.sessionID))?.planExecution;
    if (existing?.phase === 'unavailable') throw unavailable();
    const state: PlanExecutionActiveState | null = existing && existing.request.id === request.id ? existing : null;
    if (closed) throw new NativeAgentError('Native plan execution is shutting down', { status: 503, code: 'NATIVE_UNAVAILABLE' });
    const approves = firstAnswer === 'build';
    if (state?.phase === 'dispatching') {
      const delivery = await confirm(request.sessionID, directory, state);
      if (delivery === 'not-dispatched') {
        await save(request.sessionID, { ...state, phase: 'open' });
        actions.pending();
        throw new NativeAgentError('The previous execution was not sent. Select the execution model and approve the plan again.', {
          status: 409, code: 'NATIVE_PLAN_EXECUTION_RETRYABLE',
        });
      }
      if (!outcome.execution || !sameModel(state.execution, outcome.execution) || delivery !== 'accepted') throw unknown();
      await save(request.sessionID, { ...state, phase: 'settled' });
      return { execution: state.execution };
    }
    if (!approves && firstAnswer === 'plan') {
      if (state) await save(request.sessionID, { ...state, phase: 'settled' });
      return undefined;
    }
    if (!approves && !context.transferred) throw invalidRequestError('An execution model requires approval');
    const source = state?.source ?? planExecutionChoiceSchema.parse(await sourceSelection(request.sessionID, directory));
    const execution = approves ? planExecutionChoiceSchema.parse(outcome.execution) : source;
    const handoff = context.transferred || Boolean(state) || !sameModel(source, execution);
    await validate(request.sessionID, directory, request.id, execution, handoff, approves);
    if (actions.isCurrent && !actions.isCurrent()) throw new NativeAgentError('The plan approval is no longer pending', { status: 404, code: 'NATIVE_QUESTION_NOT_FOUND' });
    if (!handoff) {
      await interactions.record(request, outcome);
      await actions.deliver();
      return { execution };
    }
    const history = await readHistory(request.sessionID, directory, request);
    const reference = readNativePlanReference(request, history);
    actions.link?.(reference.tool);
    const identity = requestIdentity.parse({ ...request, tool: reference.tool });
    const fresh = !state || !sameModel(state.execution, execution);
    const controller = new AbortController();
    active.set(request.sessionID, controller);
    let nextState: PlanExecutionActiveState;
    try {
      if (actions.isCurrent && !actions.isCurrent()) throw new NativeAgentError('The plan approval is no longer pending', { status: 404, code: 'NATIVE_QUESTION_NOT_FOUND' });
      nextState = await save(request.sessionID, {
        request: identity,
        source,
        execution,
        phase: 'preparing',
        messageID: fresh ? newNativeClientUserMessageId(request.sessionID) : state.messageID,
        logicalMessageID: fresh ? `ncv_u_${randomUUID()}` : state.logicalMessageID,
      });
    } catch (error) {
      active.delete(request.sessionID);
      throw error;
    }
    let dispatched = false;
    try {
      controller.signal.throwIfAborted();
      if (actions.isCurrent && !actions.isCurrent()) throw new NativeAgentError('The plan approval is no longer pending', { status: 404, code: 'NATIVE_QUESTION_NOT_FOUND' });
      await interactions.record(request, outcome);
      await actions.transfer();
      await yieldSource(request.sessionID, directory, controller.signal);
      controller.signal.throwIfAborted();
      const continuation: PlanExecutionContinuation = {
        directory,
        messageID: nextState.messageID,
        parts: approves ? [] : [{ type: 'text', text: firstAnswer }],
        model: execution.model,
        variant: execution.variant,
        agent: approves ? 'build' : 'plan',
        preserveSelection: true,
      };
      if (approves) {
        continuation.instructions = [
          'The user approved the plan in this conversation. Implement that approved plan using the selected model.',
          request.questions[0]?.question || reference.plan,
        ].filter(Boolean).join('\n\n');
      }
      await prompt(request.sessionID, continuation, controller.signal, {
        requestId: request.id,
        logicalMessageId: nextState.logicalMessageID,
        expectedRevision: approves ? execution.expectedRevision : undefined,
        onDispatched: async () => {
          if (dispatched) return;
          controller.signal.throwIfAborted();
          nextState = await save(request.sessionID, { ...nextState, phase: 'dispatching' });
          dispatched = true;
        },
        onRefused: async () => {
          nextState = await save(request.sessionID, { ...nextState, phase: 'open' });
          dispatched = false;
        },
      });
      await save(request.sessionID, { ...nextState, phase: 'settled' });
      return approves ? { execution } : undefined;
    } catch (error) {
      const uncertain = dispatched;
      const cancelled = !closed && controller.signal.aborted || Boolean(actions.isCurrent && !actions.isCurrent());
      try {
        await save(request.sessionID, { ...nextState, phase: uncertain ? 'dispatching' : cancelled ? 'settled' : 'open' });
      } catch {
        actions.pending(execution);
        throw unknown();
      }
      if (uncertain) {
        actions.pending(execution);
        throw unknown();
      }
      throw error;
    } finally {
      if (active.get(request.sessionID) === controller) active.delete(request.sessionID);
    }
  };

  return {
    execute,
    async restore(directory) {
      for (const entry of await registry.listSessions({ directory })) {
        let state = entry.planExecution;
        if (state?.phase === 'unavailable') { failed(directory, entry.sessionId, unavailable()); continue; }
        if (!state || state.phase === 'settled' || active.has(entry.sessionId)) continue;
        try {
          if (state.phase === 'preparing') state = await save(entry.sessionId, { ...state, phase: 'open' });
          if (questions.get(state.request.id)) continue;
          if (state.phase === 'dispatching') {
            const delivery = await confirm(entry.sessionId, directory, state);
            if (active.has(entry.sessionId) || questions.get(state.request.id)) continue;
            if (delivery === 'not-dispatched') state = await save(entry.sessionId, { ...state, phase: 'open' });
          }
          const records = await readHistory(entry.sessionId, directory, state.request);
          const reference = readNativePlanReference(state.request, records);
          const askInput = {
            ...state.request,
            directory,
            transferred: true,
            questions: [{ question: reference.plan, header: 'Plan', options: [{ label: 'build', description: '' }, { label: 'plan', description: '' }], multiple: false }],
            executionPending: state.phase === 'dispatching' ? state.execution : undefined,
          };
          if (active.has(entry.sessionId) || questions.get(state.request.id)) continue;
          void questions.ask(askInput).catch((error) => failed(directory, entry.sessionId, error));
        } catch (error) { failed(directory, entry.sessionId, error); }
      }
    },
    async beforePrompt(sessionId, messageId) {
      const state = (await registry.getSession(sessionId))?.planExecution;
      if (state?.phase === 'unavailable') throw unavailable();
      if (!state || state.phase === 'settled' || state.messageID === messageId) return;
      if (state.phase === 'dispatching') throw unknown();
      if (state.phase === 'preparing') throw new NativeAgentError('The approved plan is preparing execution', { status: 409, code: 'NATIVE_SESSION_BUSY' });
      await save(sessionId, { ...state, phase: 'settled' });
      questions.withdraw(state.request.id, { status: 'rejected' });
    },
    async settled(request, outcome) {
      if (outcome.status !== 'rejected') return;
      active.get(request.sessionID)?.abort(new Error('Plan execution cancelled'));
      if (active.has(request.sessionID)) return;
      const state = (await registry.getSession(request.sessionID))?.planExecution;
      if (state?.phase === 'unavailable') return;
      if (state?.request.id === request.id && state.phase !== 'dispatching') await save(request.sessionID, { ...state, phase: 'settled' });
    },
    async cancel(sessionId) {
      const controller = active.get(sessionId);
      controller?.abort(new Error('Plan execution cancelled'));
      const state = (await registry.getSession(sessionId))?.planExecution;
      if (state?.phase === 'unavailable') return false;
      if (!state || state.phase === 'settled') return Boolean(controller);
      if (!controller && state.phase !== 'dispatching') await save(sessionId, { ...state, phase: 'settled' });
      if (questions.get(state.request.id)) await questions.reject(state.request.id);
      return true;
    },
    async shutdown() {
      closed = true;
      for (const controller of active.values()) controller.abort(new Error('Native plan execution is shutting down'));
    },
  };
};
