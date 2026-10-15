import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const fileError = z.object({ code: z.string() });
const owner = z.object({ pid: z.number().int().positive(), nonce: z.string() });

/** All instances share the memory directory, so process-local queues are insufficient. */
export const withMemoryFileLock = async (file, work, io = fs) => {
  const lock = `${file}.lock`;
  const claim = { pid: process.pid, nonce: randomUUID() };
  await io.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 2000;
  let acquired = false;
  while (Date.now() < deadline) {
    try {
      const handle = await io.open(lock, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(claim)); }
      catch (error) { await io.rm(lock, { force: true }); throw error; }
      finally { await handle.close(); }
      acquired = true;
      break;
    } catch (error) {
      if (fileError.safeParse(error).data?.code !== 'EEXIST') throw error;
    }
    try {
      const contents = await io.readFile(lock, 'utf8');
      const previous = owner.safeParse(JSON.parse(contents));
      if (previous.success) {
        try { process.kill(previous.data.pid, 0); }
        catch (error) {
          if (fileError.safeParse(error).data?.code === 'ESRCH' && await io.readFile(lock, 'utf8') === contents) await io.rm(lock, { force: true });
        }
      }
    } catch { /* A concurrent lock owner may still be writing or releasing it. */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!acquired) throw new Error('Shared memory storage is busy; retry the operation');
  try { return await work(); }
  finally {
    const current = owner.safeParse(JSON.parse(await io.readFile(lock, 'utf8')));
    if (current.success && current.data.nonce === claim.nonce) await io.rm(lock, { force: true });
  }
};
