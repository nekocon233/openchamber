import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeRegistry } from './registry.js';
import { createNativeDelegation } from './delegation.js';
import { NATIVE_BACKENDS } from './ids.js';

const cleanup = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const work of cleanup.splice(0).reverse()) await work(); });
const idOf = (backend) => backend === 'deepseek' ? `ndh_${createHash('sha256').update(randomUUID()).digest('hex')}` : `${{ claude: 'ncl', codex: 'ncx', antigravity: 'nag' }[backend]}_${randomUUID()}`;
const modelOf = (backend) => ({ model: { providerID: `${backend}-native`, modelID: 'selected-model' }, variant: 'high' });
const setup = async (from, to) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-delegation-test-'));
  cleanup.push(() => fs.rm(directory, { recursive: true, force: true }));
  const registry = createNativeRegistry({ filePath: path.join(directory, 'registry.json') });
  const root = idOf(from);
  await registry.registerSession(root, { backend: from, nativeId: root, directory, origin: 'openchamber', createdAt: 1 });
  await registry.setAgentConfiguration(root, { subagent: modelOf(to), execution: null }, 0);
  const calls = [];
  const histories = new Map();
  let refusal;
  let paused = false;
  let release;
  const deletions = [];
  const native = {
    catalog: async () => ({ backends: Object.fromEntries(NATIVE_BACKENDS.map((backend) => [backend, { status: 'ok', models: [{ id: 'selected-model', efforts: ['high'], fast: false }] }])) }),
    prompt: async (id, request) => {
      calls.push({ id, request });
      if (paused) await new Promise((resolve) => { release = resolve; });
      if (refusal) throw refusal;
      histories.set(id, { complete: true, records: [
        { info: { id: request.messageID, role: 'user' }, parts: [] },
        { info: { id: 'assistant_answer', role: 'assistant', time: { completed: 2 } }, parts: [{ type: 'text', text: 'delegated result' }] },
      ] });
    },
    loadMessages: async (id) => histories.get(id) ?? { complete: true, records: [] },
    statuses: async () => ({}),
    getSession: async (id) => ({ id, directory }),
    abort: async () => { release?.(); return true; },
    deleteSession: async (id) => { deletions.push(id); histories.delete(id); await registry.removeSession(id); },
  };
  const delegation = createNativeDelegation({ dataDir: directory, registry, native, resolveNode: async () => process.execPath,
    createSession: async (input, { beforePublish }) => {
      const id = idOf(input.backend);
      await registry.registerSession(id, { backend: input.backend, nativeId: id, directory, origin: 'openchamber', createdAt: 1 });
      const record = { id, directory };
      await beforePublish(record);
      return record;
    },
  });
  cleanup.push(() => delegation.shutdown());
  const tools = await delegation.prepare(root, { directory, messageID: 'parent_message', agent: 'plan' });
  const call = async (id = 'call-1', token = tools.env.OPENCHAMBER_DELEGATION_TOKEN) => {
    const response = await fetch(tools.env.OPENCHAMBER_DELEGATION_URL, { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, prompt: 'Analyze this task', description: 'Analyze task' }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { directory, registry, root, calls, delegation, call, native, tools, histories, deletions,
    pause: () => { paused = true; }, refuse: (error) => { refusal = error; } };
};

describe('native cross-CLI delegation', () => {
  it('coalesces simultaneous retries and renews callbacks after a stop', async () => {
    const context = await setup('claude', 'codex');
    context.pause();
    const first = context.call();
    const second = context.call();
    await vi.waitFor(() => expect(context.calls).toHaveLength(1));
    await context.native.abort();
    expect((await first).body.taskID).toBe((await second).body.taskID);
    await context.delegation.cancel(context.root);
    const next = await context.delegation.prepare(context.root, { directory: context.directory, messageID: 'next-message', agent: 'build' });
    expect(next.key).not.toBe(context.tools.key);
    expect(next.env.OPENCHAMBER_DELEGATION_TOKEN).not.toBe(context.tools.env.OPENCHAMBER_DELEGATION_TOKEN);
    expect((await context.call('stale-callback')).status).toBe(403);
  });
  it('does not persist upstream failure text in its dispatch journal', async () => {
    const context = await setup('claude', 'codex');
    context.refuse(Object.assign(new Error('private task text'), { code: 'NATIVE_MODEL_REFUSED' }));
    await context.call();
    const journal = await fs.readFile(path.join(context.directory, 'native-agents', 'delegations.json'), 'utf8');
    expect(journal).not.toContain('private task text');
    expect(JSON.parse(journal).jobs[0].phase).toBe('error');
  });
  it('keeps a long request readable and reports a later cancellation in its JSON body', async () => {
    const context = await setup('claude', 'codex');
    context.pause();
    const response = await fetch(context.tools.env.OPENCHAMBER_DELEGATION_URL, { method: 'POST',
      headers: { Authorization: `Bearer ${context.tools.env.OPENCHAMBER_DELEGATION_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'long-task', prompt: 'Analyze this task' }),
    });
    const reader = response.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('\n');
    await context.delegation.cancel(context.root);
    let contents = '';
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; contents += new TextDecoder().decode(chunk.value); }
    expect(JSON.parse(contents).code).toBe('NATIVE_DELEGATION_INTERRUPTED');
    expect(context.calls).toHaveLength(1);
  }, 15000);
  it('uses a queued subagent snapshot while preserving the next-turn selection', async () => {
    const context = await setup('claude', 'codex');
    await context.registry.setAgentConfiguration(context.root, { subagent: modelOf('deepseek'), execution: null }, 1);
    await context.delegation.prepare(context.root, { directory: context.directory, messageID: 'queued-message', agent: 'plan', subagentModel: modelOf('codex') });
    expect((await context.call()).status).toBe(200);
    expect(context.calls[0].request.model.providerID).toBe('codex-native');
    expect((await context.registry.getSession(context.root)).agentConfiguration.subagent.model.providerID).toBe('deepseek-native');
  });
  it('does not replace an in-flight callback when a later turn selects CLI defaults', async () => {
    const context = await setup('claude', 'codex');
    context.native.statuses = async () => ({ [context.root]: { type: 'busy' } });
    await expect(context.delegation.prepare(context.root, { directory: context.directory, messageID: 'next-message', agent: 'build', subagentModel: null }))
      .rejects.toMatchObject({ code: 'NATIVE_SESSION_BUSY' });
    expect((await context.call()).status).toBe(200);
    expect(context.calls[0].request.model.providerID).toBe('codex-native');
  });
  it('keeps a session but blocks execution after its subagent settings become unreadable', async () => {
    const context = await setup('claude', 'codex');
    await context.registry.updateSession(context.root, { agentConfiguration: { damaged: true } });
    expect((await context.registry.getSession(context.root)).agentConfiguration.unavailable).toBe(true);
    await expect(context.delegation.prepare(context.root, { directory: context.directory, messageID: 'next-message', agent: 'build' }))
      .rejects.toMatchObject({ code: 'NATIVE_DELEGATION_UNAVAILABLE' });
  });
  it('denies child dispatches at the runtime boundary', async () => {
    const context = await setup('claude', 'codex');
    const first = await context.call();
    const tools = await context.delegation.prepare(first.body.sessionID, { directory: context.directory, messageID: 'child-message', agent: 'build' });
    const response = await fetch(tools.env.OPENCHAMBER_DELEGATION_URL, { method: 'POST', headers: { Authorization: `Bearer ${tools.env.OPENCHAMBER_DELEGATION_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'nested', prompt: 'Nested task' }) });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('NATIVE_DELEGATION_DEPTH');
    expect(context.calls).toHaveLength(1);
  });
  it('stops a pending child when its parent is cancelled and refuses a late new dispatch', async () => {
    const context = await setup('claude', 'codex');
    context.pause();
    const response = context.call();
    await vi.waitFor(() => expect(context.calls).toHaveLength(1));
    await context.delegation.cancel(context.root);
    expect((await response).body.code).toBe('NATIVE_DELEGATION_INTERRUPTED');
    expect((await context.call('late-task')).status).toBe(403);
    expect(context.calls).toHaveLength(1);
  });
  it('retains shared subagent histories and cleans exclusive children on parent deletion', async () => {
    const context = await setup('claude', 'codex');
    await context.call();
    await context.delegation.removeChildren(context.root, new Set([context.root]));
    expect(context.deletions).toEqual([]);
    await context.delegation.removeChildren(context.root);
    expect(context.deletions).toEqual([context.calls[0].id]);
    expect(await context.delegation.children(context.root)).toEqual([]);
  });
  it('refuses deletion before removing any retained Antigravity child', async () => {
    const context = await setup('claude', 'antigravity');
    await context.call();
    await expect(context.delegation.removeChildren(context.root)).rejects.toMatchObject({ code: 'NATIVE_CONVERSATION_DELETE_UNSUPPORTED' });
    expect(context.deletions).toEqual([]);
  });
  it('checks enterprise policy again at callback time', async () => {
    const context = await setup('claude', 'codex');
    vi.stubEnv('OPENCHAMBER_ENTERPRISE_MODE', '1');
    expect((await context.call()).status).toBe(403);
    expect(context.calls).toEqual([]);
  });
  for (const from of NATIVE_BACKENDS) for (const to of NATIVE_BACKENDS) {
    it(`dispatches ${from} tasks through the selected ${to} runtime`, async () => {
      const context = await setup(from, to);
      const result = await context.call();
      expect(result.status).toBe(200);
      expect(result.body.text).toBe('delegated result');
      expect(context.calls).toHaveLength(1);
      expect(context.calls[0].request).toMatchObject({ model: modelOf(to).model, variant: 'high', agent: 'plan' });
      expect((await context.registry.getSession(result.body.sessionID)).delegation).toMatchObject({ parentID: context.root, jobID: result.body.taskID });
      expect((await context.call()).body.taskID).toBe(result.body.taskID);
      expect(context.calls).toHaveLength(1);
    });
  }
  it('rejects a forged callback before a child is created', async () => {
    const context = await setup('claude', 'codex');
    expect((await context.call('forged', 'invalid')).status).toBe(403);
    expect(context.calls).toEqual([]);
  });
  it('does not repeat a dispatch whose acceptance could not be confirmed', async () => {
    const context = await setup('claude', 'codex');
    context.refuse(new Error('response lost'));
    expect((await context.call()).status).toBe(500);
    expect((await context.call()).body.code).toBe('NATIVE_DELEGATION_OUTCOME_UNKNOWN');
    expect(context.calls).toHaveLength(1);
  });
  it('requires the expected revision when updating a session selection', async () => {
    const context = await setup('claude', 'codex');
    expect(await context.registry.setAgentConfiguration(context.root, { subagent: modelOf('deepseek'), execution: null }, 0)).toBeNull();
    expect((await context.registry.getSession(context.root)).agentConfiguration.subagent).toEqual(modelOf('codex'));
  });
});
