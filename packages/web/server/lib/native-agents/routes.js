// HTTP routes of the native CLI runtime. Registered with the other explicit
// OpenChamber routes, before the generic OpenCode proxy; bodies are parsed by
// the common middleware (`/api/native/` is on its JSON allowlist).

import { z } from 'zod';

import { JsonRpcError } from './codex/rpc.js';
import { NativeAgentError } from './errors.js';

const directoryQuery = z.object({ directory: z.string().min(1) }).passthrough();
const commandsQuery = z.object({ backend: z.enum(['claude', 'codex']), directory: z.string().min(1) }).passthrough();
const createSessionBody = z.object({
  backend: z.enum(['claude', 'codex']),
  directory: z.string().min(1),
  title: z.string().min(1).max(200).optional(),
}).passthrough();
const promptBody = z.object({
  directory: z.string().min(1),
  messageID: z.string().min(1),
  parts: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string() }).passthrough(),
    z.object({ type: z.literal('file'), mime: z.string().min(1), url: z.string().min(1), filename: z.string().optional() }).passthrough(),
  ])).min(1),
  model: z.object({ providerID: z.string().min(1), modelID: z.string().min(1) }),
  variant: z.string().min(1).optional(),
  agent: z.enum(['build', 'plan']),
  // A feature's instructions (the btw boundary); the CLI reads them, the
  // conversation does not show them.
  instructions: z.string().trim().min(1).max(8000).optional(),
}).passthrough();
const questionReplyBody = z.object({ answers: z.array(z.array(z.string())) }).passthrough();
const compactBody = z.object({
  directory: z.string().min(1),
  model: z.object({ providerID: z.string().min(1), modelID: z.string().min(1) }),
  variant: z.string().min(1).optional(),
  agent: z.enum(['build', 'plan']),
  instructions: z.string().trim().min(1).max(4000).optional(),
}).passthrough();
const directoryBody = z.object({ directory: z.string().min(1) }).passthrough();
// OpenChamber's own session metadata, replaced whole as OpenCode's session
// update does. Bounded: it is stored in the registry with every session.
const METADATA_MAX_BYTES = 64 * 1024;
const sessionMetadata = z.record(z.string(), z.unknown())
  .refine((metadata) => Buffer.byteLength(JSON.stringify(metadata)) <= METADATA_MAX_BYTES, 'Session metadata is too large');
const sessionPatchBody = z.object({
  directory: z.string().min(1),
  title: z.string().trim().min(1).max(200).optional(),
  archived: z.boolean().optional(),
  metadata: sessionMetadata.optional(),
}).passthrough().refine(
  (body) => body.title !== undefined || body.archived !== undefined || body.metadata !== undefined,
  'Nothing to change',
);
const messageBody = z.object({ directory: z.string().min(1), messageID: z.string().min(1) }).passthrough();
// A fork without a message holds the whole conversation.
const forkBody = z.object({ directory: z.string().min(1), messageID: z.string().min(1).optional() }).passthrough();
const messagesQuery = z.object({
  directory: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(500).catch(50),
  before: z.string().min(1).optional(),
}).passthrough();

const respondError = (res, error) => {
  if (error instanceof NativeAgentError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: 'Invalid native session request', code: 'NATIVE_INVALID_REQUEST' });
    return;
  }
  if (error instanceof JsonRpcError) {
    res.status(502).json({ error: error.message, code: 'NATIVE_BACKEND_ERROR' });
    return;
  }
  res.status(500).json({ error: error instanceof Error ? error.message : String(error), code: 'NATIVE_INTERNAL_ERROR' });
};

const handle = (work) => async (req, res) => {
  try {
    res.json(await work(req));
  } catch (error) {
    respondError(res, error);
  }
};

/**
 * @param {import('express').Express} app
 * @param {{ runtime: ReturnType<typeof import('./runtime.js').createNativeAgentsRuntime> }} deps
 */
export const registerNativeAgentRoutes = (app, { runtime }) => {
  app.get('/api/native/capabilities', handle(() => runtime.capabilities()));

  app.get('/api/native/catalog', handle(() => runtime.catalog()));

  app.get('/api/native/commands', handle((req) => {
    const query = commandsQuery.parse(req.query);
    return runtime.commands(query.backend, query.directory);
  }));

  // Registered before /:sessionId so the literal segments win.
  app.get('/api/native/sessions/status', handle((req) => runtime.statuses(directoryQuery.parse(req.query).directory)));

  app.get('/api/native/questions', handle((req) => runtime.questions(directoryQuery.parse(req.query).directory)));

  app.get('/api/native/sessions', handle((req) => runtime.listSessions(directoryQuery.parse(req.query).directory)));

  app.get('/api/native/sessions/:sessionId', handle((req) => runtime.getSession(
    req.params.sessionId,
    directoryQuery.parse(req.query).directory,
  )));

  app.get('/api/native/sessions/:sessionId/messages', handle((req) => {
    const query = messagesQuery.parse(req.query);
    return runtime.loadMessages(req.params.sessionId, query.directory, { limit: query.limit, before: query.before });
  }));

  app.post('/api/native/sessions', handle((req) => runtime.createSession(createSessionBody.parse(req.body))));

  app.patch('/api/native/sessions/:sessionId', handle((req) => {
    const body = sessionPatchBody.parse(req.body);
    const patch = {};
    if (body.title !== undefined) patch.title = body.title;
    if (body.archived !== undefined) patch.archived = body.archived;
    if (body.metadata !== undefined) patch.metadata = body.metadata;
    return runtime.updateSession(req.params.sessionId, body.directory, patch);
  }));

  app.delete('/api/native/sessions/:sessionId', handle((req) => runtime.deleteSession(
    req.params.sessionId,
    directoryQuery.parse(req.query).directory,
  )));

  // Returns once the CLI accepted the prompt; the turn streams as events.
  app.post('/api/native/sessions/:sessionId/prompt', handle(async (req) => {
    const body = promptBody.parse(req.body);
    await runtime.prompt(req.params.sessionId, {
      directory: body.directory,
      messageID: body.messageID,
      parts: body.parts,
      model: body.model,
      variant: body.variant,
      agent: body.agent,
      instructions: body.instructions,
    });
    return { accepted: true };
  }));

  app.post('/api/native/sessions/:sessionId/abort', handle(async (req) => ({ aborted: await runtime.abort(req.params.sessionId) })));

  // Returns once the CLI took the compaction; it streams in as a turn.
  app.post('/api/native/sessions/:sessionId/compact', handle(async (req) => {
    const body = compactBody.parse(req.body);
    const request = { directory: body.directory, model: body.model, agent: body.agent };
    if (body.variant !== undefined) request.variant = body.variant;
    if (body.instructions !== undefined) request.instructions = body.instructions;
    await runtime.compact(req.params.sessionId, request);
    return { accepted: true };
  }));

  app.post('/api/native/sessions/:sessionId/revert', handle((req) => {
    const body = messageBody.parse(req.body);
    return runtime.revert(req.params.sessionId, body.messageID, body.directory);
  }));

  app.post('/api/native/sessions/:sessionId/unrevert', handle((req) => runtime.unrevert(
    req.params.sessionId,
    directoryBody.parse(req.body).directory,
  )));

  app.post('/api/native/sessions/:sessionId/fork', handle((req) => {
    const body = forkBody.parse(req.body);
    return runtime.fork(req.params.sessionId, body.messageID ?? null, body.directory);
  }));

  app.post('/api/native/questions/:requestId/reply', handle((req) => {
    runtime.replyQuestion(req.params.requestId, questionReplyBody.parse(req.body).answers);
    return { replied: true };
  }));

  app.post('/api/native/questions/:requestId/reject', handle((req) => {
    runtime.rejectQuestion(req.params.requestId);
    return { rejected: true };
  }));
};
