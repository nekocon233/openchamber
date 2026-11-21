import { z } from 'zod';

import type { Application, Request, RequestHandler, Response } from '../shared/http-contracts.js';
import { connectionWriteSchema } from './claude/connections.js';
import { codexConnectionWriteSchema } from './codex/connections.js';
import { JsonRpcError } from './codex/rpc.js';
import { NativeAgentError } from './errors.js';
import { statisticsQuery } from './stats.js';
import { conversationSelectionSchema } from './conversations/store.js';
import type { ConversationCompactRequest, ConversationSessionPatch } from './conversations/runtime.js';
import { nativeBackendSchema } from './ids.js';
import { planExecutionChoiceSchema } from './plan-execution.js';
import { agentConfigurationWriteSchema, agentModelSchema } from './agent-configuration.js';
import type { NativeAgentsRuntime } from './runtime.js';

const directoryQuery = z.object({ directory: z.string().min(1) }).passthrough();
const taskOperationInput = z.object({ directory: z.string().min(1), generation: z.string().min(1).max(128) }).strict();
const taskIdParam = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const commandsQuery = z.object({ backend: nativeBackendSchema, directory: z.string().min(1), sessionId: z.string().min(1).optional() }).passthrough();
const createSessionBody = z.object({
  backend: nativeBackendSchema,
  directory: z.string().min(1),
  title: z.string().min(1).max(200).optional(),
  kind: z.enum(['single', 'unified']).optional(),
  selection: conversationSelectionSchema.optional(),
  configuration: agentConfigurationWriteSchema.optional(),
}).passthrough().refine((input) => !input.configuration || input.kind === 'unified', 'Agent combinations require a unified conversation');
const conversationSelectionBody = z.object({
  directory: z.string().min(1),
  selection: conversationSelectionSchema,
  expectedRevision: z.number().int().nonnegative(),
}).strict();
const promptBody = z.object({
  subagentModel: agentModelSchema.nullable().optional(),
  directory: z.string().min(1),
  messageID: z.string().min(1),
  parts: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string() }).passthrough(),
    z.object({ type: z.literal('file'), mime: z.string().min(1), url: z.string().min(1), filename: z.string().optional() }).passthrough(),
  ])).min(1),
  model: z.object({ providerID: z.string().min(1), modelID: z.string().min(1) }),
  variant: z.string().min(1).optional(),
  agent: z.enum(['build', 'plan']),
  preserveSelection: z.boolean().optional(),
  instructions: z.string().trim().min(1).max(8000).optional(),
}).passthrough();
const questionReplyBody = z.object({ answers: z.array(z.array(z.string())), execution: planExecutionChoiceSchema.optional() }).passthrough();
const compactBody = z.object({
  directory: z.string().min(1),
  model: z.object({ providerID: z.string().min(1), modelID: z.string().min(1) }),
  variant: z.string().min(1).optional(),
  agent: z.enum(['build', 'plan']),
  instructions: z.string().trim().min(1).max(4000).optional(),
}).passthrough();
const directoryBody = z.object({ directory: z.string().min(1) }).passthrough();
const codexCommandBody = z.intersection(directoryBody, z.union([
  z.object({ name: z.literal('skills'), sessionId: z.string().min(1).optional() }),
  z.object({ name: z.literal('mcp'), sessionId: z.string().min(1), verbose: z.boolean().optional() }),
  z.object({ name: z.enum(['ps', 'stop']), sessionId: z.string().min(1) }),
  z.object({
    name: z.literal('review'),
    sessionId: z.string().min(1),
    model: z.string().min(1),
    variant: z.string().optional(),
    target: z.discriminatedUnion('type', [
      z.object({ type: z.literal('uncommittedChanges') }),
      z.object({ type: z.literal('baseBranch'), branch: z.string().trim().min(1) }),
      z.object({ type: z.literal('commit'), sha: z.string().trim().min(1) }),
      z.object({ type: z.literal('custom'), instructions: z.string().trim().min(1) }),
    ]),
  }),
]));
const METADATA_MAX_BYTES = 64 * 1024;
const sessionMetadata = z.record(z.string(), z.json())
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
const forkBody = z.object({ directory: z.string().min(1), messageID: z.string().min(1).optional() }).passthrough();
const messagesQuery = z.object({
  directory: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(500).catch(50),
  before: z.string().min(1).optional(),
}).passthrough();

const routeParam = (req: Request, name: string): string => req.params[name] ?? '';

const respondError = (res: Response, cause: unknown): void => {
  if (cause instanceof NativeAgentError) {
    res.status(cause.status).json({ error: cause.message, code: cause.code });
    return;
  }
  if (cause instanceof z.ZodError) {
    res.status(400).json({ error: 'Invalid native session request', code: 'NATIVE_INVALID_REQUEST' });
    return;
  }
  if (cause instanceof JsonRpcError) {
    res.status(502).json({ error: cause.message, code: 'NATIVE_BACKEND_ERROR' });
    return;
  }
  res.status(500).json({ error: cause instanceof Error ? cause.message : String(cause), code: 'NATIVE_INTERNAL_ERROR' });
};

const handle = <Result>(work: (req: Request) => Result | Promise<Result>): RequestHandler => async (req, res) => {
  try {
    res.json(await work(req));
  } catch (error) {
    respondError(res, error);
  }
};

export interface NativeAgentRoutesDependencies {
  runtime: NativeAgentsRuntime;
  isLocalManagementRequest?: ((req: Request) => boolean) | undefined;
  statisticsDirectories?: ((directory: string) => Promise<string[]>) | undefined;
}

export const registerNativeAgentRoutes = (
  app: Application,
  {
    runtime,
    isLocalManagementRequest = () => false,
    statisticsDirectories = async (directory) => [directory],
  }: NativeAgentRoutesDependencies,
): void => {
  app.get('/api/native/capabilities', handle(() => runtime.capabilities()));
  app.put('/api/native/sessions/:sessionId/agents', handle((req) => {
    const input = z.object({
      directory: z.string().min(1),
      configuration: agentConfigurationWriteSchema,
      expectedRevision: z.number().int().nonnegative(),
      main: conversationSelectionSchema.optional(),
      expectedSelectionRevision: z.number().int().nonnegative().optional(),
    }).strict().parse(req.body);
    return runtime.configureAgents(routeParam(req, 'sessionId'), input.directory, input.configuration, input.expectedRevision, input.main, input.expectedSelectionRevision);
  }));
  app.get('/api/native/stats', async (req, res) => {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    res.once('close', cancel);
    try {
      const query = statisticsQuery.parse(req.query);
      const scopeDirectories = query.directory ? await statisticsDirectories(query.directory) : [];
      const result = await runtime.statistics(query, { scopeDirectories, signal: controller.signal });
      if (!controller.signal.aborted) res.json(result);
    } catch (error) {
      if (!controller.signal.aborted) respondError(res, error);
    } finally { res.off('close', cancel); }
  });
  const memory = () => {
    if (!runtime.memorySharing) throw new NativeAgentError('Native memory sharing is unavailable', { status: 503, code: 'NATIVE_MEMORY_UNSUPPORTED' });
    return runtime.memorySharing;
  };
  const requireLocalMemoryManagement = (req: Request): void => {
    if (!isLocalManagementRequest(req)) throw new NativeAgentError('Connect terminal CLIs on the server computer', { status: 403, code: 'NATIVE_MEMORY_LOCAL_REQUIRED' });
  };
  app.get('/api/native/memory', handle(async (req) => ({
    ...await memory().status(z.object({ directory: z.string().optional() }).parse(req.query).directory),
    canManage: isLocalManagementRequest(req),
  })));
  app.post('/api/native/memory/:backend/connect', handle((req) => {
    requireLocalMemoryManagement(req);
    const port = req.socket.localPort;
    if (!port) throw new NativeAgentError('The local server port is unavailable', { status: 503, code: 'NATIVE_MEMORY_PORT_UNAVAILABLE' });
    return memory().connect(z.enum(['claude', 'codex']).parse(req.params.backend), port);
  }));
  app.delete('/api/native/memory/:backend', handle((req) => {
    requireLocalMemoryManagement(req);
    return memory().disconnect(z.enum(['claude', 'codex']).parse(req.params.backend));
  }));
  app.post('/api/native/memory/import', handle((req) => {
    const body = z.object({ directory: z.string().min(1), sourceId: z.string().min(1) }).parse(req.body);
    return memory().importSource(body.sourceId, body.directory);
  }));

  const connections = '/api/native/claude/connections';
  app.get(connections, handle(() => runtime.claudeConnections.list()));
  app.post(connections, handle((req) => runtime.claudeConnections.save(null, connectionWriteSchema.parse(req.body))));
  app.patch(`${connections}/:id`, handle((req) => runtime.claudeConnections.save(z.string().uuid().parse(req.params.id), connectionWriteSchema.parse(req.body))));
  app.delete(`${connections}/:id`, handle((req) => runtime.claudeConnections.remove(z.string().uuid().parse(req.params.id))));

  const codexConnections = '/api/native/codex/connections';
  app.get(codexConnections, handle(() => runtime.codexConnections.list()));
  app.post(codexConnections, handle((req) => runtime.saveCodexConnection(null, codexConnectionWriteSchema.parse(req.body))));
  app.patch(`${codexConnections}/:id`, handle((req) => runtime.saveCodexConnection(z.string().uuid().parse(req.params.id), codexConnectionWriteSchema.parse(req.body))));
  app.delete(`${codexConnections}/:id`, handle((req) => runtime.removeCodexConnection(z.string().uuid().parse(req.params.id))));

  app.get('/api/native/catalog', handle(() => runtime.catalog()));
  app.get('/api/native/deepseek/setup', handle(() => runtime.deepseekSetup.status()));
  app.post('/api/native/deepseek/setup', handle((req) => {
    z.object({}).strict().parse(req.body ?? {});
    return runtime.deepseekSetup.start();
  }));

  app.post('/api/native/codex/command', handle((req) => runtime.codexCommand(codexCommandBody.parse(req.body))));
  app.post('/api/native/deepseek/command', handle((req) => runtime.deepseekCommand(z.object({
    sessionId: z.string().min(1),
    directory: z.string().min(1),
    line: z.string().trim().min(1).max(8000).regex(/^\//),
  }).parse(req.body))));

  app.get('/api/native/commands', handle((req) => {
    const query = commandsQuery.parse(req.query);
    return runtime.commands(query.backend, query.directory, query.sessionId);
  }));

  app.get('/api/native/sessions/status', handle((req) => runtime.statuses(directoryQuery.parse(req.query).directory)));

  app.get('/api/native/sessions/background', handle(() => runtime.backgroundTasks()));

  app.get('/api/native/questions', handle((req) => runtime.questions(directoryQuery.parse(req.query).directory)));

  app.get('/api/native/sessions', handle((req) => runtime.listSessions(directoryQuery.parse(req.query).directory)));

  app.get('/api/native/chat-directories', handle(async () => ({ directories: await runtime.managedChatDirectories() })));

  app.get('/api/native/sessions/:sessionId', handle((req) => runtime.getSession(
    routeParam(req, 'sessionId'),
    directoryQuery.parse(req.query).directory,
  )));

  app.get('/api/native/sessions/:sessionId/messages', handle((req) => {
    const query = messagesQuery.parse(req.query);
    return runtime.loadMessages(routeParam(req, 'sessionId'), query.directory, { limit: query.limit, before: query.before });
  }));

  app.get('/api/native/sessions/:sessionId/checklist', handle((req) => runtime.checklist(
    routeParam(req, 'sessionId'), directoryQuery.parse(req.query).directory,
  )));

  app.get('/api/native/sessions/:sessionId/plan', handle((req) => runtime.plan(
    routeParam(req, 'sessionId'), directoryQuery.parse(req.query).directory,
  )));

  app.get('/api/native/sessions/:sessionId/todos', handle((req) => runtime.codexTodos(
    routeParam(req, 'sessionId'), directoryQuery.parse(req.query).directory,
  )));

  app.get('/api/native/sessions/:sessionId/tasks', handle((req) => runtime.sessionTasks(
    routeParam(req, 'sessionId'), directoryQuery.parse(req.query).directory,
  )));

  app.get('/api/native/sessions/:sessionId/tasks/:taskId/output', handle((req) => {
    const input = taskOperationInput.parse(req.query);
    return runtime.taskOutput(routeParam(req, 'sessionId'), input.directory, taskIdParam.parse(req.params.taskId), input.generation);
  }));

  app.post('/api/native/sessions/:sessionId/tasks/:taskId/stop', handle((req) => {
    const input = taskOperationInput.parse(req.body);
    return runtime.stopTask(routeParam(req, 'sessionId'), input.directory, taskIdParam.parse(req.params.taskId), input.generation);
  }));

  app.post('/api/native/sessions', handle((req) => runtime.createSession(createSessionBody.parse(req.body))));

  app.patch('/api/native/sessions/:sessionId', handle((req) => {
    const body = sessionPatchBody.parse(req.body);
    const patch: ConversationSessionPatch = {};
    if (body.title !== undefined) patch.title = body.title;
    if (body.archived !== undefined) patch.archived = body.archived;
    if (body.metadata !== undefined) patch.metadata = body.metadata;
    return runtime.updateSession(routeParam(req, 'sessionId'), body.directory, patch);
  }));

  app.delete('/api/native/sessions/:sessionId', handle((req) => runtime.deleteSession(
    routeParam(req, 'sessionId'),
    directoryQuery.parse(req.query).directory,
  )));

  app.post('/api/native/sessions/:sessionId/prompt', handle(async (req) => {
    const body = promptBody.parse(req.body);
    await runtime.prompt(routeParam(req, 'sessionId'), {
      directory: body.directory,
      messageID: body.messageID,
      parts: body.parts,
      model: body.model,
      variant: body.variant,
      agent: body.agent,
      instructions: body.instructions,
      preserveSelection: body.preserveSelection,
    });
    return { accepted: true };
  }));

  app.patch('/api/native/sessions/:sessionId/selection', handle((req) => {
    const body = conversationSelectionBody.parse(req.body);
    return runtime.selectModel(routeParam(req, 'sessionId'), body.directory, body.selection, body.expectedRevision);
  }));

  app.post('/api/native/sessions/:sessionId/abort', handle(async (req) => ({ aborted: await runtime.abort(routeParam(req, 'sessionId')) })));

  app.post('/api/native/sessions/:sessionId/abort-source', handle(async (req) => {
    const options = z.object({ expectedSourceSessionId: z.string().min(1) }).strict().parse(req.body);
    return { aborted: await runtime.abort(routeParam(req, 'sessionId'), options) };
  }));

  app.post('/api/native/sessions/:sessionId/compact', handle(async (req) => {
    const body = compactBody.parse(req.body);
    const request: ConversationCompactRequest = { directory: body.directory, model: body.model, agent: body.agent };
    if (body.variant !== undefined) request.variant = body.variant;
    if (body.instructions !== undefined) request.instructions = body.instructions;
    await runtime.compact(routeParam(req, 'sessionId'), request);
    return { accepted: true };
  }));

  app.post('/api/native/sessions/:sessionId/revert', handle((req) => {
    const body = messageBody.parse(req.body);
    return runtime.revert(routeParam(req, 'sessionId'), body.messageID, body.directory);
  }));

  app.post('/api/native/sessions/:sessionId/unrevert', handle((req) => runtime.unrevert(
    routeParam(req, 'sessionId'),
    directoryBody.parse(req.body).directory,
  )));

  app.post('/api/native/sessions/:sessionId/fork', handle((req) => {
    const body = forkBody.parse(req.body);
    return runtime.fork(routeParam(req, 'sessionId'), body.messageID ?? null, body.directory);
  }));

  app.post('/api/native/questions/:requestId/reply', handle(async (req) => {
    const { answers, execution } = questionReplyBody.parse(req.body);
    if (execution) await runtime.replyQuestion(routeParam(req, 'requestId'), answers, execution);
    else await runtime.replyQuestion(routeParam(req, 'requestId'), answers);
    return { replied: true };
  }));

  app.post('/api/native/questions/:requestId/reject', handle(async (req) => {
    await runtime.rejectQuestion(routeParam(req, 'requestId'));
    return { rejected: true };
  }));
};
