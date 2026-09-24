import type { NativeAgentsAPI, NativeCompactRequest, NativePromptRequest, NativeSessionPatch } from '@openchamber/ui/lib/api/types';
import type { NativeBackend } from '@openchamber/ui/lib/native-agents/ids';
import { NativeAgentsRequestError } from '@openchamber/ui/lib/native-agents/errors';
import {
  nativeAbortResultSchema,
  nativeCapabilitiesSchema,
  nativeCatalogSchema,
  nativeCommandListSchema,
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
import { runtimeFetch } from '@openchamber/ui/lib/runtime-fetch';
import { z } from 'zod';

// Matches the OpenCode read deadline: a half-open socket must not hold a
// bootstrap or history read forever.
const NATIVE_READ_TIMEOUT_MS = 30_000;

const errorBodySchema = z.object({ error: z.string().optional(), code: z.string().optional() }).passthrough();

type NativeWriteBody =
  | { backend: NativeBackend; directory: string; title?: string }
  | NativePromptRequest
  | NativeCompactRequest
  | { answers: string[][] }
  | { directory: string; messageID?: string }
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
  capabilities: () => readParsed('/api/native/capabilities', {}, nativeCapabilitiesSchema),
  catalog: () => readParsed('/api/native/catalog', {}, nativeCatalogSchema),
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
