import type { JsonObject, JsonValue } from '../shared/json-values.js';
import type { NativeBackend } from './ids.js';

export type NativeSessionTime = {
  created: number;
  updated: number;
  archived?: number;
};

export type NativeSessionMetadata = {
  openchamber: {
    native: {
      backend: NativeBackend;
      [key: string]: JsonValue | undefined;
    };
    [key: string]: JsonValue | undefined;
  };
  [key: string]: JsonValue | undefined;
};

export type NativeSessionRecord = {
  id: string;
  slug: string;
  projectID: string;
  directory: string;
  title: string;
  version: string;
  time: NativeSessionTime;
  parentID?: string;
  agent?: string;
  model?: { providerID: string; id: string; variant?: string };
  revert?: { messageID: string };
  metadata: NativeSessionMetadata;
};

export interface BuildSessionRecordInput {
  id: string;
  backend: NativeBackend;
  directory: string;
  title: string;
  created: number;
  updated: number;
  parentID?: string | null | undefined;
  archived?: number | null | undefined;
}

export interface UnconfirmedSessionEntry {
  sessionId: string;
  backend: NativeBackend;
  directory: string;
  createdAt: number;
  title?: string | undefined;
  archivedAt?: number | undefined;
}

export type NativeMessageModel = {
  providerID: string;
  modelID: string;
  variant?: string;
};

export type NativeErrorInfo = {
  name: string;
  data: { message: string };
};

export type NativeTokenUsage = {
  total?: number;
  input: number;
  output: number;
  reasoning: number;
  cache: {
    read: number;
    write: number;
  };
};

export type NativeUserMessage = {
  id: string;
  sessionID: string;
  role: 'user';
  time: { created: number };
  agent: string;
  model: NativeMessageModel;
  metadata?: JsonObject;
};

export type NativeCompactionMessage = {
  id: string;
  sessionID: string;
  role: 'compaction';
  time: { created: number };
  status: string;
  reason: 'auto' | 'manual';
  summary: string;
  error?: NativeErrorInfo;
  metadata?: JsonObject;
};

export type NativeAssistantMessage = {
  id: string;
  sessionID: string;
  role: 'assistant';
  time: { created: number; completed?: number };
  parentID: string;
  modelID: string;
  providerID: string;
  mode: string;
  agent: string;
  path: { cwd: string; root: string };
  tokens?: NativeTokenUsage;
  contextWindow?: number;
  contextCompaction?: JsonValue;
  cost?: number;
  finish?: string;
  variant?: string;
  error?: NativeErrorInfo;
  summary?: boolean;
  metadata?: JsonObject;
};

export type NativeMessageInfo = NativeUserMessage | NativeCompactionMessage | NativeAssistantMessage;

export type NativeTextPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'text';
  text: string;
  time: { start: number; end?: number };
  synthetic?: boolean;
  ignored?: boolean;
  metadata?: JsonObject;
};

export type NativeReasoningPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'reasoning';
  text: string;
  time: { start: number; end?: number };
  metadata?: JsonObject;
};

export type NativeFilePart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'file';
  mime: string;
  url: string;
  filename: string;
  metadata?: JsonObject;
};

export type NativeCompactionPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'compaction';
  auto: boolean;
  metadata?: JsonObject;
};

export type NativeToolResult =
  | { status: 'completed'; output: string; end: number }
  | { status: 'error'; error: string; end: number };

export type NativeToolState =
  | { status: 'running'; input: JsonObject; title: string; metadata: JsonObject; time: { start: number } }
  | { status: 'completed'; input: JsonObject; output: string; title: string; metadata: JsonObject; time: { start: number; end?: number } }
  | { status: 'error'; input: JsonObject; error: string; metadata: JsonObject; time: { start: number; end?: number } };

export type NativeToolPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'tool';
  callID: string;
  tool: string;
  state: NativeToolState;
  metadata: { openchamber: { nativeTool: boolean }; [key: string]: JsonValue | undefined };
};

export type NativePart =
  | NativeTextPart
  | NativeReasoningPart
  | NativeFilePart
  | NativeCompactionPart
  | NativeToolPart;

export type NativeMessageRecord = {
  info: NativeMessageInfo;
  parts: NativePart[];
};

const DEFAULT_UNCONFIRMED_TITLES = {
  claude: 'New Claude Code session',
  codex: 'New Codex session',
  deepseek: 'New DeepSeek session',
  antigravity: 'New Antigravity session',
} satisfies Record<NativeBackend, string>;

export const buildSessionRecord = ({
  id,
  backend,
  directory,
  title,
  created,
  updated,
  parentID = null,
  archived = null,
}: BuildSessionRecordInput): NativeSessionRecord => {
  const time: NativeSessionTime = archived === null ? { created, updated } : { created, updated, archived };
  const record: NativeSessionRecord = {
    id,
    slug: id,
    projectID: '',
    directory,
    title,
    version: `${backend}-cli`,
    time,
    metadata: { openchamber: { native: { backend } } },
  };
  if (parentID !== null) record.parentID = parentID;
  return record;
};

export const unconfirmedSessionRecord = (entry: UnconfirmedSessionEntry): NativeSessionRecord => buildSessionRecord({
  id: entry.sessionId,
  backend: entry.backend,
  directory: entry.directory,
  title: entry.title ?? DEFAULT_UNCONFIRMED_TITLES[entry.backend],
  created: entry.createdAt,
  updated: entry.createdAt,
  archived: entry.archivedAt ?? null,
});

export interface BuildUserMessageInput {
  id: string;
  sessionID: string;
  created: number;
  agent: string;
  model: { providerID: string; modelID: string; variant?: string | undefined };
}

export const buildUserMessage = ({ id, sessionID, created, agent, model }: BuildUserMessageInput): NativeUserMessage => {
  const normalizedModel: NativeMessageModel = model.variant !== undefined
    ? { providerID: model.providerID, modelID: model.modelID, variant: model.variant }
    : { providerID: model.providerID, modelID: model.modelID };
  return {
    id,
    sessionID,
    role: 'user',
    time: { created },
    agent,
    model: normalizedModel,
  };
};

export const EMPTY_TOKENS: Readonly<NativeTokenUsage> = Object.freeze({
  total: 0,
  input: 0,
  output: 0,
  reasoning: 0,
  cache: Object.freeze({ read: 0, write: 0 }),
});

export interface BuildCompactionMessageInput {
  id: string;
  sessionID: string;
  created: number;
  status: string;
  auto: boolean;
  error?: NativeErrorInfo | null | undefined;
}

export const buildCompactionMessage = ({
  id,
  sessionID,
  created,
  status,
  auto,
  error = null,
}: BuildCompactionMessageInput): NativeCompactionMessage => {
  const message: NativeCompactionMessage = {
    id,
    sessionID,
    role: 'compaction',
    time: { created },
    status,
    reason: auto ? 'auto' : 'manual',
    summary: '',
  };
  if (error) message.error = error;
  return message;
};

export interface BuildAssistantMessageInput {
  id: string;
  sessionID: string;
  parentID: string;
  created: number;
  completed: number | null;
  providerID: string;
  modelID: string;
  agent: string;
  cwd: string;
  tokens?: NativeTokenUsage | undefined;
  contextWindow?: number | undefined;
  cost?: number | undefined;
  finish?: string | null | undefined;
  variant?: string | null | undefined;
  error?: NativeErrorInfo | null | undefined;
  summary?: boolean | undefined;
}

export const buildAssistantMessage = ({
  id,
  sessionID,
  parentID,
  created,
  completed,
  providerID,
  modelID,
  agent,
  cwd,
  tokens,
  contextWindow,
  cost,
  finish = null,
  variant = null,
  error = null,
  summary = false,
}: BuildAssistantMessageInput): NativeAssistantMessage => {
  const message: NativeAssistantMessage = {
    id,
    sessionID,
    role: 'assistant',
    time: completed === null ? { created } : { created, completed },
    parentID,
    modelID,
    providerID,
    mode: agent,
    agent,
    path: { cwd, root: cwd },
  };
  if (tokens) {
    message.tokens = {
      input: tokens.input,
      output: tokens.output,
      reasoning: tokens.reasoning,
      cache: { read: tokens.cache.read, write: tokens.cache.write },
    };
    if (tokens.total !== undefined) message.tokens.total = tokens.total;
  }
  if (contextWindow !== undefined && contextWindow > 0) message.contextWindow = contextWindow;
  if (cost !== undefined) message.cost = cost;
  if (finish !== null) message.finish = finish;
  if (variant !== null) message.variant = variant;
  if (error !== null) message.error = error;
  if (summary) message.summary = true;
  return message;
};

export interface BuildTextPartInput {
  id: string;
  sessionID: string;
  messageID: string;
  text: string;
  start: number;
  end: number | null;
  synthetic?: boolean | undefined;
}

export const buildTextPart = ({
  id,
  sessionID,
  messageID,
  text,
  start,
  end,
  synthetic = false,
}: BuildTextPartInput): NativeTextPart => {
  const part: NativeTextPart = {
    id,
    sessionID,
    messageID,
    type: 'text',
    text,
    time: end === null ? { start } : { start, end },
  };
  if (synthetic) part.synthetic = true;
  return part;
};

export interface BuildReasoningPartInput {
  id: string;
  sessionID: string;
  messageID: string;
  text: string;
  start: number;
  end: number | null;
}

export const buildReasoningPart = ({
  id,
  sessionID,
  messageID,
  text,
  start,
  end,
}: BuildReasoningPartInput): NativeReasoningPart => ({
  id,
  sessionID,
  messageID,
  type: 'reasoning',
  text,
  time: end === null ? { start } : { start, end },
});

export interface BuildFilePartInput {
  id: string;
  sessionID: string;
  messageID: string;
  mime: string;
  url: string;
  filename: string;
}

export const buildFilePart = ({
  id,
  sessionID,
  messageID,
  mime,
  url,
  filename,
}: BuildFilePartInput): NativeFilePart => ({
  id,
  sessionID,
  messageID,
  type: 'file',
  mime,
  url,
  filename,
});

export interface BuildCompactionPartInput {
  id: string;
  sessionID: string;
  messageID: string;
  auto: boolean;
}

export const buildCompactionPart = ({
  id,
  sessionID,
  messageID,
  auto,
}: BuildCompactionPartInput): NativeCompactionPart => ({
  id,
  sessionID,
  messageID,
  type: 'compaction',
  auto,
});

export interface BuildToolPartInput {
  id: string;
  sessionID: string;
  messageID: string;
  callID: string;
  tool: string;
  input: JsonObject;
  title: string;
  start: number;
  metadata: JsonObject;
  result: NativeToolResult | null;
}

export const buildToolPart = ({
  id,
  sessionID,
  messageID,
  callID,
  tool,
  input,
  title,
  start,
  metadata,
  result,
}: BuildToolPartInput): NativeToolPart => {
  let state: NativeToolState;
  if (result === null) {
    state = { status: 'running', input, title, metadata, time: { start } };
  } else if (result.status === 'completed') {
    state = { status: 'completed', input, output: result.output, title, metadata, time: { start, end: result.end } };
  } else {
    state = { status: 'error', input, error: result.error, metadata, time: { start, end: result.end } };
  }
  return {
    id,
    sessionID,
    messageID,
    type: 'tool',
    callID,
    tool,
    state,
    metadata: { openchamber: { nativeTool: true } },
  };
};

export const stoppedError = (): NativeErrorInfo => ({ name: 'MessageAbortedError', data: { message: 'aborted' } });
export const unknownError = (message: string): NativeErrorInfo => ({ name: 'UnknownError', data: { message } });
