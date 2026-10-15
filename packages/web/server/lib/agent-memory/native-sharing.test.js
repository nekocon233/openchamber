import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentMemoryRuntime } from './runtime.js';
import { createNativeMemorySharing } from './native-sharing.js';

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
const setup = async (options = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-memory-'));
  roots.push(root);
  const a = path.join(root, 'project-a');
  const b = path.join(root, 'project-b');
  await Promise.all([fs.mkdir(a), fs.mkdir(b)]);
  const memory = createAgentMemoryRuntime({ fsPromises: fs, path, projectsDirPath: path.join(root, 'projects'), userConfigRoot: root, createId: randomUUID });
  let enabled = true;
  const sharing = createNativeMemorySharing({
    dataDir: root, agentMemoryRuntime: memory, isEnabled: async () => enabled,
    resolveProjectId: async (directory) => directory === a ? 'a' : directory === b ? 'b' : null,
    getEnv: () => ({ HOME: root }), now: () => 10000,
    ...options,
  });
  const checkpoint = (backend, sessionId, summary, extra = {}) => sharing.checkpoint({
    backend, sessionId, directory: a, summary, observedAt: 1000, ...extra,
  });
  return { root, a, b, memory, sharing, checkpoint, disable: () => { enabled = false; } };
};

describe('shared native CLI memory', () => {
  it('shares global preferences and same-project handoffs in both directions', async () => {
    const { memory, sharing, checkpoint, a, b } = await setup();
    await memory.create({ scope: 'global' }, { title: 'Concise answers', body: 'Prefer concise answers.', type: 'preference' });
    await memory.create({ scope: 'project', projectId: 'a' }, { title: 'Project A tests', body: 'Use the focused project test suite.' });
    await checkpoint('claude', 'claude-session', 'Finished the parser; UI wiring remains.');
    const codex = await sharing.context({ backend: 'codex', sessionId: 'codex-session', directory: a });
    expect(codex.text).toContain('Concise answers');
    expect(codex.text).toContain('Project A tests');
    expect(codex.text).toContain('Finished the parser');
    await checkpoint('codex', 'codex-session', 'UI wiring is complete.');
    const claude = await sharing.context({ backend: 'claude', sessionId: 'claude-session', directory: a });
    expect(claude.text).toContain('UI wiring is complete.');
    expect(claude.text).not.toContain('Finished the parser');
    const other = await sharing.context({ backend: 'codex', sessionId: 'other', directory: b });
    expect(other.text).toContain('Concise answers');
    expect(other.text).not.toContain('Project A tests');
    expect(other.text).not.toContain('UI wiring is complete.');
  });

  it('serializes concurrent writers, rejects stale checkpoints and never overwrites corrupt storage', async () => {
    const { root, sharing, checkpoint, a } = await setup();
    await Promise.all([checkpoint('claude', 'one', 'First'), checkpoint('codex', 'two', 'Second')]);
    expect((await sharing.status(a)).progress).toHaveLength(2);
    await checkpoint('codex', 'two', 'Newer', { observedAt: 2000 });
    expect(await checkpoint('codex', 'two', 'Older')).toMatchObject({ saved: false });
    expect((await sharing.status(a)).progress[0].summary).toBe('Newer');
    const file = path.join(root, 'native-memory', 'projects', 'a', 'progress.json');
    await fs.writeFile(file, '{broken');
    await expect(checkpoint('claude', 'one', 'Overwrite')).rejects.toThrow('could not be read');
    expect((await sharing.context({ backend: 'claude', sessionId: 'three', directory: a })).text).toContain('could not be read');
    expect((await sharing.status(a)).progressUnavailable).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe('{broken');
  });

  it('stops sharing immediately when disabled, retaining stored data for re-enabling', async () => {
    const { sharing, checkpoint, disable, a } = await setup();
    await checkpoint('claude', 'one', 'Saved');
    disable();
    expect(await sharing.context({ backend: 'codex', sessionId: 'two', directory: a })).toEqual({ enabled: false, text: '' });
    await expect(checkpoint('codex', 'two', 'New')).rejects.toThrow('disabled');
    expect((await sharing.status(a)).progress).toEqual([]);
  });

  it('preserves foreign hooks and config, observes readiness and removes only its own entries', async () => {
    const { root, sharing, a } = await setup();
    const file = path.join(root, '.claude', 'settings.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const foreign = { hooks: [{ type: 'command', command: 'existing-check' }] };
    await fs.writeFile(file, JSON.stringify({ language: 'zh-CN', hooks: { Stop: [foreign] } }));
    expect(await sharing.connect('claude', 3000)).toMatchObject({ installed: true, ready: false });
    const connected = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(connected.language).toBe('zh-CN');
    expect(connected.hooks.Stop[0]).toEqual(foreign);
    await sharing.context({ backend: 'claude', sessionId: 'terminal', directory: a, delivery: 'hook' });
    expect((await sharing.status(a)).backends.find((row) => row.backend === 'claude').ready).toBe(true);
    await sharing.disconnect('claude');
    const disconnected = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(disconnected.hooks.Stop).toEqual([foreign]);
    expect(disconnected.language).toBe('zh-CN');
  });

  it('does not double-deliver context to managed turns or mix backend identities', async () => {
    const { sharing, a } = await setup();
    const request = { backend: 'codex', sessionId: 'same', directory: a };
    expect((await sharing.context({ ...request, delivery: 'managed' })).text).not.toBe('');
    expect((await sharing.context({ ...request, delivery: 'hook' })).text).toBe('');
    expect((await sharing.context({ ...request, backend: 'claude', delivery: 'hook' })).text).not.toBe('');
    sharing.release('ncx_same');
    expect((await sharing.context({ ...request, delivery: 'hook' })).text).not.toBe('');
  });

  it('isolates unreadable CLI configuration and refuses enrollment without Node before writing hooks', async () => {
    const { root, sharing, a } = await setup({ getNodeExecutable: () => null });
    const claudeFile = path.join(root, '.claude', 'settings.json');
    await fs.mkdir(path.dirname(claudeFile), { recursive: true });
    await fs.writeFile(claudeFile, '{invalid');
    const status = await sharing.status(a);
    expect(status.backends).toEqual([
      { status: 'unavailable', backend: 'claude' },
      expect.objectContaining({ status: 'ok', backend: 'codex', installed: false }),
    ]);
    await expect(sharing.connect('codex', 3000)).rejects.toMatchObject({ code: 'NATIVE_MEMORY_NODE_MISSING' });
    await expect(fs.stat(path.join(root, '.codex', 'hooks.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(claudeFile, 'utf8')).toBe('{invalid');
  });
});
