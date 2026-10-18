import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeepseekMaintenance, deepseekPackage } from './maintenance.js';

const executable = process.env.OPENCHAMBER_TEST_DSH_EXECUTABLE;
const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const setup = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh storage test '));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'sessions');
  await fs.mkdir(root);
  const packageFile = await deepseekPackage(executable);
  const require = createRequire(packageFile);
  const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
  const { default: Jsonl } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href);
  const { SessionId } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session')).href);
  const context = new Context();
  cleanups.push(() => context.fiber.dispose());
  const storage = new Jsonl(context, { root, compression: 'none' });
  const maintenance = createDeepseekMaintenance({ dataDir: directory, resolveNodeExecutable: async () => process.execPath, buildEnv: () => ({ ...process.env }) });
  cleanups.push(() => maintenance.shutdown());
  await maintenance.prepare(executable);
  const create = async (id, metadata = {}, events = []) => {
    const handle = await storage.create({ id: SessionId(id), version: 4, createdAt: 1, cwd: directory, isSeeded: false, ...metadata });
    try { if (events.length) await handle.append(events); await handle.flush(); }
    finally { await handle.close(); }
    return SessionId(id);
  };
  return { directory, root, storage, create, maintenance, config: { packageFile, root, compression: 'none' } };
};

// The published CLI is deliberately not a workspace dependency. CI can opt
// into these real codec/lease tests with an installed pinned DSH executable.
describe.skipIf(!executable)('DSH native storage maintenance', () => {
  it('refuses a foreign kernel writer before deleting any target', async () => {
    const { storage, create, maintenance, config } = await setup();
    const first = await create('first');
    const second = await create('second');
    const held = await storage.open(second, 'write');
    try {
      await expect(maintenance.remove(config, [first, second])).rejects.toMatchObject({ code: 'NATIVE_DEEPSEEK_WRITER_HELD', status: 409 });
      expect(await storage.stat(first)).toBeDefined();
      expect(await storage.stat(second)).toBeDefined();
    } finally { await held.close(); }
    expect(await maintenance.remove(config, [first, second])).toMatchObject({ ok: true, deleted: true });
    expect(await storage.stat(first)).toBeUndefined();
    expect(await storage.stat(second)).toBeUndefined();
  });

  it('cascades exclusive subagents while retaining an independent fork and its inherited child', async () => {
    const { storage, create, maintenance, config } = await setup();
    const parent = await create('parent');
    const exclusive = await create('exclusive', { parentSession: parent, origin: 'subagent', delegationDepth: 1 });
    const shared = await create('shared', { parentSession: parent, origin: 'subagent', delegationDepth: 1 });
    const fork = await create('independent-fork', { parentSession: parent }, [{
      type: 'subagent/catalog', seq: 0, time: 1, data: { version: 0, childId: shared, childCreatedAt: 1, mode: 'one-shot' },
    }]);
    const result = await maintenance.remove(config, [parent]);
    expect(result.nativeIds.sort()).toEqual([exclusive, parent].sort());
    expect(await storage.stat(parent)).toBeUndefined();
    expect(await storage.stat(exclusive)).toBeUndefined();
    expect(await storage.stat(shared)).toBeDefined();
    expect(await storage.stat(fork)).toBeDefined();
  });

  it.each(['prepared', 'committed'])('recovers a %s deletion before DSH starts, preserving the lock inode', async (phase) => {
    const { directory, root, storage, create, maintenance } = await setup();
    const id = await create('recoverable');
    const log = await storage.resolveCurrentLog(id);
    const artifact = path.dirname(log);
    const lock = path.join(artifact, 'session.lock');
    const inode = process.platform === 'win32' ? null : (await fs.stat(lock)).ino;
    const stage = '.openchamber-delete-1234';
    await fs.mkdir(path.join(artifact, stage));
    await fs.rename(log, path.join(artifact, stage, path.basename(log)));
    const journal = path.join(directory, 'native-agents', 'deepseek', 'maintenance', 'delete-1234.json');
    await fs.writeFile(journal, JSON.stringify({ version: 1, phase, storage: { root, compression: 'none' }, entries: [{
      header: { id, cwd: directory, version: 4 }, directory: artifact, stage, names: [path.basename(log)],
    }] }));
    await maintenance.prepare(executable);
    if (phase === 'prepared') expect(await storage.stat(id)).toBeDefined();
    else expect(await storage.stat(id)).toBeUndefined();
    expect(await fs.readdir(artifact)).not.toContain(stage);
    if (inode !== null) expect((await fs.stat(lock)).ino).toBe(inode);
  });
});
