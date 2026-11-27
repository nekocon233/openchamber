import type { AgyMcpToolCommand } from './mcp-setup.js';
import type { PromptPart } from '../prompt-parts.js';
import type { NativeMessageRecord, NativeSessionRecord } from '../records.js';
import type { NativeEventPublisher } from '../publisher.js';
import type { NativeRegistry, RegistrySendRecordInput } from '../registry.js';
import type { AgyProcessHandle } from './process.js';
import type { AgyCommand, ResolveAgyCommandOptions } from './command.js';
import type { AgyLiveProjection } from './projector.js';
import type { AgyHistoryResult, AgyStore, AgyTaskOutputResult, AgyTaskSnapshot } from './store.js';
import type { AgyCatalogModel } from './catalog.js';
import type { AgyChecklistSnapshot } from './checklist.js';
import type { AgyContextSettingsData, AgyContextSettingsOptions, PreparedAgyContextSettings } from './context-settings.js';
import type { AgyCommandListResult } from './commands.js';
import type { AntigravityProposal } from './decisions.js';
import type { QuotaResult } from '../../quota/utils/contracts.js';

export interface AgyToolConfiguration extends AgyMcpToolCommand {
  key?: string | undefined;
  env?: Record<string, string> | undefined;
  child?: boolean | undefined;
}

export type AgyBackendRegistry = Pick<
  NativeRegistry,
  'getSession' | 'listSessions' | 'sendRecords' | 'bindAntigravityMessage' | 'registerSession' | 'confirmSession' | 'recordSend'
>;

export type AgyBackendPublisher = Pick<
  NativeEventPublisher,
  'records' | 'delta' | 'checklist' | 'emit' | 'session' | 'status' | 'error' | 'tasks'
>;

export interface AgyTurnFinishedSummary {
  id?: string;
  summary: string;
  status: 'completed' | 'interrupted';
}

export interface AgyBackendPromptRequest {
  directory: string;
  messageID: string;
  model: { providerID: string; modelID: string };
  variant?: string | undefined;
  agent: string;
  parts: PromptPart[];
  manualCompaction?: true;
}

export interface CreateAntigravityBackendOptions {
  toolConfiguration?: ((sessionId: string) => AgyToolConfiguration | null | undefined) | undefined;
  resolveExecutable: () => Promise<string | null>;
  resolveNodeExecutable?: (() => Promise<string | null>) | undefined;
  resolveCommand?: ((options: ResolveAgyCommandOptions) => Promise<AgyCommand>) | undefined;
  buildEnv: () => Record<string, string>;
  registry: AgyBackendRegistry;
  publisher: AgyBackendPublisher;
  readGlobalInstructions: () => Promise<string | null | undefined> | string | null | undefined;
  decorateSession: (record: NativeSessionRecord) => Promise<NativeSessionRecord> | NativeSessionRecord;
  onInteraction?: ((proposal: AntigravityProposal) => Promise<void> | void) | undefined;
  onTurnFinished?: ((sessionId: string, directory: string, summary: AgyTurnFinishedSummary) => Promise<void> | void) | undefined;
  now?: (() => number) | undefined;
  home?: string | null | undefined;
  startupTimeoutMs?: number | undefined;
  prepareContextSettings?: ((options: AgyContextSettingsOptions) => Promise<PreparedAgyContextSettings | null>) | undefined;
}

export interface AntigravityBackend {
  store: AgyStore;
  commands: (directory: string, options?: { fresh?: boolean | undefined }) => Promise<AgyCommandListResult>;
  commandParts: (parts: PromptPart[], directory: string) => Promise<PromptPart[]>;
  quota: () => Promise<QuotaResult<'antigravity-cli', 'Antigravity CLI'>>;
  catalog: () => Promise<AgyCatalogModel[]>;
  listRootSessions: (directory: string) => Promise<NativeSessionRecord[]>;
  getSession: (sessionId: string, directory: string) => Promise<NativeSessionRecord | null> | null;
  sessionExists: (sessionId: string, directory?: string) => Promise<boolean> | boolean;
  sessionTasks: (sessionId: string, directory: string) => Promise<AgyTaskSnapshot>;
  checklist: (sessionId: string, directory: string) => Promise<AgyChecklistSnapshot>;
  taskOutput: (sessionId: string, directory: string, taskId: string, generation: string) => Promise<AgyTaskOutputResult>;
  loadHistory: (sessionId: string, directory: string) => Promise<AgyHistoryResult | null>;
  createSession: (input: { directory: string; title?: string | undefined }) => Promise<NativeSessionRecord>;
  prompt: (sessionId: string, request: AgyBackendPromptRequest, signal?: AbortSignal | null) => Promise<void>;
  compact: (sessionId: string, request: Omit<AgyBackendPromptRequest, 'parts' | 'messageID' | 'manualCompaction'> & { instructions?: string | undefined }) => Promise<void>;
  abort: (sessionId: string) => Promise<boolean>;
  whenIdle: (sessionId: string) => Promise<void>;
  closeSession: (sessionId: string) => Promise<void>;
  liveRecords: (sessionId: string) => NativeMessageRecord[];
  childSession: (sessionId: string) => NativeSessionRecord | null;
  busySessionIds: (directory: string) => string[];
  shutdown: () => Promise<void>;
}

interface AgyTurnState {
  projection: AgyLiveProjection;
  send: RegistrySendRecordInput;
  process: AgyProcessHandle | null;
  completion: Promise<void> | null;
  reasoningAfterTool?: boolean;
}

export interface AgySessionState {
  id: string;
  nativeId: string;
  directory: string;
  record: NativeSessionRecord;
  model: string | null;
  agent: 'build' | 'plan' | null;
  effort: string | null;
  process: AgyProcessHandle | null;
  firstPrompt: boolean;
  manualCompactionProcess?: boolean;
  globalInstructions?: string;
  toolKey?: string;
  contextSettings?: AgyContextSettingsData | null;
  turn: AgyTurnState | null;
  lastProjection: AgyLiveProjection | null;
  abortRequested: boolean;
  idleWaiters: Set<() => void>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  queue: Promise<void>;
}
