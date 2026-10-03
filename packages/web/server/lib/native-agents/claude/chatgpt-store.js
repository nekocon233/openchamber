import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { NativeAgentError } from '../errors.js';

export const chatgptModelSchema = z.object({
  slug: z.string().min(1), display_name: z.string().min(1), visibility: z.string(),
});
const credentialsSchema = z.object({
  accessToken: z.string().min(1), refreshToken: z.string().min(1), idToken: z.string().min(1),
  expiresAt: z.number(), scopes: z.array(z.string()),
});
const accountSchema = z.object({
  id: z.string().uuid(), clientId: z.string().min(1), subject: z.string().min(1), email: z.string(),
  revision: z.number().int().positive(), credentials: credentialsSchema.nullable(),
  models: z.array(chatgptModelSchema), welcomed: z.boolean(),
});
const documentSchema = z.object({ version: z.literal(1), hostId: z.string().nullable(), accounts: z.array(accountSchema) });
const fileError = z.object({ code: z.string() });
const ownerSchema = z.object({ pid: z.number().int().positive() });
const failure = (code) => new NativeAgentError('ChatGPT account storage is unavailable', { code, status: 503 });

/** The file lock also serializes rotating refresh tokens across server processes. */
export const createChatgptStore = ({ dataDir }) => {
  const directory = path.join(dataDir, 'native-agents');
  const file = path.join(directory, 'chatgpt-accounts.json');
  const lock = `${file}.lock`;
  let pending = Promise.resolve();
  const read = async () => {
    try { return documentSchema.parse(JSON.parse(await fs.readFile(file, 'utf8'))); }
    catch (error) {
      if (fileError.safeParse(error).data?.code === 'ENOENT') return { version: 1, hostId: null, accounts: [] };
      throw failure('CHATGPT_STORAGE_READ_FAILED');
    }
  };
  const acquire = async () => {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const handle = await fs.open(lock, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify({ pid: process.pid })); }
        catch (error) { await fs.rm(lock, { force: true }); throw error; }
        finally { await handle.close(); }
        return;
      } catch (error) {
        if (fileError.safeParse(error).data?.code !== 'EEXIST') throw failure('CHATGPT_STORAGE_WRITE_FAILED');
      }
      try {
        const owner = ownerSchema.safeParse(JSON.parse(await fs.readFile(lock, 'utf8')));
        if (owner.success) {
          try { process.kill(owner.data.pid, 0); }
          catch (error) {
            if (fileError.safeParse(error).data?.code === 'ESRCH') await fs.rm(lock, { force: true });
          }
        }
      } catch { /* An owner may still be writing its lock record. */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw failure('CHATGPT_STORAGE_BUSY');
  };
  return {
    read,
    drain: () => pending,
    transaction(work) {
      const next = pending.then(async () => {
        await acquire();
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
          const document = await read();
          const result = await work(document);
          documentSchema.parse(document);
          await fs.writeFile(temporary, JSON.stringify(document), { mode: 0o600, flag: 'wx' });
          await fs.rename(temporary, file);
          return result;
        } finally {
          await fs.rm(temporary, { force: true });
          await fs.rm(lock, { force: true });
        }
      });
      pending = next.then(() => {}, () => {});
      return next;
    },
  };
};
