import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createHiddenSessionRegistry } from '../opencode/hidden-sessions.js';
import { createAgentMemoryRuntime } from './runtime.js';
import { buildDreamPrompt, createMemoryDreaming, diffDream } from './dreaming.js';
import { withMemoryFileLock } from './file-lock.js';

const PROJECT_DIR = '/work/acme';
const PROJECT_ID = 'path_acme';
const PROJECT = { scope: 'project', projectId: PROJECT_ID };
const DAY = 24 * 60 * 60 * 1000;

let rootDir;
let memory;
let idCounter;

beforeEach(async () => {
  rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-dreaming-'));
  idCounter = 0;
  memory = createAgentMemoryRuntime({
    fsPromises,
    path,
    userConfigRoot: path.join(rootDir, 'config'),
    projectsDirPath: path.join(rootDir, 'config', 'projects'),
    createId: () => `mem-${++idCounter}`,
  });
});

afterEach(async () => {
  await fsPromises.rm(rootDir, { recursive: true, force: true });
});

const WORDS = ['amber', 'basalt', 'cobalt', 'dune', 'ember', 'fjord', 'granite', 'harbor', 'indigo', 'jasper', 'kelp', 'lagoon', 'meadow', 'nickel'];

const fill = async (count, target = PROJECT) => {
  for (let index = 0; index < count; index += 1) {
    const word = WORDS[index];
    await memory.create(target, { title: `Fact ${index}`, body: `${word} ${word}stone ${word}field ${word}wood` });
  }
};

/**
 * A stand-in OpenCode: records each request, answers the routes a pass uses,
 * and plays the agent on `prompt` through `onPrompt`.
 */
const createOpenCode = ({ active = {}, onPrompt = async () => {}, reply = 'Done.\nDREAM {"project": 1, "global": 0, "toDocs": ["mem-6", "mem-3"]}', hangWait = false } = {}) => {
  // The pass's own session reads as running for one look after its prompt, or for good with `hangWait`.
  let runningLooks = 0;
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const { pathname, search } = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, pathname, search, body, headers: init.headers });
    const json = (value) => new Response(JSON.stringify(value), { status: 200 });
    if (method === 'GET' && pathname === '/api/session/active') {
      const prompt = calls.find((call) => call.method === 'POST' && call.pathname.endsWith('/prompt'));
      if (!prompt) return json({ data: active });
      const sessionID = prompt.pathname.split('/')[3];
      runningLooks += 1;
      return json({ data: hangWait || runningLooks <= 1 ? { [sessionID]: { type: 'running' } } : {} });
    }
    if (method === 'GET' && pathname === '/api/session') return json({ data: [] });
    if (method === 'POST' && pathname === '/api/session') return json({ data: { id: 'ses_dream' } });
    if (method === 'POST' && pathname.endsWith('/prompt')) {
      await onPrompt(body);
      return json({ data: {} });
    }
    if (method === 'POST' && pathname.endsWith('/wait')) {
      if (hangWait) {
        await new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
      }
      return json({ data: {} });
    }
    if (method === 'GET' && pathname.endsWith('/message')) {
      return json({ data: [{ type: 'assistant', content: [{ type: 'text', text: reply }] }] });
    }
    return json({});
  };
  return { calls, fetchImpl };
};

const createDreaming = ({ openCode, settings = {}, clock = { now: Date.now() }, hiddenSessions = createHiddenSessionRegistry(), passTimeoutMs, resolveProjectId = async () => PROJECT_ID, log = () => {}, ...dependencies } = {}) => createMemoryDreaming({
  agentMemoryRuntime: memory,
  readSettings: async () => ({
    agentMemoryToolEnabled: true,
    agentMemoryDreamingEnabled: true,
    projects: [{ id: 'acme', path: PROJECT_DIR }],
    ...settings,
  }),
  resolveProjectId,
  measureIndex: () => ({ budget: 8000, used: 100, omitted: 0 }),
  hiddenSessions,
  buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
  getOpenCodeAuthHeaders: () => ({}),
  resolveSessionDefaults: () => ({ providerID: 'zai', modelID: 'glm', variant: null, agent: null }),
  nativeDreamAllowed: () => true,
  fetchImpl: openCode.fetchImpl,
  now: () => clock.now,
  setTimer: (callback, ms) => setTimeout(callback, Math.min(ms, passTimeoutMs ?? ms)),
  passTimeoutMs,
  pollIntervalMs: 1,
  log,
  ...dependencies,
});

describe('native CLI memory organizing', () => {
  const plan = {
    rewrites: [{ scope: 'project', id: 'mem-1', title: 'Merged fact', body: 'Both useful details stay.' }],
    removals: [{ scope: 'project', id: 'mem-2', mergedInto: 'mem-1' }],
    toDocs: ['mem-3'],
  };
  const generate = async () => ({ text: JSON.stringify(plan) });

  for (const selection of [
    { model: 'codex-native/test', variant: 'high-fast', explicit: true },
    { model: 'claude-native/sonnet', variant: 'high', explicit: false },
  ]) {
    test(`runs ${selection.model} through the CLI, records edits, and can undo them`, async () => {
      await fill(12);
      const openCode = createOpenCode();
      const generated = [];
      const [providerID, modelID] = selection.model.split('/');
      await createDreaming({
        openCode,
        settings: selection.explicit ? { agentMemoryDreamingModel: selection.model, agentMemoryDreamingVariant: selection.variant } : {},
        resolveSessionDefaults: () => ({ providerID, modelID, variant: selection.variant }),
        generateNative: (options) => { generated.push(options); return generate(); },
      }).check();
      expect(generated).toHaveLength(1);
      expect(generated[0]).toMatchObject({ model: selection.model, variant: selection.variant, onOverflow: 'error' });
      expect(openCode.calls.some(({ method }) => method === 'POST')).toBe(false);
      const { record } = await memory.readDreamState(PROJECT);
      expect(record).toMatchObject({ status: 'done', merged: 1, rewritten: 1, toDocs: ['mem-3'] });
      const after = (await memory.read(PROJECT)).entries;
      expect(after.find(({ id }) => id === 'mem-1')?.title).toBe('Merged fact');
      expect(after.some(({ id }) => id === 'mem-2')).toBe(false);
      await memory.update(PROJECT, 'mem-1', { title: 'Edited after the pass' });
      const undone = await memory.undoDream(PROJECT);
      expect(undone.entries.find(({ id }) => id === 'mem-1')?.title).toBe('Edited after the pass');
      expect(undone.entries.some(({ id }) => id === 'mem-2')).toBe(true);
    });
  }

  test('enterprise policy and active CLI sessions prevent background generation', async () => {
    await fill(12);
    const settings = { agentMemoryDreamingModel: 'codex-native/test' };
    const failIfSent = async () => { throw new Error('A model call was made'); };
    await createDreaming({ openCode: createOpenCode(), settings, generateNative: failIfSent, nativeDreamAllowed: () => false }).check();
    await createDreaming({
      openCode: createOpenCode(), settings, generateNative: failIfSent,
      readSessionActivity: () => ({ ncx_fixture: { type: 'busy' } }),
    }).check();
    expect((await memory.readDreamState(PROJECT)).record).toBeNull();
    expect((await memory.read(PROJECT)).entries).toHaveLength(12);
  });

  test('a changed project snapshot cannot be overwritten while an independent global scope still organizes', async () => {
    await fill(12);
    const global = { scope: 'global' };
    await fill(12, global);
    await createDreaming({
      openCode: createOpenCode(),
      settings: { agentMemoryDreamingModel: 'codex-native/test' },
      generateNative: async () => {
        await memory.update(PROJECT, 'mem-2', { body: 'Updated during generation.' });
        return { text: JSON.stringify({ ...plan, removals: [
          ...plan.removals, { scope: 'global', id: 'mem-14', mergedInto: 'mem-13' },
        ] }) };
      },
    }).check();
    expect((await memory.read(PROJECT)).entries.find(({ id }) => id === 'mem-2')?.body).toBe('Updated during generation.');
    expect((await memory.read(global)).entries.some(({ id }) => id === 'mem-14')).toBe(false);
    expect((await memory.readDreamState(PROJECT)).record?.status).toBe('failed');
    expect((await memory.readDreamState(global)).record?.status).toBe('done');
  });

  test('an invalid merge target invalidates the whole plan before any write', async () => {
    await fill(12);
    await createDreaming({
      openCode: createOpenCode(),
      settings: { agentMemoryDreamingModel: 'codex-native/test' },
      generateNative: async () => ({ text: JSON.stringify({
        ...plan, removals: [...plan.removals, { scope: 'project', id: 'mem-3', mergedInto: 'mem-2' }],
      }) }),
    }).check();
    expect((await memory.read(PROJECT)).entries.find(({ id }) => id === 'mem-1')?.title).toBe('Fact 0');
    expect((await memory.read(PROJECT)).entries).toHaveLength(12);
    expect((await memory.readDreamState(PROJECT)).record?.status).toBe('failed');
  });

  test('disabling organizing while the memory lock is busy cancels the pending edits', async () => {
    await fill(12);
    const lock = memory.resolveTarget(PROJECT).filePath;
    const held = Promise.withResolvers();
    const release = Promise.withResolvers();
    const attempted = Promise.withResolvers();
    const owner = withMemoryFileLock(lock, async () => {
      held.resolve();
      await release.promise;
    });
    const runtime = createAgentMemoryRuntime({
      fsPromises: { ...fsPromises, open: (...args) => {
        if (args[0] === `${lock}.lock`) attempted.resolve();
        return fsPromises.open(...args);
      } },
      path,
      userConfigRoot: path.join(rootDir, 'config'),
      projectsDirPath: path.join(rootDir, 'config', 'projects'),
    });
    const settings = { agentMemoryDreamingModel: 'codex-native/test', agentMemoryDreamingEnabled: true };
    await held.promise;
    const check = createDreaming({ openCode: createOpenCode(), settings, generateNative: generate, agentMemoryRuntime: runtime }).check();
    await attempted.promise;
    settings.agentMemoryDreamingEnabled = false;
    release.resolve();
    await Promise.all([owner, check]);
    expect((await memory.read(PROJECT)).entries).toHaveLength(12);
    expect((await memory.readDreamState(PROJECT)).record).toBeNull();
  });
});

describe('when a pass runs', () => {
  test('does nothing while dreaming is off', async () => {
    await fill(12);
    const openCode = createOpenCode();
    await createDreaming({ openCode, settings: { agentMemoryDreamingEnabled: false } }).check();
    // Only the look for sessions an earlier server left behind.
    expect(openCode.calls.map((call) => `${call.method} ${call.pathname}`)).toEqual(['GET /api/session']);
  });

  test('waits while a session is running', async () => {
    await fill(12);
    const openCode = createOpenCode({ active: { ses_user: { type: 'busy' } } });
    await createDreaming({ openCode }).check();
    expect(openCode.calls.some((call) => call.method === 'POST' && call.pathname === '/api/session')).toBe(false);
  });

  test('skips a store with too few changes', async () => {
    await fill(3);
    const openCode = createOpenCode();
    await createDreaming({ openCode }).check();
    expect(openCode.calls.some((call) => call.pathname === '/api/session' && call.method === 'POST')).toBe(false);
  });

  test('runs again only a day after the last pass', async () => {
    await fill(12);
    const clock = { now: Date.now() };
    await memory.recordDream(PROJECT, { lastRunAt: clock.now - DAY / 2, record: { finishedAt: clock.now - DAY / 2 }, snapshot: null });
    const openCode = createOpenCode();
    await createDreaming({ openCode, clock }).check();
    expect(openCode.calls.some((call) => call.pathname === '/api/session' && call.method === 'POST')).toBe(false);

    clock.now += DAY;
    await createDreaming({ openCode, clock }).check();
    expect(openCode.calls.some((call) => call.pathname === '/api/session' && call.method === 'POST')).toBe(true);
  });
});

describe('a pass', () => {
  test('runs hidden, records what changed and removes its session', async () => {
    await fill(12);
    const hiddenSessions = createHiddenSessionRegistry();
    let hiddenDuringRun = false;
    const openCode = createOpenCode({
      onPrompt: async () => {
        // The agent folds Fact 0 into Fact 1, drops Fact 2, rewrites Fact 3.
        const entries = (await memory.read(PROJECT)).entries;
        const byTitle = (title) => entries.find((entry) => entry.title === title);
        hiddenDuringRun = hiddenSessions.has('ses_dream');
        await memory.update(PROJECT, byTitle('Fact 1').id, { body: 'Facts 0 and 1 together.' });
        await memory.remove(PROJECT, byTitle('Fact 0').id);
        await memory.remove(PROJECT, byTitle('Fact 2').id);
        await memory.update(PROJECT, byTitle('Fact 3').id, { body: 'True now.' });
      },
    });
    await createDreaming({ openCode, hiddenSessions }).check();

    const create = openCode.calls.find((call) => call.method === 'POST' && call.pathname === '/api/session');
    expect(create.body.metadata).toEqual({ hidden: true, openchamber: { kind: 'memory-dream' } });
    expect(create.body.model).toEqual({ providerID: 'zai', id: 'glm' });
    expect(create.body.permissions[0]).toEqual({ action: '*', resource: '*', effect: 'deny' });
    expect(create.body.permissions).toContainEqual({ action: 'execute', resource: '*', effect: 'allow' });
    expect(hiddenDuringRun).toBe(true);
    // Still hidden after the pass: events that trail the delete stay unseen.
    expect(hiddenSessions.has('ses_dream')).toBe(true);
    expect(openCode.calls.some((call) => call.method === 'DELETE' && call.pathname === '/api/session/ses_dream')).toBe(true);

    const state = await memory.readDreamState(PROJECT);
    expect(state.record).toMatchObject({ status: 'done', merged: 1, removed: 1, rewritten: 2 });
    // Fact 2 (mem-3) was deleted by the pass, so only the entry still there is offered for the docs.
    expect(state.record.toDocs).toEqual(['mem-6']);
    expect(state.snapshot).toHaveLength(12);
  });

  test('uses the model chosen for dreaming', async () => {
    await fill(12);
    const openCode = createOpenCode();
    await createDreaming({ openCode, settings: { agentMemoryDreamingModel: 'openai/gpt-mini', agentMemoryDreamingVariant: 'low' } }).check();
    const create = openCode.calls.find((call) => call.method === 'POST' && call.pathname === '/api/session');
    expect(create.body.model).toEqual({ providerID: 'openai', id: 'gpt-mini', variant: 'low' });
  });

  test('a pass that does not finish in time is stopped and recorded as failed', async () => {
    await fill(12);
    const openCode = createOpenCode({ hangWait: true, onPrompt: async () => {
      const entries = (await memory.read(PROJECT)).entries;
      await memory.remove(PROJECT, entries[0].id);
    } });
    await createDreaming({ openCode, passTimeoutMs: 20 }).check();

    expect(openCode.calls.some((call) => call.pathname.endsWith('/interrupt'))).toBe(true);
    const state = await memory.readDreamState(PROJECT);
    expect(state.record).toMatchObject({ status: 'failed', error: 'The pass did not finish in time', removed: 1 });
    // What it changed before stopping can still be undone.
    expect(state.snapshot).toHaveLength(12);
  });
});

describe('a store that cannot be read', () => {
  const BROKEN_DIR = '/work/broken';
  const BROKEN = { scope: 'project', projectId: 'path_broken' };
  const GLOBAL = { scope: 'global' };
  const twoProjects = {
    settings: { projects: [{ id: 'broken', path: BROKEN_DIR }, { id: 'acme', path: PROJECT_DIR }] },
    resolveProjectId: async (directory) => (directory === BROKEN_DIR ? BROKEN.projectId : PROJECT_ID),
  };
  const passes = (openCode) => openCode.calls.filter((call) => call.method === 'POST' && call.pathname.endsWith('/prompt'));
  const passDirectory = (openCode) => openCode.calls.find((call) => call.method === 'POST' && call.pathname === '/api/session')?.body.location.directory;

  /** Fills a scope, then replaces its store with a valid-JSON document missing its entries; returns both byte sets. */
  const corrupt = async (target) => {
    await fill(12, target);
    const filePath = memory.resolveTarget(target).filePath;
    const valid = await fsPromises.readFile(filePath);
    await fsPromises.writeFile(filePath, '{}');
    return { filePath, valid, broken: await fsPromises.readFile(filePath) };
  };

  test('a broken project store is skipped, a healthy project still dreams, and the repaired one dreams later', async () => {
    const broken = await corrupt(BROKEN);
    await fill(12);
    const logged = [];
    const clock = { now: Date.now() };
    const openCode = createOpenCode();
    await createDreaming({ openCode, clock, ...twoProjects, log: (line) => logged.push(line) }).check();

    expect(passDirectory(openCode)).toBe(PROJECT_DIR);
    expect(await fsPromises.readFile(broken.filePath)).toEqual(broken.broken);
    expect(logged.some((line) => line.includes(`skipped project memory of ${BROKEN_DIR}`))).toBe(true);
    expect((await memory.readDreamState(BROKEN)).record).toBeNull();

    await fsPromises.writeFile(broken.filePath, broken.valid);
    clock.now += 1000;
    const afterRepair = createOpenCode();
    await createDreaming({ openCode: afterRepair, clock, ...twoProjects }).check();
    expect(passDirectory(afterRepair)).toBe(BROKEN_DIR);
    expect((await memory.readDreamState(BROKEN)).record).toMatchObject({ status: 'done' });
  });

  test('a broken global store stays out of the pass, the project still dreams, and the repaired one dreams later', async () => {
    const broken = await corrupt(GLOBAL);
    await fill(12);
    const logged = [];
    const clock = { now: Date.now() };
    const openCode = createOpenCode();
    await createDreaming({ openCode, clock, log: (line) => logged.push(line) }).check();

    const [prompt] = passes(openCode);
    expect(prompt.body.text).toContain('## Project memory');
    expect(prompt.body.text).not.toContain('The user\'s memory (scope "global")');
    expect(await fsPromises.readFile(broken.filePath)).toEqual(broken.broken);
    expect(logged.some((line) => line.includes('skipped global memory'))).toBe(true);
    expect((await memory.readDreamState(GLOBAL)).record).toBeNull();
    expect((await memory.readDreamState(PROJECT)).record).toMatchObject({ status: 'done' });

    await fsPromises.writeFile(broken.filePath, broken.valid);
    const afterRepair = createOpenCode({ reply: 'Done.\nDREAM {"project": 0, "global": 0, "toDocs": []}' });
    await createDreaming({ openCode: afterRepair, clock }).check();
    const [repaired] = passes(afterRepair);
    expect(repaired.body.text).toContain('The user\'s memory (scope "global")');
    expect((await memory.readDreamState(GLOBAL)).record).toMatchObject({ status: 'done' });
  });
});

describe('a failed turn', () => {
  test('a provider error is recorded as a failure, not as nothing to tidy', async () => {
    await fill(12);
    const openCode = createOpenCode();
    const fetchImpl = openCode.fetchImpl;
    openCode.fetchImpl = async (url, init = {}) => {
      if (new URL(url).pathname.endsWith('/message')) {
        return new Response(JSON.stringify({ data: [
          { type: 'idle', outcome: 'failed', error: { message: 'Free usage limit reached.' } },
          { type: 'assistant', finish: 'error', content: [] },
        ] }), { status: 200 });
      }
      return fetchImpl(url, init);
    };
    await createDreaming({ openCode }).check();
    const state = await memory.readDreamState(PROJECT);
    expect(state.record).toMatchObject({ status: 'failed', error: 'Free usage limit reached.' });
    expect(state.snapshot).toBeNull();
  });
});

describe('pieces', () => {
  test('diffDream counts deleted and rewritten entries', () => {
    const before = [{ id: 'a', title: 'A', body: 'x', type: 'fact' }, { id: 'b', title: 'B', body: 'y', type: 'fact' }, { id: 'c', title: 'C', body: 'z', type: 'fact' }];
    const after = [{ id: 'a', title: 'A', body: 'x', type: 'fact' }, { id: 'b', title: 'B', body: 'changed', type: 'fact' }];
    expect(diffDream(before, after)).toEqual({ deleted: 1, rewritten: 1 });
  });

  test('the prompt names the overflow and carries every entry with its id', () => {
    const prompt = buildDreamPrompt({
      directory: PROJECT_DIR,
      project: [{ id: 'mem-1', type: 'fact', title: 'Uses bun', body: 'Tests run with bun.', updatedAt: 0 }],
      global: null,
      index: { budget: 8000, used: 9000, omitted: 12 },
    });
    expect(prompt).toContain('"memoryId":"mem-1"');
    expect(prompt).toContain('12 titles do not fit now');
    expect(prompt).not.toContain('The user\'s memory (scope "global")');
    expect(prompt).toContain('belong in the project\'s agent docs');
  });
});
