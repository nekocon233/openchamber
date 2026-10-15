import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { withMemoryFileLock } from './file-lock.js';
import { randomUUID } from 'node:crypto';

const events = ['SessionStart', 'UserPromptSubmit', 'Stop', 'Interrupt'];
const hook = z.object({ type: z.string(), command: z.string().optional() }).passthrough();
const group = z.object({ hooks: z.array(hook) }).passthrough();
const configSchema = z.object({ hooks: z.record(z.string(), z.array(group)).optional() }).passthrough();
const missing = z.object({ code: z.literal('ENOENT') });
const stamp = z.object({ lastSeen: z.number() });
const quote = (value) => process.platform === 'win32'
  ? `"${value.replace(/"/g, '""')}"` : `'${value.replace(/'/g, `'\\''`)}'`;

export const createNativeMemoryConnections = ({ getEnv, hookPath, now = Date.now }) => {
  const paths = () => {
    const env = getEnv();
    const home = env.HOME || os.homedir();
    return {
      claude: path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'settings.json'),
      codex: path.join(env.CODEX_HOME || path.join(home, '.codex'), 'hooks.json'),
    };
  };
  const owned = (entry, backend) => entry.type === 'command'
    && entry.command?.includes(quote(hookPath)) && entry.command.includes(`--backend ${backend}`);
  const read = async (file) => {
    try { return configSchema.parse(JSON.parse(await fs.readFile(file, 'utf8'))); }
    catch (error) { if (missing.safeParse(error).success) return {}; throw error; }
  };
  let pending = Promise.resolve();
  const update = (backend, port, executable) => {
    const file = paths()[backend];
    const work = pending.catch(() => {}).then(() => withMemoryFileLock(file, async () => {
      const original = await read(file);
      const hooks = Object.fromEntries(Object.entries(original.hooks ?? {}).map(([event, groups]) => [event,
        groups.flatMap((entry) => {
          const kept = entry.hooks.filter((handler) => !owned(handler, backend));
          return kept.length === entry.hooks.length ? [entry] : kept.length > 0 ? [{ ...entry, hooks: kept }] : [];
        }),
      ]));
      if (port !== null) {
        const command = `${quote(executable)} ${quote(hookPath)} --backend ${backend} --port ${port}`;
        for (const event of events) {
          hooks[event] = [...(hooks[event] ?? []), { hooks: [{ type: 'command', command, timeout: 3 }] }];
        }
      }
      const temporary = `${file}.openchamber-${process.pid}.tmp`;
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      try {
        await fs.writeFile(temporary, JSON.stringify({ ...original, hooks }, null, 2) + '\n', { mode: 0o600 });
        await fs.rename(temporary, file);
      } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
      await fs.rm(`${file}.openchamber-memory-observed.json`, { force: true });
      return { backend, installed: port !== null, ready: false, reviewRequired: backend === 'codex' && port !== null, lastSeen: null };
    }));
    pending = work;
    return work;
  };
  return {
    connect: (backend, port, executable = process.execPath) => update(backend, z.number().int().min(1).max(65535).parse(port), executable),
    disconnect: (backend) => update(backend, null),
    async observe(backend) {
      const file = `${paths()[backend]}.openchamber-memory-observed.json`;
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify({ lastSeen: now() }), { mode: 0o600 });
        await fs.rename(temporary, file);
      } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
    },
    async status() {
      return Promise.all(['claude', 'codex'].map(async (backend) => {
        try {
        const file = paths()[backend];
        const config = await read(file);
        const installed = events.every((event) => config.hooks?.[event]?.some((entry) => entry.hooks.some((handler) => owned(handler, backend))));
        let lastSeen = null;
        try { lastSeen = stamp.parse(JSON.parse(await fs.readFile(`${file}.openchamber-memory-observed.json`, 'utf8'))).lastSeen; }
        catch (error) { if (!missing.safeParse(error).success) throw error; }
        return { status: 'ok', backend, installed, ready: installed && lastSeen !== null, reviewRequired: backend === 'codex' && installed && lastSeen === null, lastSeen };
        } catch {
          return { status: 'unavailable', backend };
        }
      }));
    },
  };
};
