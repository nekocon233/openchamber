import { z } from 'zod';
import type { JsonObject, JsonValue } from '../../shared/json-values.js';
import { buildSessionRecord } from '../records.js';
import { type CodexPlanTodos, type CodexPlanTodosSnapshot } from './plan-todos.js';
import { type CodexProjectedPart, type CodexProjectedRecord, type CodexSendRecord } from './projector.js';
import { type JsonRpcRequest } from './rpc.js';
import { type CodexItemTime, type CodexTurnDetails } from './history-details.js';
import type { CodexPlan } from './plan-decisions.js';
import type { CodexThreadTools, CodexThreadToolConfig } from './live.js';

export const APPROVAL_POLICY = 'never';

export const FULL_ACCESS_SANDBOX = 'danger-full-access';

const jsonValueSchema = z.custom<JsonValue>(() => true);

export const turnParams = z.object({
  threadId: z.string(),
  turn: z.object({
    id: z.string(),
    status: z.string(),
    error: z.object({ message: z.string() }).passthrough().nullish(),
    startedAt: z.number().nullish(),
    completedAt: z.number().nullish(),
  }).passthrough(),
}).passthrough();

export const itemParams = z.object({
  threadId: z.string(),
  turnId: z.string(),
  startedAtMs: z.number().nullish(),
  completedAtMs: z.number().nullish(),
  item: z.object({ id: z.string(), type: z.string() }).catchall(jsonValueSchema),
}).passthrough();

export const textDeltaParams = z.object({
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
  delta: z.string(),
}).passthrough();

export const indexedDeltaParams = textDeltaParams.extend({
  summaryIndex: z.number().optional(),
  contentIndex: z.number().optional(),
});

export const threadStatusParams = z.object({ threadId: z.string(), status: z.object({ type: z.string() }).passthrough() }).passthrough();

export const childThreadStartedParams = z.object({
  thread: z.object({
    id: z.string().min(1),
    parentThreadId: z.string().min(1),
    cwd: z.string().min(1),
    name: z.string().nullish(),
    preview: z.string().optional(),
    agentNickname: z.string().nullish(),
    model: z.string().nullish(),
    createdAt: z.number(),
    updatedAt: z.number(),
    status: z.object({ type: z.enum(['active', 'idle', 'notLoaded', 'systemError']) }),
  }),
});

export const threadClosedParams = z.object({ threadId: z.string() });

export const planParams = z.object({
  threadId: z.string(),
  turnId: z.string().optional(),
  plan: z.array(z.object({ step: z.string(), status: z.string() }).passthrough()),
}).passthrough();

export const startedTurn = z.object({ turn: z.object({ id: z.string() }).passthrough() }).passthrough();

export const resumedThread = z.object({
  serviceTier: z.string().nullish(),
  modelProvider: z.string().nullish().catch(null),
}).passthrough();

export const userInputRequest = z.object({
  threadId: z.string(),
  itemId: z.string(),
  questions: z.array(z.object({
    id: z.string(),
    header: z.string(),
    question: z.string(),
    options: z.array(z.object({ label: z.string(), description: z.string() }).passthrough()).nullish(),
  }).passthrough()),
}).passthrough();

export const skillInput = z.object({ type: z.literal('skill'), name: z.string(), path: z.string() });

export interface CodexLiveConfig {
  model: string | null;
  effort: string | null;
  serviceTier: string;
  mode: 'default' | 'plan';
  providerId?: string | null | undefined;
}

export type CodexUserInputItem =
  | { type: 'text'; text: string }
  | { type: 'localImage'; path: string }
  | { type: 'image'; url: string }
  | { type: 'skill'; name: string; path: string }
  | JsonObject;

export type CodexReviewTarget =
  | { type: 'uncommittedChanges' }
  | { type: 'baseBranch'; branch: string }
  | { type: 'commit'; sha: string }
  | { type: 'custom'; instructions: string }
  | JsonObject;

export interface CodexLiveTurnSummary {
  id: string;
  summary: string;
  status: string;
}

export interface CodexLivePublisher {
  records(directory: string, sessionId: string, records: Iterable<CodexProjectedRecord>): void;
  part(directory: string, sessionId: string, part: CodexProjectedPart): void;
  delta(directory: string, delta: { sessionID: string; messageID: string; partID: string; field: string; delta: string }): void;
  status(directory: string, sessionId: string, type: 'busy' | 'idle'): void;
  error(directory: string, sessionId: string, error: { name: string; data: { message: string } }): void;
  session(directory: string, info: ReturnType<typeof buildSessionRecord>, options: { created: boolean }): void;
  todos(directory: string, sessionId: string, snapshot: CodexPlanTodosSnapshot): void;
  emit(directory: string, type: string, properties: JsonObject): void;
  forget(sessionId: string): void;
}

export type CodexLiveQuestionOutcome =
  | { status: 'replied' | 'transferred'; answers: string[][] }
  | { status: 'rejected'; reason?: string | undefined };

export interface CodexLiveQuestionAskInput {
  directory: string;
  sessionID: string;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiple: boolean;
  }>;
  tool?: { messageID: string; callID: string };
}

export interface CodexLiveQuestionRegistry {
  ask(input: CodexLiveQuestionAskInput): Promise<CodexLiveQuestionOutcome>;
  rejectSession(sessionId: string): void;
}

export interface CodexLiveThreadsOptions {
  toolConfiguration?: ((sessionId: string) => CodexThreadTools | null | undefined) | undefined;
  request: JsonRpcRequest;
  readGlobalInstructions?: (() => Promise<string | null>) | undefined;
  readTurnDetails?: ((sessionId: string, turnId: string) => Promise<CodexTurnDetails | null>) | undefined;
  publisher: CodexLivePublisher;
  questions: CodexLiveQuestionRegistry;
  onTurnFinished?: ((sessionId: string, directory: string, turn: CodexLiveTurnSummary) => void) | undefined;
  onIdle?: ((sessionId: string, directory: string) => void) | undefined;
  onPlanReady?: ((plan: CodexPlan) => void) | undefined;
  onSessionClosed?: ((sessionId: string) => void) | undefined;
  now?: (() => number) | undefined;
}

export interface CodexLivePromptInput {
  sessionId: string;
  directory: string;
  messageId: string;
  input: readonly CodexUserInputItem[];
  config: CodexLiveConfig;
  send: CodexSendRecord;
  signal?: AbortSignal | undefined;
}

export interface CodexLiveReviewInput {
  sessionId: string;
  directory: string;
  target: CodexReviewTarget;
  config: CodexLiveConfig;
}

export type LiveItem = z.infer<typeof itemParams>['item'];

type SkillInput = z.infer<typeof skillInput>;

export type TurnError = { message: string };

export interface LiveTurn {
  id: string;
  items: Map<string, LiveItem>;
  itemTimes: Map<string, CodexItemTime>;
  order: string[];
  status: string;
  error: TurnError | null;
  startedAt: number;
  completedAt: number | null;
  planningSend: CodexSendRecord | null;
  detail: CodexTurnDetails;
}

export interface LiveThread {
  threadId: string;
  sessionId: string;
  directory: string;
  loaded: boolean;
  serviceTier: string | null;
  modelProvider: string | null;
  toolKey: string;
  busy: boolean;
  turn: LiveTurn | null;
  config: CodexLiveConfig | null;
  pendingPlanningSend: CodexSendRecord | null;
  childSession: ReturnType<typeof buildSessionRecord> | null;
  sends: Map<string, CodexSendRecord>;
  messageOfPart: Map<string, string>;
  idleWaiters: Array<() => void>;
  todos: CodexPlanTodos;
  pendingSkills: SkillInput[];
  telemetryRevision: number;
}

export type ThreadResumeParams = {
  threadId: string;
  excludeTurns: true;
  approvalPolicy: typeof APPROVAL_POLICY;
  sandbox: typeof FULL_ACCESS_SANDBOX;
  developerInstructions?: string;
  config?: CodexThreadToolConfig;
};

export type TurnStartParams = {
  threadId: string;
  input: CodexUserInputItem[];
  clientUserMessageId: string;
  cwd: string;
  approvalPolicy: typeof APPROVAL_POLICY;
  sandboxPolicy: { type: 'dangerFullAccess' };
  summary: 'auto';
  effort?: string;
  model?: string;
  collaborationMode?: {
    mode: 'default' | 'plan';
    settings: { model: string; reasoning_effort: string | null; developer_instructions: null };
  };
  serviceTier?: string;
};
