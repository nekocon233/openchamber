// Protocol fixture matching the published 0.2.0-rc.2 Remote declarations.
// It runs no model or tools. HTTP and WebSocket use the actual cookie/origin gate.
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import { WebSocketServer } from 'ws';

const directory = process.env.DSH_TEST_DIRECTORY;
const token = randomUUID();
const cookie = `dsh-test=${randomUUID()}`;
const sessions = new Map();
const streams = new Set();
const answers = [];
const uploads = new Map();
const providerSettings = {
  ns: 'llm-deepseek', revision: 0,
  value: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://deepseek.test/anthropic', models: [{ id: 'test-model', name: 'Test model', contextWindow: 1_000_000, maxTokens: 64000, inputModalities: ['text'] }], reasoningEffort: 'high' },
};
let settingsWritable = true;
let keyWritable = true;
let storedKey = null;
let rejectKey = false;
let rejectSettings = false;
let settingsWrites = 0;
let keyWrites = 0;
const saveFile = (bytes, name) => {
  const file = { attachmentId: createHash('sha256').update(bytes).digest('hex'), name: name ?? 'file', bytes: bytes.length };
  const receiptId = randomUUID();
  uploads.set(receiptId, file);
  return { receiptId, file };
};
let failAnswer = false;
let nextListDelay = 0;
const deliver = (endpoint, value, nativeId) => {
  for (const entry of streams) if (entry.endpoint === endpoint && (!nativeId || entry.args.request?.address.sessionId === nativeId)) {
    entry.socket.send(JSON.stringify({ type: 'item', streamId: entry.id, value }));
  }
};
const rows = () => Array.from(sessions.values(), (session) => ({
  sessionId: session.id, agentAvailable: session.agentAvailable !== false, running: session.running, blank: session.events.length === 0,
  cwd: directory, updatedAt: 1000 + session.events.length,
  projections: { kind: 'sequenced', asOfSeq: session.events.length - 1, values: { title: session.title } },
}));
const append = (session, type, data) => {
  const event = { type, seq: session.events.length, time: 1000 + session.events.length, data };
  session.events.push(event);
  for (const entry of streams) if (entry.endpoint === 'session/follow' && entry.args.request.address.sessionId === session.id) {
    entry.socket.send(JSON.stringify({ type: 'item', streamId: entry.id, value: { type: 'event', event } }));
  }
  return event;
};
const emit = (event, args) => {
  for (const entry of streams) if (entry.endpoint === '$events') entry.socket.send(JSON.stringify({ type: 'item', streamId: entry.id, value: { type: 'emit', event, args } }));
};
const makeSession = (id, title = 'Existing DSH session') => {
  const session = { id, title, events: [], running: false, requests: new Set(), turn: 0 };
  sessions.set(id, session);
  return session;
};
const original = makeSession('session-existing');
const messageCount = Number(process.env.DSH_TEST_MESSAGES ?? '2');
append(original, 'request/context', { provider: 'deepseek-official', model: 'test-model' });
for (let i = 0; i < messageCount; i += 1) {
  append(original, 'user/message', { id: `user-${i}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `prompt ${i}` }] });
  append(original, 'assistant/message', { turn: i, step: 0, message: { id: `assistant-${i}`, role: 'assistant', source: { kind: 'model', provider: 'deepseek-official', model: 'test-model' }, content: [{ type: 'text', text: `reply ${i}` }] }, stream: [] });
}
original.turn = messageCount;
let archived = [];
let base;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, base);
  if (url.pathname === '/' && url.searchParams.get('token') === token) {
    res.writeHead(303, { 'Set-Cookie': `${cookie}; HttpOnly; Path=/; SameSite=Strict`, Location: './' });
    res.end();
    return;
  }
  if (req.headers.origin !== base) { res.writeHead(403).end(); return; }
  if (req.headers.cookie !== cookie) { res.writeHead(401).end(); return; }
  if (url.pathname === '/api/session/uploadFileBinary') {
    if (req.method !== 'POST' || req.headers['content-type'] !== 'application/octet-stream') { res.writeHead(415).end(); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, value: saveFile(Buffer.concat(chunks), url.searchParams.get('name')) }));
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  const args = request.payload.args;
  const respond = (value) => {
    res.setHeader('Content-Type', 'application/json');
    const result = { ok: true };
    if (value !== undefined) result.value = value;
    res.end(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result }));
  };
  const fail = (code, message) => res.end(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: false, error: { code, message, details: {} } } }));
  const session = sessions.get(args.request?.sessionId ?? args.agentId);
  switch (request.method) {
    case 'settings/describe': respond({ writable: settingsWritable, namespaces: [providerSettings] }); break;
    case 'credentials/describe': respond(Object.fromEntries(args.refs.map((ref) => [ref, { configured: storedKey !== null, writable: keyWritable }]))); break;
    case 'settings/mutate': {
      if (args.expectedRevision !== providerSettings.revision) { fail('settings/conflict', 'Settings changed'); break; }
      if (!settingsWritable || rejectSettings) { fail('settings/rejected', 'Settings write refused'); break; }
      for (const op of args.ops) {
        if (op.op === 'unset') delete providerSettings.value[op.path[0]];
        else providerSettings.value[op.path[0]] = op.value;
      }
      providerSettings.revision += 1;
      settingsWrites += 1;
      respond(providerSettings);
      break;
    }
    case 'credentials/set':
      if (!keyWritable || rejectKey) fail('credential/rejected', `Fixture rejected ${args.value}`);
      else { storedKey = args.value; keyWrites += 1; respond(); }
      break;
    case 'session/list': {
      const items = rows();
      const delay = nextListDelay;
      nextListDelay = 0;
      if (delay) setTimeout(() => respond({ items }), delay);
      else respond({ items });
      break;
    }
    case 'fixture/cold': sessions.get(args.sessionId).agentAvailable = false; respond(true); break;
    case 'fixture/list-lag': nextListDelay = args.delay; respond(true); break;
    case 'session/modelCatalog': respond({ default: { provider: 'deepseek-official', model: 'test-model' }, routableProviders: ['deepseek-official'], groups: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'test-model', name: 'Test model', reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' } }] }], failures: [] }); break;
    case 'session/create': {
      const created = args.request.sessionId ? sessions.get(args.request.sessionId) ?? makeSession(args.request.sessionId, 'New session') : makeSession(`session-${randomUUID()}`, 'New session');
      created.agentAvailable = true;
      emit('api-session/added', [rows().find((row) => row.sessionId === created.id)]);
      respond({ sessionId: created.id });
      break;
    }
    case 'session/rename': session.title = args.request.title; respond({ title: session.title, seq: session.events.length }); break;
    case 'session/selectModel': respond({ selected: { provider: args.request.provider, model: args.request.model } }); break;
    case 'commands/list': respond([{ name: 'plan', description: 'Plan', input: { hint: '[off|message]' } }, { name: 'compact', description: 'Compact' }, { name: 'permission', description: 'Permissions' }]); break;
    case 'fileUploads/upload': respond(saveFile(Buffer.from(args.request.data, 'base64'), args.request.name)); break;
    case 'commands/execute': {
      if (args.line === '/plan' || args.line === '/plan off') append(session, 'plan/mode', { active: args.line === '/plan' });
      respond({ commandId: randomUUID(), result: { kind: 'success', text: 'Command completed' } });
      break;
    }
    case 'session/prompt': {
      if (session.requests.has(args.request.requestId)) { respond({ accepted: true }); break; }
      session.requests.add(args.request.requestId);
      session.turn += 1;
      append(session, 'turn/start', { turn: session.turn });
      const content = args.request.content.map((part) => part.type === 'file' ? { type: 'file', attachment: uploads.get(part.receiptId) } : part);
      append(session, 'user/message', { id: randomUUID(), role: 'user', source: { kind: 'user', rpcId: args.request.requestId }, content });
      session.running = true;
      emit('api-session/status', [session.id, true]);
      if (args.request.content[0]?.text === 'drop-response') { res.destroy(); break; }
      respond({ accepted: true });
      break;
    }
    case 'session/cancel':
      append(session, 'turn/end', { turn: session.turn, reason: { kind: 'aborted', reason: { kind: 'user' } } });
      session.running = false;
      emit('api-session/status', [session.id, false]);
      respond({ accepted: true });
      break;
    case 'session/page': {
      const source = sessions.get(args.request.address.sessionId);
      const events = source.events.filter((event) => event.seq <= args.request.throughSeq && (args.request.beforeSeq === undefined || event.seq < args.request.beforeSeq));
      const kept = events.slice(-Math.max(2, args.request.maxMessages));
      respond({ records: kept.map((event) => ({ type: 'event', event })), hasMore: kept.length < events.length });
      break;
    }
    case 'session/fork': {
      const fork = makeSession(`session-${randomUUID()}`, `${session.title} (fork)`);
      fork.events = session.events.filter((event) => args.request.atSeq === undefined || event.seq <= args.request.atSeq);
      respond({ sessionId: fork.id });
      break;
    }
    case 'workspace/archiveSession':
    case 'workspace/unarchiveSession':
      archived = request.method === 'workspace/archiveSession' ? [...archived, session.id] : archived.filter((id) => id !== session.id);
      respond({ archivedSessionIds: archived });
      break;
    case '$events/result': answers.push(args.outcome); respond(true); break;
    case 'userQuestions/answer':
      if (failAnswer) { failAnswer = false; fail('gateway/internal', 'Delivery failed'); }
      else { answers.push(args.answer); respond(true); }
      break;
    case 'fixture/answers': respond(answers); break;
    case 'fixture/configuration': respond({ ...providerSettings, settingsWrites, keyWrites, hasKey: storedKey !== null }); break;
    case 'fixture/settings-options':
      if (args.settingsWritable !== undefined) settingsWritable = args.settingsWritable;
      if (args.keyWritable !== undefined) keyWritable = args.keyWritable;
      if (args.rejectKey !== undefined) rejectKey = args.rejectKey;
      if (args.rejectSettings !== undefined) rejectSettings = args.rejectSettings;
      respond(true);
      break;
    case 'fixture/fail-answer': failAnswer = true; respond(true); break;
    case 'fixture/append': {
      const target = sessions.get(args.sessionId);
      if (!target) { fail('gateway/unknown-session', args.sessionId); break; }
      append(target, args.type, args.data);
      respond(true);
      break;
    }
    case 'fixture/stream-count': respond(Array.from(streams).filter((entry) => entry.endpoint === 'session/follow').length); break;
    case 'fixture/selection':
      deliver('session/control', { type: 'projection', sessionId: args.sessionId, key: 'plan', value: { active: args.plan, pending: false }, seq: args.seq });
      deliver('session/control', { type: 'projection', sessionId: args.sessionId, key: 'modelSelection', value: {
        next: { provider: 'deepseek-official', model: 'test-model', reasoningEffort: 'high' }, lastUsed: null,
      }, seq: args.seq });
      respond(true);
      break;
    case 'fixture/question':
      deliver('$events', { type: 'waterfall', event: 'user-questions/request', agentId: args.sessionId, eventId: 'question-1', request: {
        questions: [{ id: 'choice-id', question: 'Choose', header: 'Choice', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true }],
      } });
      respond(true);
      break;
    case 'fixture/approval':
      deliver('$events', { type: 'waterfall', event: 'approval/request', agentId: args.sessionId, eventId: 'approval-1', request: { toolName: 'bash' } });
      respond(true);
      break;
    case 'fixture/timed-question':
      deliver('session/control', { type: 'projection', sessionId: args.sessionId, key: 'userQuestions', seq: 1000,
        value: { active: [{ callId: 'timed-1', state: 'continued', questions: [{ id: 'late-id', question: 'Later?', options: [{ label: 'Yes' }] }] }], settled: [] } });
      respond(true);
      break;
    case 'fixture/stream': {
      const target = sessions.get(args.sessionId);
      const attemptId = randomUUID();
      const send = (frame) => deliver('session/follow', { type: 'assistant-stream', frame }, target.id);
      send({ type: 'start', attemptId, revision: 1, startedAfterSeq: target.events.length - 1, turn: 999, step: 0 });
      send({ type: 'chunk', attemptId, revision: 2, index: 0, time: 2000, chunk: { type: 'text-delta', index: 0, text: 'Hello' } });
      const event = append(target, 'assistant/message', { turn: 999, step: 0, message: { id: 'streamed', source: { kind: 'model', provider: 'deepseek-official', model: 'test-model' }, content: [{ type: 'text', text: 'Hello world' }] }, stream: [] });
      send({ type: 'chunk', attemptId, revision: 3, index: 1, time: 2010, chunk: { type: 'text-delta', index: 0, text: ' world' } });
      send({ type: 'end', attemptId, revision: 4, index: 2, outcome: { kind: 'committed', eventType: 'assistant/message', seq: event.seq } });
      respond(true);
      break;
    }
    case 'fixture/held': fail('session/writer-held', 'writer occupied'); break;
    case 'fixture/invalid': respond({ incompatible: true }); break;
    case 'fixture/exit': respond(true); setImmediate(() => process.exit(0)); break;
    default: fail('gateway/method-unavailable', request.method);
  }
});
const sockets = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/api/remote.mux' || req.headers.cookie !== cookie || req.headers.origin !== base) {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  sockets.handleUpgrade(req, socket, head, (ws) => sockets.emit('connection', ws));
});
sockets.on('connection', (socket) => {
  socket.on('message', (bytes) => {
    const request = JSON.parse(bytes.toString());
    if (request.type === 'cancel') { for (const entry of streams) if (entry.id === request.streamId) streams.delete(entry); return; }
    const entry = { id: request.streamId, endpoint: request.endpoint, args: request.payload.args, socket };
    streams.add(entry);
    let value;
    if (entry.endpoint === '$events') value = { type: 'ready', clientId: randomUUID(), host: { home: directory } };
    if (entry.endpoint === 'workspace/follow') value = { type: 'baseline', value: { items: [], archivedSessionIds: archived, pinnedSessionIds: [] } };
    if (entry.endpoint === 'session/control') value = { type: 'baseline', value: { projections: {} } };
    if (entry.endpoint === 'session/follow') {
      if (entry.args.request.assistantStream !== undefined && entry.args.request.assistantStream !== true) {
        socket.send(JSON.stringify({ type: 'error', streamId: entry.id, error: { code: 'invalid-request', message: 'assistantStream must be true or omitted' } }));
        return;
      }
      const session = sessions.get(entry.args.request.address.sessionId);
      const records = session.events.slice(-100).map((event) => ({ type: 'event', event }));
      value = { type: 'snapshot', header: { version: 4, id: session.id, createdAt: 1000, cwd: directory }, cursor: session.events.length - 1,
        records, hasMore: session.events.length > 100, projections: { asOfSeq: session.events.length - 1, values: {} }, assistantStream: { revision: 1 } };
    }
    socket.send(JSON.stringify({ type: 'item', streamId: entry.id, value }));
  });
  socket.on('close', () => { for (const entry of streams) if (entry.socket === socket) streams.delete(entry); });
});
server.listen(0, '127.0.0.1', () => {
  base = `http://127.0.0.1:${server.address().port}`;
  process.stdout.write(`dsh web: ${base}/?token=${token}\n`);
});
process.on('SIGTERM', () => { for (const socket of sockets.clients) socket.terminate(); server.close(() => process.exit(0)); });
