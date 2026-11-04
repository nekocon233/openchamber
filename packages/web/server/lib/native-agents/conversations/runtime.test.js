import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NATIVE_BACKENDS, nativeBackendOfProviderId, nativeProviderSchema } from '../ids.js';
import { createNativeRegistry } from '../registry.js';
import { buildSessionRecord, buildUserMessage, buildAssistantMessage, buildTextPart, buildToolPart } from '../records.js';
import { createQuestionRegistry } from '../questions.js';
import { createNativePlanExecution } from '../plan-execution.js';
import { NativeAgentError } from '../errors.js';
import { JsonRpcError } from '../codex/rpc.js';
import { createNativeConversations } from './runtime.js';
import { checklistReceipt } from '../antigravity/checklist-protocol.mjs';
import { NATIVE_BACKENDS as UI_BACKENDS, nativeProviderIdOf } from '@openchamber/ui/lib/native-agents/ids';
import { nativeCapabilitiesSchema, nativeMessagePageSchema } from '@openchamber/ui/lib/native-agents/schemas';

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

const selection = (backend) => ({ model: { providerID: nativeProviderIdOf(backend), modelID: `${backend}-model` }, agent: 'build', variant: 'high' });
const pairs = NATIVE_BACKENDS.flatMap((from) => NATIVE_BACKENDS.filter((to) => to !== from).map((to) => [from, to]));

/** Scripted native operations exercise the controller through its production boundary. */
const setup = async ({ smallModels = async () => { throw new Error('This fixture must not use a third model'); } } = {}) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-conversations-'));
  const directory = dataDir;
  const registry = createNativeRegistry({ filePath: path.join(dataDir, 'registry.json') });
  const sources = new Map();
  const running = new Map();
  const missing = new Set();
  const incomplete = new Set();
  const requests = [];
  const events = [];
  const operations = [];
  let clock = 1000;
  let hold = false;
  let refusal = null;
  let uncertain = false;
  let controller;
  const emit = (type, properties) => controller.publish({ directory, payload: { id: `fixture-${clock++}`, type, properties } });
  const complete = (id) => {
    running.delete(id);
    emit('session.status', { sessionID: id, status: { type: 'idle' } });
    emit('session.idle', { sessionID: id });
  };
  const native = {
    async capabilities() {
      const backends = Object.fromEntries(NATIVE_BACKENDS.map((backend) => [backend, { cli: true }]));
      backends.deepseek = { cli: true, blockedByEnterprise: false, actions: { revert: true, delete: true, fork: true } };
      return { supported: true, backends, registry: { reset: false } };
    },
    async catalog() {
      return { backends: Object.fromEntries(NATIVE_BACKENDS.map((backend) => [backend, { status: 'ok', models: [{
        id: `${backend}-model`, name: backend, contextWindow: 64000, outputLimit: 8192,
        efforts: ['high'], defaultEffort: 'high', input: { image: false, pdf: false },
      }] }])) };
    },
    async createSession({ backend, directory, title }, { beforePublish } = {}) {
      const uuid = randomUUID();
      const id = backend === 'deepseek' ? `ndh_${createHash('sha256').update(uuid).digest('hex')}`
        : `${{ claude: 'ncl', codex: 'ncx', antigravity: 'nag' }[backend]}_${uuid}`;
      const record = buildSessionRecord({ id, backend, directory, title: title ?? `${backend} fixture`, created: clock++, updated: clock++ });
      sources.set(id, { record, records: [] });
      await registry.registerSession(id, { backend, nativeId: uuid, directory, origin: 'openchamber', createdAt: clock++ });
      operations.push(`create:${id}`);
      await beforePublish?.(record);
      emit('session.created', { info: record });
      return record;
    },
    async prompt(id, request) {
      if (refusal) throw refusal;
      requests.push({ id, request: structuredClone(request) });
      running.set(id, { type: 'busy' });
      emit('session.status', { sessionID: id, status: { type: 'busy' } });
      const user = { info: buildUserMessage({ id: request.messageID, sessionID: id, created: clock++, agent: request.agent, model: request.model }), parts: [] };
      user.parts = request.parts.map((part, index) => buildTextPart({
        id: `${request.messageID}_p${index}`, messageID: request.messageID, sessionID: id, text: part.text, start: clock++, end: clock++,
      }));
      const responseId = `assistant_${randomUUID()}`;
      const assistant = {
        info: buildAssistantMessage({ id: responseId, sessionID: id, parentID: user.info.id, created: clock++, completed: clock++,
          providerID: request.model.providerID, modelID: request.model.modelID, variant: request.variant, agent: request.agent, cwd: directory }),
        parts: [buildTextPart({ id: `${responseId}_p0`, messageID: responseId, sessionID: id, text: `Reply to ${request.parts[0]?.text ?? 'approval'}`, start: clock++, end: clock++ })],
      };
      sources.get(id).records.push(user, assistant);
      await registry.confirmSession(id);
      for (const record of [user, assistant]) {
        emit('message.updated', { info: record.info });
        for (const part of record.parts) emit('message.part.updated', { part });
      }
      if (!hold) complete(id);
      if (uncertain) throw new NativeAgentError('Delivery outcome unknown', { status: 502, code: 'NATIVE_PROMPT_OUTCOME_UNKNOWN' });
    },
    async loadMessages(id) {
      if (missing.has(id)) throw new Error('Source temporarily unreadable');
      return { records: sources.get(id).records, childSessions: [], complete: true, cursor: null, metadataComplete: !incomplete.has(id) };
    },
    async listSessions() {
      return { backends: Object.fromEntries(NATIVE_BACKENDS.map((backend) => [backend, { status: 'ok',
        sessions: [...sources.values()].map((source) => source.record).filter((record) => record.metadata.openchamber.native.backend === backend),
      }])) };
    },
    async statuses() { return Object.fromEntries(running); },
    async backgroundTasks() { return {}; },
    async questions() { return []; },
    async abort(id) { complete(id); return true; },
    async deleteSession(id) { operations.push(`delete:${id}`); sources.delete(id); await registry.removeSession(id); },
    async compact(id) { operations.push(`compact:${id}`); },
    async shutdown() {},
  };
  const sourceLifecycle = Object.fromEntries(NATIVE_BACKENDS.map((backend) => [backend, {
    async retire(id) { operations.push(`retire:${id}`); },
    async stop(id) { operations.push(`stop:${id}`); complete(id); },
    delete: backend !== 'antigravity', compact: backend !== 'antigravity',
  }]));
  const reverts = {
    async beforePrompt() {}, async afterTurn() {}, async cancelCommit() {}, async beginCommit() {}, async finishCommit() {}, async unrevert() {},
    async revert() { return { files: [] }; },
  };
  const create = () => createNativeConversations({ dataDir, native, registry, reverts, sourceLifecycle,
    publishNativeEvent: (event) => events.push(event), managedChatsRoots: [], now: () => clock++,
    smallModels,
  });
  controller = create();
  cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
  cleanups.push(() => controller.api.shutdown());
  const conversation = async (backend) => controller.api.createSession({ kind: 'unified', backend, directory, title: 'Unified fixture', selection: selection(backend) });
  const send = async (id, backend, text = backend, extra = {}) => {
    const request = { directory, messageID: `ncv_u_${randomUUID()}`, parts: [{ type: 'text', text }], ...selection(backend), ...extra };
    await controller.api.prompt(id, request);
    return request.messageID;
  };
  const history = (id, options = {}) => controller.api.loadMessages(id, directory, { limit: 100, ...options });
  return { get api() { return controller.api; }, controller, directory, registry, sources, requests, events, operations, missing, incomplete, native, sourceLifecycle,
    conversation, send, history, complete,
    hold: () => { hold = true; }, refuse: (error) => { refusal = error; }, uncertain: () => { uncertain = true; },
    async restart() { await controller.api.shutdown(); controller = create(); },
  };
};

describe('unified native backend contract', () => {
  it('restores AGY checklists only inside a logical conversation retained prefix', async () => {
    const h = await setup();
    const session = await h.conversation('antigravity');
    const firstUser = await h.send(session.id, 'antigravity');
    const sourceId = h.requests[0].id;
    const appendList = (revision, content, targetSource = sourceId) => {
      const input = { todos: [{ id: 'verify', content, status: 'pending' }] };
      const owner = h.sources.get(targetSource).records.at(-1);
      const part = buildToolPart({ id: `tool_${revision}`, sessionID: targetSource, messageID: owner.info.id,
        callID: `nag_t_fixture_${revision}`, tool: 'openchamber_checklist_update_checklist', input,
        title: 'update_checklist', start: 1, metadata: { nativeBackend: 'antigravity', openchamberToolSource: 'mcp' },
        result: { status: 'completed', output: checklistReceipt(input), end: 2 } });
      owner.parts.push(part);
    };
    appendList(2, 'Retained checklist');
    const initial = await h.api.checklist(session.id, h.directory);
    expect(initial).toMatchObject({ state: 'ready', items: [{ subject: 'Retained checklist' }] });
    const secondUser = await h.send(session.id, 'antigravity');
    appendList(8, 'Later checklist');
    const page = await h.history(session.id);
    const fork = await h.api.fork(session.id, secondUser, h.directory);
    expect(await h.api.checklist(fork.id, h.directory)).toMatchObject({ state: 'ready', items: [{ subject: 'Retained checklist' }] });
    expect((await h.api.checklist(fork.id, h.directory)).identity).not.toBe(initial.identity);
    await h.send(session.id, 'codex');
    await h.send(session.id, 'antigravity');
    appendList(20, 'Newest checklist', h.requests.at(-1).id);
    await h.api.revert(session.id, secondUser, h.directory);
    expect(await h.api.checklist(session.id, h.directory)).toMatchObject({ state: 'ready', items: [{ subject: 'Retained checklist' }] });
    await h.api.unrevert(session.id, h.directory);
    expect(await h.api.checklist(session.id, h.directory)).toMatchObject({ state: 'ready', items: [{ subject: 'Newest checklist' }] });
    expect(page.records[0].info.id).toBe(firstUser);
    await h.restart();
    expect(await h.api.checklist(fork.id, h.directory)).toMatchObject({ items: [{ subject: 'Retained checklist' }] });
  });
  it('summarizes the first AGY turn and keeps its title across source refreshes and restart', async () => {
    const generate = vi.fn(async () => ({ text: 'Improve tunnel reliability' }));
    const h = await setup({ smallModels: async () => ({ generateSmallModelText: generate }) });
    const session = await h.api.createSession({ kind: 'unified', backend: 'antigravity', directory: h.directory, selection: selection('antigravity') });
    await h.send(session.id, 'antigravity', '/plan Improve my tunnel\n<openchamber-instructions>hidden</openchamber-instructions>');
    await vi.waitFor(async () => expect((await h.api.getSession(session.id, h.directory)).title).toBe('Improve tunnel reliability'));
    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0][0]).toMatchObject({ preferredProviderID: 'antigravity-native', onOverflow: 'error' });
    expect(JSON.parse(generate.mock.calls[0][0].prompt).user).toBe('Improve my tunnel');
    const source = h.sources.get(h.requests[0].id);
    h.controller.publish({ directory: h.directory, payload: { type: 'session.updated', properties: { info: { ...source.record, title: '/plan original preview' } } } });
    await h.send(session.id, 'antigravity', 'A follow-up');
    await h.restart();
    expect((await h.api.getSession(session.id, h.directory)).title).toBe('Improve tunnel reliability');
    expect(generate).toHaveBeenCalledOnce();
  });

  it('summarizes the first DeepSeek turn and strips hidden instructions', async () => {
    const generate = vi.fn(async () => ({ text: 'Investigate context compaction' }));
    const h = await setup({ smallModels: async () => ({ generateSmallModelText: generate }) });
    const session = await h.api.createSession({ kind: 'unified', backend: 'deepseek', directory: h.directory, selection: selection('deepseek') });
    const first = '这个会话，明明没多少内容，为什么压缩了两次上下文\n<openchamber-instructions>hidden</openchamber-instructions>';
    await h.send(session.id, 'deepseek', first);
    await vi.waitFor(async () => expect((await h.api.getSession(session.id, h.directory)).title).toBe('Investigate context compaction'));
    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0][0]).toMatchObject({ preferredProviderID: 'deepseek-native', onOverflow: 'error' });
    expect(JSON.parse(generate.mock.calls[0][0].prompt).user).toBe('这个会话，明明没多少内容，为什么压缩了两次上下文');
    await h.send(session.id, 'deepseek', 'A follow-up');
    expect(generate).toHaveBeenCalledOnce();
    expect((await h.api.getSession(session.id, h.directory)).title).toBe('Investigate context compaction');
  });

  it('keeps a clean preview when title generation is unavailable and a manual rename wins a late result', async () => {
    const generated = Promise.withResolvers();
    const generate = vi.fn(() => generated.promise);
    const h = await setup({ smallModels: async () => ({ generateSmallModelText: generate }) });
    const session = await h.api.createSession({ kind: 'unified', backend: 'antigravity', directory: h.directory, selection: selection('antigravity') });
    await h.send(session.id, 'antigravity', '/plan Review the tunnel');
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    expect((await h.api.getSession(session.id, h.directory)).title).toBe('Review the tunnel');
    await h.api.updateSession(session.id, h.directory, { title: 'My title' });
    expect(generate.mock.calls[0][0].signal.aborted).toBe(true);
    generated.resolve({ text: 'Late title' });
    await new Promise((resolve) => setImmediate(resolve));
    expect((await h.api.getSession(session.id, h.directory)).title).toBe('My title');

    const unavailable = await setup();
    const other = await unavailable.api.createSession({ kind: 'unified', backend: 'antigravity', directory: unavailable.directory, selection: selection('antigravity') });
    await unavailable.send(other.id, 'antigravity', '/plan A clean preview');
    await unavailable.send(other.id, 'antigravity', 'Keep planning');
    expect((await unavailable.api.getSession(other.id, unavailable.directory)).title).toBe('A clean preview');
  });

  it('does not generate AGY titles after enterprise mode is enabled', async () => {
    const generate = vi.fn(async () => ({ text: 'Should not run' }));
    const h = await setup({ smallModels: async () => ({ generateSmallModelText: generate }) });
    const session = await h.api.createSession({ kind: 'unified', backend: 'antigravity', directory: h.directory, selection: selection('antigravity') });
    h.hold();
    await h.send(session.id, 'antigravity');
    vi.stubEnv('OPENCHAMBER_ENTERPRISE_MODE', '1');
    h.complete(h.requests[0].id);
    await new Promise((resolve) => setImmediate(resolve));
    expect(generate).not.toHaveBeenCalled();
  });

  it('does not generate DeepSeek titles in enterprise mode', async () => {
    const generate = vi.fn(async () => ({ text: 'Should not run' }));
    const h = await setup({ smallModels: async () => ({ generateSmallModelText: generate }) });
    const session = await h.api.createSession({ kind: 'unified', backend: 'deepseek', directory: h.directory, selection: selection('deepseek') });
    h.hold();
    await h.send(session.id, 'deepseek');
    vi.stubEnv('OPENCHAMBER_ENTERPRISE_MODE', '1');
    h.complete(h.requests[0].id);
    await new Promise((resolve) => setImmediate(resolve));
    expect(generate).not.toHaveBeenCalled();
  });

  it('retains a pending first-source title when execution switches to another CLI', async () => {
    const generated = Promise.withResolvers();
    const generate = vi.fn(() => generated.promise);
    const h = await setup({ smallModels: async () => ({ generateSmallModelText: generate }) });
    const session = await h.api.createSession({ kind: 'unified', backend: 'antigravity', directory: h.directory, selection: selection('antigravity') });
    await h.send(session.id, 'antigravity', '/plan Review the tunnel');
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    await h.send(session.id, 'deepseek', 'Implement the plan');
    generated.resolve({ text: 'Improve tunnel reliability' });
    await vi.waitFor(async () => expect((await h.api.getSession(session.id, h.directory)).title).toBe('Improve tunnel reliability'));
    expect((await h.api.getSession(session.id, h.directory)).model.providerID).toBe('deepseek-native');
  });

  it('rechecks enterprise policy after resolving the title service', async () => {
    const generate = vi.fn(async () => ({ text: 'Should not run' }));
    const resolveService = vi.fn(async () => {
      vi.stubEnv('OPENCHAMBER_ENTERPRISE_MODE', '1');
      return { generateSmallModelText: generate };
    });
    const h = await setup({ smallModels: resolveService });
    const session = await h.api.createSession({ kind: 'unified', backend: 'antigravity', directory: h.directory, selection: selection('antigravity') });
    await h.send(session.id, 'antigravity');
    await vi.waitFor(() => expect(resolveService).toHaveBeenCalledOnce());
    expect(generate).not.toHaveBeenCalled();
  });

  it('applies all combination roles atomically and rejects a stale writer', async () => {
    const h = await setup();
    h.native.validateAgentConfiguration = async (configuration) => configuration;
    const session = await h.conversation('claude');
    const configuration = { subagent: { model: selection('codex').model, variant: 'high' }, execution: { model: selection('deepseek').model, variant: 'high' }, combination: { id: randomUUID(), name: 'Mixed team' } };
    const updated = await h.api.configureAgents(session.id, h.directory, configuration, 0, selection('antigravity'), 0);
    expect(updated.model.providerID).toBe('antigravity-native');
    expect(updated.metadata.openchamber.native.agents).toEqual({ ...configuration, revision: 1 });
    expect(h.requests).toHaveLength(0);
    await expect(h.api.configureAgents(session.id, h.directory, { subagent: null, execution: null }, 0, selection('claude'), 1))
      .rejects.toMatchObject({ code: 'NATIVE_CONVERSATION_SELECTION_CONFLICT' });
    const held = await h.api.getSession(session.id, h.directory);
    expect(held.model.providerID).toBe('antigravity-native');
    expect(held.metadata.openchamber.native.agents.subagent.model.providerID).toBe('codex-native');
    await h.send(session.id, 'antigravity');
    expect((await h.registry.getSession(h.requests[0].id)).agentConfiguration).toEqual({ ...configuration, revision: 1 });
  });
  it('captures a combination during creation without retaining the editable preset object', async () => {
    const h = await setup();
    h.native.validateAgentConfiguration = async (configuration) => configuration;
    const configuration = { subagent: { model: selection('codex').model }, execution: { model: selection('deepseek').model } };
    const session = await h.api.createSession({ kind: 'unified', backend: 'claude', directory: h.directory, selection: selection('claude'), configuration });
    configuration.subagent.model.modelID = 'edited-preset';
    const held = await h.api.getSession(session.id, h.directory);
    expect(held.metadata.openchamber.native.agents.subagent.model.modelID).toBe('codex-model');
    expect(held.metadata.openchamber.native.agents.revision).toBe(1);
  });
  it('keeps every prior role when validation of a combination fails', async () => {
    const h = await setup();
    const session = await h.conversation('claude');
    h.native.validateAgentConfiguration = async () => { throw new NativeAgentError('Model unavailable', { code: 'NATIVE_CONVERSATION_MODEL_UNAVAILABLE', status: 409 }); };
    await expect(h.api.configureAgents(session.id, h.directory, { subagent: null, execution: null }, 0, selection('codex'), 0)).rejects.toMatchObject({ code: 'NATIVE_CONVERSATION_MODEL_UNAVAILABLE' });
    const held = await h.api.getSession(session.id, h.directory);
    expect(held.model.providerID).toBe('claude-native');
    expect(held.metadata.openchamber.native.agents).toBeUndefined();
  });
  it.each(pairs)('executes an approved %s plan on %s and settles the logical approval after handoff', async (from, to) => {
    const h = await setup();
    const session = await h.conversation(from);
    h.hold();
    await h.send(session.id, from, 'Prepare a plan', { agent: 'plan' });
    const source = h.requests[0].id;
    const record = h.sources.get(source).records.at(-1);
    record.parts.push(buildToolPart({
      id: `${record.info.id}_plan`, sessionID: source, messageID: record.info.id, callID: 'plan-call',
      tool: 'plan_exit', input: { plan: '# Approved native plan' }, title: 'Plan', start: 1, metadata: {}, result: null,
    }));
    let execution;
    const outcomes = [];
    const questions = createQuestionRegistry({
      publish: (directory, payload) => h.controller.publish({ directory, payload: { id: randomUUID(), ...payload } }),
      executePlan: (...args) => execution.execute(...args),
    });
    h.native.questions = async () => questions.list(h.directory);
    h.native.replyQuestion = (...args) => questions.reply(...args);
    execution = createNativePlanExecution({
      registry: h.registry, questions, interactions: { record: async () => {} },
      sourceSelection: async () => ({ model: selection(from).model, variant: 'high' }),
      validate: (...args) => h.controller.validatePlanExecution(...args),
      readHistory: async () => h.sources.get(source).records,
      yieldSource: async () => h.complete(source),
      prompt: (...args) => h.controller.automaticPrompt(...args),
      confirm: (...args) => h.controller.planExecutionOutcome(...args),
      failed: (_directory, _id, error) => { throw error; },
    });
    cleanups.push(() => execution.shutdown());
    void questions.ask({
      directory: h.directory, sessionID: source, kind: `${from}-plan-exit`,
      tool: { messageID: record.info.id, callID: 'plan-call' },
      questions: [{ header: 'Plan', question: '# Approved native plan', options: [{ label: 'build', description: '' }, { label: 'plan', description: '' }] }],
      onReply: async (outcome) => { outcomes.push(outcome.status); },
    });
    const [question] = await h.api.questions(h.directory);
    const current = await h.api.getSession(session.id, h.directory);
    const selected = { model: selection(to).model, variant: 'high', expectedRevision: current.metadata.openchamber.native.revision };
    await expect(h.api.replyQuestion(question.id, [['build']], { ...selected, expectedRevision: selected.expectedRevision + 1 }))
      .rejects.toMatchObject({ code: 'NATIVE_CONVERSATION_SELECTION_CONFLICT' });
    expect(outcomes).toEqual([]);
    expect(h.requests).toHaveLength(1);
    h.native.backgroundTasks = async () => ({ [source]: { directory: h.directory, tasks: [{ id: 'background', type: 'local_bash', description: 'Still working' }] } });
    await expect(h.api.replyQuestion(question.id, [['build']], selected)).rejects.toMatchObject({ code: 'NATIVE_SESSION_BUSY' });
    expect(outcomes).toEqual([]);
    h.native.backgroundTasks = async () => ({});
    await h.api.replyQuestion(question.id, [['build']], selected);
    expect(outcomes).toEqual(['transferred']);
    expect(h.requests).toHaveLength(2);
    const target = h.requests[1];
    expect(target.id).not.toBe(source);
    expect(target.request.model).toEqual(selected.model);
    expect(target.request.agent).toBe('build');
    expect(target.request.instructions).toContain('# Approved native plan');
    expect(target.request.messageID).toMatch(new RegExp(`^${{ claude: 'ncl', codex: 'ncx', antigravity: 'nag', deepseek: 'ndh' }[to]}_u_`));
    expect(h.events.some((event) => event.payload.type === 'question.replied' && event.payload.properties.sessionID === session.id && event.payload.properties.requestID === question.id)).toBe(true);
    expect((await h.api.getSession(session.id, h.directory)).model).toMatchObject({ providerID: selected.model.providerID, id: selected.model.modelID });
  });

  it('keeps UI and server identities aligned and requires every registered backend lifecycle', async () => {
    expect(UI_BACKENDS).toEqual(NATIVE_BACKENDS);
    expect(NATIVE_BACKENDS.map(nativeProviderIdOf)).toEqual(nativeProviderSchema.options);
    const h = await setup();
    expect(nativeCapabilitiesSchema.parse(await h.api.capabilities()).unifiedBackends).toEqual(NATIVE_BACKENDS);
    expect(Object.keys((await h.api.capabilities()).backends)).toEqual(NATIVE_BACKENDS);
    for (const backend of NATIVE_BACKENDS) {
      const lifecycles = { ...h.sourceLifecycle };
      delete lifecycles[backend];
      expect(() => createNativeConversations({ sourceLifecycle: lifecycles })).toThrow('needs unified conversation lifecycle support');
      lifecycles[backend] = { ...h.sourceLifecycle[backend], retire: undefined };
      expect(() => createNativeConversations({ sourceLifecycle: lifecycles })).toThrow();
    }
  });

  it.each(pairs)('switches %s to %s with stable live and saved identities and source retirement', async (from, to) => {
    const h = await setup();
    const session = await h.conversation(from);
    const firstId = await h.send(session.id, from, 'Remember the exact value 5173');
    const firstSource = h.requests[0].id;
    const secondId = await h.send(session.id, to, 'Continue using the value');
    const second = h.requests[1];
    expect(second.id).not.toBe(firstSource);
    expect(second.request.instructions).toContain('5173');
    expect(second.request.instructions).toContain('not a request to replay tools or approvals');
    expect(second.request.variant).toBe('high');
    expect(h.operations.indexOf(`retire:${firstSource}`)).toBeLessThan(h.operations.indexOf(`create:${second.id}`));
    const page = await h.history(session.id);
    expect(nativeMessagePageSchema.parse(page).records).toHaveLength(4);
    expect(page.records.filter((record) => record.info.role === 'user').map((record) => record.info.id)).toEqual([firstId, secondId]);
    expect(page.records.filter((record) => record.info.role === 'assistant').map((record) => record.info.parentID)).toEqual([firstId, secondId]);
    const live = h.events.filter((event) => event.payload.type === 'message.updated').map((event) => event.payload.properties.info.id);
    expect(live).toEqual(page.records.map((record) => record.info.id));
    const listed = await h.api.listSessions(h.directory);
    expect(Object.values(listed.backends).flatMap((partition) => partition.sessions)).toEqual([]);
    expect(listed.unified.sessions.map((record) => record.id)).toEqual([session.id]);
    await h.restart();
    expect((await h.history(session.id)).records).toEqual(page.records);
    const restored = await h.api.getSession(session.id, h.directory);
    expect(restored.metadata.openchamber.native.backend).toBe(to);
    expect(restored.metadata.openchamber.native.unifiedBackends).toEqual(NATIVE_BACKENDS);
  });

  it.each(NATIVE_BACKENDS)('continues %s on the same source and preserves a newer selection for queued work', async (backend) => {
    const h = await setup();
    const session = await h.conversation(backend);
    await h.send(session.id, backend);
    const nextBackend = NATIVE_BACKENDS.find((entry) => entry !== backend);
    const current = await h.api.getSession(session.id, h.directory);
    await h.api.selectModel(session.id, h.directory, selection(nextBackend), current.metadata.openchamber.native.revision);
    await h.send(session.id, backend, 'Captured follow-up', { preserveSelection: true });
    expect(h.requests[1].id).toBe(h.requests[0].id);
    const updated = await h.api.getSession(session.id, h.directory);
    expect(updated.model.providerID).toBe(nativeProviderIdOf(nextBackend));
    expect(updated.metadata.openchamber.native.backend).toBe(backend);
  });

  it('refuses deletion before any cleanup when retained or orphaned Antigravity sources exist', async () => {
    const h = await setup();
    const session = await h.conversation('claude');
    await h.send(session.id, 'claude');
    await h.send(session.id, 'antigravity');
    await h.send(session.id, 'codex');
    expect((await h.api.getSession(session.id, h.directory)).metadata.openchamber.native.actions.delete).toBe(false);
    const before = [...h.operations];
    await expect(h.api.deleteSession(session.id, h.directory)).rejects.toMatchObject({ code: 'NATIVE_CONVERSATION_DELETE_UNSUPPORTED' });
    expect(h.operations).toEqual(before);
    const fork = await h.api.fork(session.id, null, h.directory);
    expect(fork.metadata.openchamber.native.actions).toMatchObject({ revert: true, fork: true, delete: false });
    const archived = await h.api.updateSession(session.id, h.directory, { archived: true });
    expect(archived.time.archived).toBeGreaterThan(0);
    expect(await h.history(fork.id)).toMatchObject({ complete: true, records: expect.any(Array) });

    const other = await h.conversation('codex');
    await h.send(other.id, 'codex');
    h.refuse(new NativeAgentError('Prompt refused', { code: 'NATIVE_INVALID_REQUEST', status: 400 }));
    await expect(h.send(other.id, 'antigravity')).rejects.toMatchObject({ code: 'NATIVE_INVALID_REQUEST' });
    await h.restart();
    expect((await h.api.getSession(other.id, h.directory)).metadata.openchamber.native.actions.delete).toBe(false);
    await expect(h.api.deleteSession(other.id, h.directory)).rejects.toMatchObject({ code: 'NATIVE_CONVERSATION_DELETE_UNSUPPORTED' });
  });

  it('keeps shared sources until the final conversation is deleted', async () => {
    const h = await setup();
    const session = await h.conversation('codex');
    await h.send(session.id, 'codex');
    const source = h.requests[0].id;
    const fork = await h.api.fork(session.id, null, h.directory);
    await h.api.deleteSession(session.id, h.directory);
    expect(h.sources.has(source)).toBe(true);
    expect((await h.history(fork.id)).records).toHaveLength(2);
    await h.api.deleteSession(fork.id, h.directory);
    expect(h.sources.has(source)).toBe(false);
  });

  it('keeps readable recent history while blocking incomplete or failed handoffs', async () => {
    const h = await setup();
    const session = await h.conversation('antigravity');
    await h.send(session.id, 'antigravity');
    const source = h.requests[0].id;
    await h.send(session.id, 'codex');
    h.missing.add(source);
    const page = await h.history(session.id);
    expect(page.records).toHaveLength(2);
    expect(page).toMatchObject({ historyUnavailable: true, complete: false, cursor: expect.any(String) });
    await expect(h.send(session.id, 'claude')).rejects.toThrow('unreadable');
    expect(h.requests).toHaveLength(2);
    h.missing.clear();
    h.incomplete.add(source);
    await expect(h.send(session.id, 'deepseek')).rejects.toMatchObject({ code: 'NATIVE_CONVERSATION_HISTORY_UNAVAILABLE' });
    h.incomplete.clear();
    expect((await h.history(session.id)).records).toHaveLength(4);
  });

  it('still stops the main source when delegated cleanup prevents archiving', async () => {
    const h = await setup();
    const session = await h.conversation('claude');
    h.hold();
    await h.send(session.id, 'claude');
    h.native.cancelDelegations = async () => { throw new Error('Subagent cleanup incomplete'); };
    await expect(h.api.updateSession(session.id, h.directory, { archived: true })).rejects.toThrow('Subagent cleanup incomplete');
    expect(h.operations).toContain(`stop:${h.requests[0].id}`);
  });

  it('blocks backend changes while live work runs and ignores late events from retired sources', async () => {
    const h = await setup();
    const session = await h.conversation('antigravity');
    h.hold();
    await h.send(session.id, 'antigravity');
    const old = h.requests[0].id;
    await expect(h.send(session.id, 'codex')).rejects.toMatchObject({ code: 'NATIVE_SESSION_BUSY' });
    await h.api.abort(session.id);
    await h.send(session.id, 'codex');
    const count = h.events.length;
    h.controller.publish({ directory: h.directory, payload: { type: 'message.part.delta', properties: { sessionID: old, messageID: 'old', partID: 'old', field: 'text', delta: 'late' } } });
    expect(h.events).toHaveLength(count);
    expect((await h.api.getSession(session.id, h.directory)).metadata.openchamber.native.backend).toBe('codex');
  });

  it('confirms uncertain native admissions from history without replaying them', async () => {
    const h = await setup();
    const session = await h.conversation('antigravity');
    h.uncertain();
    const request = { ...selection('antigravity'), directory: h.directory, messageID: `ncv_u_${randomUUID()}`, parts: [{ type: 'text', text: 'Exactly once' }] };
    await expect(h.api.prompt(session.id, request)).rejects.toMatchObject({ code: 'NATIVE_PROMPT_OUTCOME_UNKNOWN' });
    await h.restart();
    await h.api.getSession(session.id, h.directory);
    await h.api.prompt(session.id, request);
    expect(h.requests).toHaveLength(1);
    expect((await h.history(session.id)).records[0].info.id).toBe(request.messageID);
  });

  it.each([
    ['response', 'not-dispatched'], ['timeout', 'unknown'], ['transport', 'unknown'],
  ])('reports a Codex %s to the approval owner as %s', async (kind, expected) => {
    const h = await setup();
    const session = await h.conversation('claude');
    await h.send(session.id, 'claude');
    const source = h.requests[0].id;
    const callbacks = [];
    const state = { logicalMessageID: `ncv_u_${randomUUID()}` };
    h.refuse(new JsonRpcError('Scripted Codex refusal', -32600, kind));
    await expect(h.controller.automaticPrompt(source, {
      ...selection('codex'), directory: h.directory, messageID: `ncl_u_${randomUUID()}`,
      parts: [], preserveSelection: true,
    }, undefined, {
      logicalMessageId: state.logicalMessageID,
      onDispatched: async () => { callbacks.push('dispatched'); },
      onRefused: async () => { callbacks.push('refused'); },
    })).rejects.toThrow();
    expect(callbacks).toEqual(expected === 'not-dispatched' ? ['dispatched', 'refused'] : ['dispatched']);
    expect(await h.controller.planExecutionOutcome(source, h.directory, state)).toBe(expected);
    if (expected === 'unknown') expect(h.operations.filter((entry) => entry.startsWith('delete:'))).toEqual([]);
  });

  it('rewinds and forks Antigravity history through logical retained boundaries', async () => {
    const h = await setup();
    const session = await h.conversation('antigravity');
    const first = await h.send(session.id, 'antigravity', 'Keep this');
    const cut = await h.send(session.id, 'antigravity', 'Discard this');
    await h.api.revert(session.id, cut, h.directory);
    await h.send(session.id, 'codex', 'Replacement');
    const page = await h.history(session.id);
    expect(page.records).toHaveLength(4);
    expect(page.records[0].info.id).toBe(first);
    expect(page.records.some((record) => record.info.id === cut)).toBe(false);
    expect(h.requests.at(-1).request.instructions).toContain('Keep this');
    expect(h.requests.at(-1).request.instructions).not.toContain('Discard this');
  });

  it('refuses manual compaction for the executing Antigravity source', async () => {
    const h = await setup();
    const session = await h.conversation('antigravity');
    await h.send(session.id, 'antigravity');
    await expect(h.api.compact(session.id, { directory: h.directory, ...selection('antigravity') }))
      .rejects.toMatchObject({ code: 'NATIVE_CONVERSATION_COMPACT_UNSUPPORTED' });
    expect(h.operations.some((entry) => entry.startsWith('compact:'))).toBe(false);
  });

  it('enforces enterprise mode before creating, sending or continuing a mixed conversation', async () => {
    const h = await setup();
    const session = await h.conversation('antigravity');
    vi.stubEnv('OPENCHAMBER_ENTERPRISE_MODE', '1');
    expect((await h.api.capabilities()).unifiedBackends).toEqual([]);
    await expect(h.conversation('antigravity')).rejects.toMatchObject({ code: 'enterprise_mode', status: 403 });
    await expect(h.send(session.id, 'antigravity')).rejects.toMatchObject({ code: 'enterprise_mode', status: 403 });
    expect(h.requests).toEqual([]);
    expect((await h.api.listSessions(h.directory)).unified.sessions.map((entry) => entry.id)).toEqual([session.id]);
  });
});
