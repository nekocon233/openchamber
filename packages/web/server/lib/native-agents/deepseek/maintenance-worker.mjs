// Node-only maintenance. All codecs and kernel leases come from the exact
// installed DSH distribution. Conversation records are never rewritten.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const absolute = z.string().min(1).refine((value) => path.isAbsolute(value) && !value.includes('\0'));
const storageSchema = z.object({ root: absolute, compression: z.enum(['none', 'zstd']) });
const inputSchema = z.object({
  operation: z.enum(['delete', 'recover']), directory: absolute, packageFile: absolute,
  storage: storageSchema.optional(), nativeIds: z.array(z.string().min(1)).min(1).optional(),
});
const headerSchema = z.object({ id: z.string().min(1), cwd: absolute.optional(), version: z.literal(4) });
const nameSchema = z.string().min(1).refine((value) => value !== '.' && value !== '..' && !/[\/\\\0]/.test(value));
const journalSchema = z.object({
  version: z.literal(1), phase: z.enum(['prepared', 'committed']), storage: storageSchema,
  entries: z.array(z.object({ header: headerSchema, directory: absolute, stage: nameSchema, names: z.array(nameSchema) })),
});
const missing = z.object({ code: z.literal('ENOENT') });
const exists = async (file) => {
  try { return await fs.lstat(file); }
  catch (error) { if (missing.safeParse(error).success) return null; throw error; }
};
const inside = (root, target) => {
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Unsafe DSH artifact path');
};
const atomicJSON = async (file, value) => {
  const temporary = `${file}.tmp`;
  const handle = await fs.open(temporary, 'w', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(temporary, file);
};
const syncDirectory = async (directory) => {
  if (process.platform === 'win32') return;
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
};

async function main(input) {
  const packageInfo = JSON.parse(await fs.readFile(input.packageFile, 'utf8'));
  if (packageInfo.name !== '@deepseek-ai/dsh' || packageInfo.version !== '0.2.0-rc.2') throw new Error('Incompatible DSH');
  const require = createRequire(input.packageFile);
  const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
  const { default: Jsonl } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href);

  const withStorage = async (storage, operation) => {
    const root = await fs.realpath(storage.root);
    const context = new Context();
    try { return await operation(new Jsonl(context, { ...storage, root }), root); }
    finally { await context.fiber.dispose(); }
  };

  // The lock file stays at its original inode throughout deletion and recovery.
  // Moving or removing that file would let a second POSIX writer enter.
  const finishJournal = async (file, journal, store, root) => {
    const leases = [];
    try {
      for (const entry of journal.entries) {
        inside(root, entry.directory);
        if (await fs.realpath(entry.directory) !== entry.directory) throw new Error('Symlinked DSH artifact');
        leases.push(await store.acquireWriteLease(entry.header));
      }
      for (const entry of journal.entries) {
        const stage = path.join(entry.directory, entry.stage);
        const stat = await exists(stage);
        if (!stat) continue;
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid deletion stage');
        if (journal.phase === 'prepared') {
          for (const name of [...entry.names].reverse()) {
            const from = path.join(stage, name);
            if (!await exists(from)) continue;
            const to = path.join(entry.directory, name);
            if (await exists(to)) throw new Error('DSH rollback target exists');
            await fs.rename(from, to);
          }
        }
        await fs.rm(stage, { recursive: true });
        await syncDirectory(entry.directory);
      }
      await fs.rm(file);
      await syncDirectory(input.directory);
    } finally { await Promise.allSettled(leases.map((lease) => lease.release())); }
  };

  if (input.operation === 'recover') {
    for (const name of await fs.readdir(input.directory)) {
      if (!/^delete-[a-f0-9-]+\.json$/.test(name)) continue;
      const file = path.join(input.directory, name);
      const journal = journalSchema.parse(JSON.parse(await fs.readFile(file, 'utf8')));
      await withStorage(journal.storage, (store, root) => finishJournal(file, journal, store, root));
    }
    return { ok: true };
  }
  if (!input.storage || !input.nativeIds) throw new Error('Missing DSH deletion input');
  return withStorage(input.storage, async (store, root) => {
    const snapshots = await store.list();
    const headers = new Map(snapshots.map((item) => [item.header.id, item.header]));
    const targets = new Set(input.nativeIds.filter((id) => headers.has(id)));
    // Only native subagent ownership cascades. User-visible forks are independent.
    let changed = true;
    while (changed) {
      changed = false;
      for (const header of headers.values()) {
        if (header.origin !== 'subagent' || !targets.has(header.parentSession) || targets.has(header.id)) continue;
        targets.add(header.id); changed = true;
      }
    }
    const family = (header) => {
      const seen = new Set();
      while (header?.parentSession && !seen.has(header.id)) {
        seen.add(header.id);
        if (targets.has(header.parentSession)) return true;
        header = headers.get(header.parentSession);
      }
      return false;
    };
    // Fork-inherited catalogs can still name a child owned by the source.
    // Preserve such a child and its descendants for every independent fork.
    const shared = new Set();
    for (const header of headers.values()) {
      if (targets.has(header.id) || !family(header)) continue;
      const handle = await store.open(header.id, 'read');
      try {
        const { events } = await handle.read();
        for (const event of events) {
          if (event.type === 'subagent/catalog' && targets.has(event.data.childId)) shared.add(event.data.childId);
        }
      } finally { await handle.close(); }
    }
    changed = true;
    while (changed) {
      changed = false;
      for (const header of headers.values()) {
        if (header.origin === 'subagent' && shared.has(header.parentSession) && !shared.has(header.id)) { shared.add(header.id); changed = true; }
      }
    }
    for (const id of shared) targets.delete(id);
    const handles = [];
    const entries = [];
    const token = randomUUID();
    const file = path.join(input.directory, `delete-${token}.json`);
    let journal = null;
    try {
      // Claim every target before moving any artifact. A foreign writer is a
      // definite refusal, never a reason to remove its lock or take it over.
      for (const id of [...targets].sort()) {
        const handle = await store.open(id, 'write');
        handles.push(handle);
        const header = headerSchema.parse(handle.header);
        const log = await store.resolveCurrentLog(id);
        if (!log) throw new Error('Missing current DSH generation');
        const directory = path.dirname(log);
        inside(root, directory);
        if (await fs.realpath(directory) !== directory) throw new Error('Symlinked DSH artifact');
        const names = (await fs.readdir(directory)).filter((name) => name !== 'session.lock');
        if (names.some((name) => name.startsWith('.openchamber-delete-'))) throw new Error('Unrecovered deletion');
        entries.push({ header, directory, stage: `.openchamber-delete-${token}`, names });
      }
      journal = { version: 1, phase: 'prepared', storage: { ...input.storage, root }, entries };
      await atomicJSON(file, journal);
      await syncDirectory(input.directory);
      for (const entry of entries) {
        const stage = path.join(entry.directory, entry.stage);
        await fs.mkdir(stage, { mode: 0o700 });
        for (const name of entry.names) await fs.rename(path.join(entry.directory, name), path.join(stage, name));
        await syncDirectory(stage);
        await syncDirectory(entry.directory);
      }
      journal = { ...journal, phase: 'committed' };
      await atomicJSON(file, journal);
      await syncDirectory(input.directory);
    } catch (error) {
      await Promise.allSettled(handles.splice(0).map((handle) => handle.close()));
      // The durable marker, rather than the last attempted write, decides
      // whether recovery must roll back or finish deleting.
      const saved = await exists(file);
      if (saved) {
        const durable = journalSchema.parse(JSON.parse(await fs.readFile(file, 'utf8')));
        await finishJournal(file, durable, store, root);
        if (durable.phase === 'committed') return { ok: false, deleted: true, nativeIds: [...targets], code: 'NATIVE_DEEPSEEK_DELETE_CLEANUP_FAILED' };
      }
      throw error;
    }
    const released = await Promise.allSettled(handles.map((handle) => handle.close()));
    if (released.some((item) => item.status === 'rejected')) return { ok: false, deleted: true, nativeIds: [...targets], code: 'NATIVE_DEEPSEEK_DELETE_CLEANUP_FAILED' };
    try { await finishJournal(file, journal, store, root); }
    catch { return { ok: false, deleted: true, nativeIds: [...targets], code: 'NATIVE_DEEPSEEK_DELETE_CLEANUP_FAILED' }; }
    return { ok: true, deleted: true, nativeIds: [...targets] };
  });
}

try {
  let source = '';
  for await (const chunk of process.stdin) {
    source += chunk;
    if (source.length > 1024 * 1024) throw new Error('Maintenance input too large');
  }
  process.stdout.write(JSON.stringify(await main(inputSchema.parse(JSON.parse(source)))));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error?.name === 'SessionAlreadyOwnedError' ? 'NATIVE_DEEPSEEK_WRITER_HELD' : 'NATIVE_DEEPSEEK_MAINTENANCE_FAILED' }));
}
