import { claudeConnectionListSchema, claudeConnectionSchema, cliproxyapiCancelResultSchema, cliproxyapiImportResultSchema, cliproxyapiLoginSchema, cliproxyapiModelsSchema, cliproxyapiLoginStatusSchema, cliproxyapiRemovedSchema, cliproxyapiStatusSchema, codexConnectionListSchema, codexConnectionSchema, type ClaudeConnectionWrite, type CliproxyapiConnectionWrite, type CodexConnectionWrite } from '@openchamber/ui/lib/native-agents/connections';
import type { NativeAgentsAPI, NativeCodexCommandRequest, NativeCompactRequest, NativePromptRequest, NativeSessionPatch } from '@openchamber/ui/lib/api/types';
import type { NativeBackend } from '@openchamber/ui/lib/native-agents/ids';
import { NativeAgentsRequestError } from '@openchamber/ui/lib/native-agents/errors';
import {
  nativeAbortResultSchema,
  nativeBackgroundTaskSnapshotSchema,
  nativeCapabilitiesSchema,
  nativeCatalogSchema,
  nativeChatDirectoriesSchema,
  nativeCommandListSchema,
  nativeCodexCommandResultSchema,
  nativeDeleteResultSchema,
  nativeMessagePageSchema,
  nativePromptAcceptedSchema,
  nativeQuestionListSchema,
  nativeQuestionRejectedSchema,
  nativeQuestionRepliedSchema,
  nativeRevertResultSchema,
  nativeSessionListSchema,
  nativeSessionSchema,
  nativeStatusSnapshotSchema,
} from '@openchamber/ui/lib/native-agents/schemas';
import {
  nativeChecklistSnapshotSchema,
  nativePlanSnapshotSchema,
  nativeTaskOutputSchema,
  nativeTaskSnapshotSchema,
  nativeTaskStopResultSchema,
  nativeTodosSnapshotSchema,
} from '@openchamber/ui/lib/native-agents/task-schemas';
import { runtimeFetch } from '@openchamber/ui/lib/runtime-fetch';
import { z } from 'zod';
import { nativeMemoryStatusSchema, nativeMemoryConnectionSchema } from '@openchamber/ui/lib/native-agents/memory-schemas';

// Matches the OpenCode read deadline: a half-open socket must not hold a
// bootstrap or history read forever.
const NATIVE_READ_TIMEOUT_MS = 30_000;

const errorBodySchema = z.object({ error: z.string().optional(), code: z.string().optional() }).passthrough();

type NativeWriteBody =
  | { sourceId: string; directory: string }
  | { upstreamProxy: string | null }
  | CliproxyapiConnectionWrite
  | ClaudeConnectionWrite
  | CodexConnectionWrite
  | { backend: NativeBackend; directory: string; title?: string }
  | NativePromptRequest
  | NativeCompactRequest
  | NativeCodexCommandRequest
  | { answers: string[][] }
  | { directory: string; messageID?: string }
  | { directory: string; generation: string }
  | ({ directory: string } & NativeSessionPatch);

type NativeWrite =
  | { method: 'POST' | 'PATCH'; body?: NativeWriteBody }
  | { method: 'DELETE'; query: Record<string, string> };

const failure = async (response: Response): Promise<NativeAgentsRequestError> => {
  const parsed = errorBodySchema.safeParse(await response.json().catch(() => null));
  return new NativeAgentsRequestError(
    parsed.data?.error ?? `Native session request failed (${response.status})`,
    response.status,
    parsed.data?.code ?? null,
  );
};

/**
 * Fetches an OpenChamber native route and parses its body. Failures, the
 * deadline and the caller's signal all throw. The deadline covers the body.
 */
const readParsed = async <T>(
  path: string,
  query: Record<string, string>,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T> => {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener('abort', abortFromCaller, { once: true });
  const deadline = setTimeout(() => controller.abort(new DOMException(
    `Native session request timed out after ${NATIVE_READ_TIMEOUT_MS}ms`,
    'TimeoutError',
  )), NATIVE_READ_TIMEOUT_MS);
  try {
    const response = await runtimeFetch(path, { query, signal: controller.signal });
    if (!response.ok) throw await failure(response);
    return schema.parse(await response.json());
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', abortFromCaller);
  }
};

/**
 * Sends a write to a native route and parses the answer. Writes carry no
 * deadline: a prompt the server accepted after a client-side timeout would be
 * sent twice by a retry.
 */
const sendParsed = async <T>(path: string, schema: z.ZodType<T>, write: NativeWrite): Promise<T> => {
  const response = await runtimeFetch(path, write.method === 'DELETE'
    ? { method: 'DELETE', query: write.query, headers: { Accept: 'application/json' } }
    : {
      method: write.method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(write.body ?? {}),
    });
  if (!response.ok) throw await failure(response);
  return schema.parse(await response.json());
};

const writeParsed = <T>(path: string, schema: z.ZodType<T>, body?: NativeWriteBody): Promise<T> => (
  sendParsed(path, schema, { method: 'POST', body })
);

const sessionPath = (sessionId: string) => `/api/native/sessions/${encodeURIComponent(sessionId)}`;
const questionPath = (requestId: string) => `/api/native/questions/${encodeURIComponent(requestId)}`;

export const createWebNativeAgentsAPI = (): NativeAgentsAPI => ({
  supported: true,
  memoryStatus: (directory, options) => readParsed('/api/native/memory', directory ? { directory } : {}, nativeMemoryStatusSchema, options?.signal),
  connectMemory: (backend) => writeParsed(`/api/native/memory/${backend}/connect`, nativeMemoryConnectionSchema),
  disconnectMemory: (backend) => sendParsed(`/api/native/memory/${backend}`, nativeMemoryConnectionSchema, { method: 'DELETE', query: {} }),
  importMemory: async (sourceId, directory) => { await writeParsed('/api/native/memory/import', z.object({ imported: z.literal(true), memoryId: z.string() }), { sourceId, directory }); },
  capabilities: () => readParsed('/api/native/capabilities', {}, nativeCapabilitiesSchema),
  catalog: () => readParsed('/api/native/catalog', {}, nativeCatalogSchema),
  cliproxyapiStatus: () => readParsed('/api/native/claude/cliproxyapi', {}, cliproxyapiStatusSchema),
  startCliproxyapiGateway: () => sendParsed('/api/native/claude/cliproxyapi/start', cliproxyapiStatusSchema, { method: 'POST' }),
  stopCliproxyapiGateway: () => sendParsed('/api/native/claude/cliproxyapi/stop', cliproxyapiStatusSchema, { method: 'POST' }),
  setCliproxyapiProxy: (input) => sendParsed('/api/native/claude/cliproxyapi/proxy', cliproxyapiStatusSchema, { method: 'POST', body: input }),
  beginCliproxyapiLogin: () => sendParsed('/api/native/claude/cliproxyapi/login', cliproxyapiLoginSchema, { method: 'POST' }),
  cliproxyapiLoginStatus: (state) => readParsed(`/api/native/claude/cliproxyapi/login/${encodeURIComponent(state)}`, {}, cliproxyapiLoginStatusSchema),
  cancelCliproxyapiLogin: async (state) => (await sendParsed(`/api/native/claude/cliproxyapi/login/${encodeURIComponent(state)}`, cliproxyapiCancelResultSchema, { method: 'DELETE', query: {} })).cancelled,
  removeCliproxyapiAccount: async (name) => { await sendParsed(`/api/native/claude/cliproxyapi/accounts/${encodeURIComponent(name)}`, cliproxyapiRemovedSchema, { method: 'DELETE', query: {} }); },
  saveCliproxyapiConnection: (input) => sendParsed('/api/native/claude/cliproxyapi/connection', claudeConnectionSchema, { method: 'POST', body: input }),
  cliproxyapiModels: () => readParsed('/api/native/claude/cliproxyapi/models', {}, cliproxyapiModelsSchema),
  importCliproxyapiModels: () => sendParsed('/api/native/claude/cliproxyapi/import', cliproxyapiImportResultSchema, { method: 'POST' }),
  listClaudeConnections: () => readParsed('/api/native/claude/connections', {}, claudeConnectionListSchema),
  saveClaudeConnection: (id, body) => sendParsed(
    id ? `/api/native/claude/connections/${encodeURIComponent(id)}` : '/api/native/claude/connections',
    claudeConnectionSchema,
    { method: id ? 'PATCH' : 'POST', body },
  ),
  deleteClaudeConnection: async (id) => {
    await sendParsed(`/api/native/claude/connections/${encodeURIComponent(id)}`, nativeDeleteResultSchema, { method: 'DELETE', query: {} });
  },
  listCodexConnections: () => readParsed('/api/native/codex/connections', {}, codexConnectionListSchema),
  saveCodexConnection: (id, body) => sendParsed(
    id ? `/api/native/codex/connections/${encodeURIComponent(id)}` : '/api/native/codex/connections',
    codexConnectionSchema,
    { method: id ? 'PATCH' : 'POST', body },
  ),
  deleteCodexConnection: async (id) => {
    await sendParsed(`/api/native/codex/connections/${encodeURIComponent(id)}`, nativeDeleteResultSchema, { method: 'DELETE', query: {} });
  },
  codexCommand: (request) => writeParsed('/api/native/codex/command', nativeCodexCommandResultSchema, request),
  commands: (backend, directory, options) => readParsed(
    '/api/native/commands',
    { backend, directory },
    nativeCommandListSchema,
    options?.signal,
  ),
  listSessions: (directory, options) => readParsed(
    '/api/native/sessions',
    { directory },
    nativeSessionListSchema,
    options?.signal,
  ),
  chatDirectories: async (options) => (await readParsed(
    '/api/native/chat-directories',
    {},
    nativeChatDirectoriesSchema,
    options?.signal,
  )).directories,
  getSession: (sessionId, directory, options) => readParsed(
    sessionPath(sessionId),
    { directory },
    nativeSessionSchema,
    options?.signal,
  ),
  loadMessages: (sessionId, directory, page) => readParsed(
    `${sessionPath(sessionId)}/messages`,
    page.before === undefined
      ? { directory, limit: String(page.limit) }
      : { directory, limit: String(page.limit), before: page.before },
    nativeMessagePageSchema,
  ),
  statuses: (directory, options) => readParsed(
    '/api/native/sessions/status',
    { directory },
    nativeStatusSnapshotSchema,
    options?.signal,
  ),
  backgroundTasks: (options) => readParsed(
    '/api/native/sessions/background',
    {},
    nativeBackgroundTaskSnapshotSchema,
    options?.signal,
  ),
  checklist: (sessionId, directory, options) => readParsed(
    `${sessionPath(sessionId)}/checklist`,
    { directory },
    nativeChecklistSnapshotSchema,
    options?.signal,
  ),
  plan: (sessionId, directory, options) => readParsed(
    `${sessionPath(sessionId)}/plan`,
    { directory },
    nativePlanSnapshotSchema,
    options?.signal,
  ),
  codexTodos: (sessionId, directory, options) => readParsed(
    `${sessionPath(sessionId)}/todos`,
    { directory },
    nativeTodosSnapshotSchema,
    options?.signal,
  ),
  sessionTasks: (sessionId, directory, options) => readParsed(
    `${sessionPath(sessionId)}/tasks`,
    { directory },
    nativeTaskSnapshotSchema,
    options?.signal,
  ),
  taskOutput: (sessionId, taskId, directory, generation, options) => readParsed(
    `${sessionPath(sessionId)}/tasks/${encodeURIComponent(taskId)}/output`,
    { directory, generation },
    nativeTaskOutputSchema,
    options?.signal,
  ),
  stopTask: async (sessionId, taskId, directory, generation) => {
    await writeParsed(
      `${sessionPath(sessionId)}/tasks/${encodeURIComponent(taskId)}/stop`,
      nativeTaskStopResultSchema,
      { directory, generation },
    );
  },
  questions: (directory, options) => readParsed(
    '/api/native/questions',
    { directory },
    nativeQuestionListSchema,
    options?.signal,
  ),
  createSession: (input) => writeParsed('/api/native/sessions', nativeSessionSchema, input),
  prompt: async (sessionId, request) => {
    await writeParsed(`${sessionPath(sessionId)}/prompt`, nativePromptAcceptedSchema, request);
  },
  abort: async (sessionId) => (await writeParsed(`${sessionPath(sessionId)}/abort`, nativeAbortResultSchema)).aborted,
  compact: async (sessionId, request) => {
    await writeParsed(`${sessionPath(sessionId)}/compact`, nativePromptAcceptedSchema, request);
  },
  replyQuestion: async (requestId, answers) => {
    await writeParsed(`${questionPath(requestId)}/reply`, nativeQuestionRepliedSchema, { answers });
  },
  rejectQuestion: async (requestId) => {
    await writeParsed(`${questionPath(requestId)}/reject`, nativeQuestionRejectedSchema);
  },
  revert: (sessionId, messageId, directory) => writeParsed(
    `${sessionPath(sessionId)}/revert`,
    nativeRevertResultSchema,
    { directory, messageID: messageId },
  ),
  unrevert: (sessionId, directory) => writeParsed(`${sessionPath(sessionId)}/unrevert`, nativeSessionSchema, { directory }),
  fork: (sessionId, messageId, directory) => writeParsed(
    `${sessionPath(sessionId)}/fork`,
    nativeSessionSchema,
    messageId === null ? { directory } : { directory, messageID: messageId },
  ),
  updateSession: (sessionId, directory, patch) => sendParsed(
    sessionPath(sessionId),
    nativeSessionSchema,
    { method: 'PATCH', body: { directory, ...patch } },
  ),
  deleteSession: async (sessionId, directory) => {
    await sendParsed(sessionPath(sessionId), nativeDeleteResultSchema, { method: 'DELETE', query: { directory } });
  },
});
