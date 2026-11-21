import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { withMemoryFileLock } from './file-lock.js';

export type NativeMemoryTerminalBackend = 'claude' | 'codex';

const events = {
  claude: ['SessionStart', 'UserPromptSubmit', 'Stop'],
  codex: ['SessionStart', 'UserPromptSubmit', 'Stop', 'Interrupt'],
} satisfies Record<NativeMemoryTerminalBackend, readonly string[]>;

const hookSchema = z.object({ type: z.string(), command: z.string().optional() }).passthrough();
const groupSchema = z.object({ hooks: z.array(hookSchema) }).passthrough();
const configSchema = z.object({ hooks: z.record(z.string(), z.array(groupSchema)).optional() }).passthrough();
const missing = z.object({ code: z.literal('ENOENT') });
const stamp = z.object({ lastSeen: z.number() });

type HookEntry = z.infer<typeof hookSchema>;
type HookGroup = z.infer<typeof groupSchema>;
type HookConfig = z.infer<typeof configSchema>;

export interface NativeMemoryConnectionUpdate {
  backend: NativeMemoryTerminalBackend;
  installed: boolean;
  ready: boolean;
  reviewRequired: boolean;
  lastSeen: number | null;
}

export type NativeMemoryConnectionStatus =
  | {
    status: 'ok';
    backend: NativeMemoryTerminalBackend;
    installed: boolean;
    ready: boolean;
    reviewRequired: boolean;
    lastSeen: number | null;
  }
  | {
    status: 'unavailable';
    backend: NativeMemoryTerminalBackend;
  };

export interface NativeMemoryConnectionsOptions {
  getEnv: () => NodeJS.ProcessEnv;
  hookPath: string;
  now?: () => number;
}

const quote = (value: string): string => process.platform === 'win32'
  ? `"${value.replace(/"/g, '""')}"` : `'${value.replace(/'/g, `'\\''`)}'`;

export const createNativeMemoryConnections = ({ getEnv, hookPath, now = Date.now }: NativeMemoryConnectionsOptions) => {
  const paths = () => {
    const env = getEnv();
    const home = env.HOME || os.homedir();
    return {
      claude: path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'settings.json'),
      codex: path.join(env.CODEX_HOME || path.join(home, '.codex'), 'hooks.json'),
    };
  };

  const owned = (entry: HookEntry, backend: NativeMemoryTerminalBackend): boolean => (
    entry.type === 'command'
    && Boolean(entry.command?.includes(quote(hookPath)))
    && Boolean(entry.command?.includes(`--backend ${backend}`))
  );

  const read = async (file: string): Promise<HookConfig> => {
    try { return configSchema.parse(JSON.parse(await fs.readFile(file, 'utf8'))); }
    catch (error) { if (missing.safeParse(error).success) return {}; throw error; }
  };

  let pending: Promise<unknown> = Promise.resolve();

  const update = (
    backend: NativeMemoryTerminalBackend,
    port: number | null,
    executable?: string,
  ): Promise<NativeMemoryConnectionUpdate> => {
    const file = paths()[backend];
    const work = pending.catch(() => undefined).then(() => withMemoryFileLock(file, async (): Promise<NativeMemoryConnectionUpdate> => {
      const original = await read(file);
      const hooks: Record<string, HookGroup[]> = {};
      for (const [event, groups] of Object.entries(original.hooks ?? {})) {
        const kept = groups.flatMap((entry): HookGroup[] => {
          const handlers = entry.hooks.filter((handler) => !owned(handler, backend));
          return handlers.length === entry.hooks.length
            ? [entry]
            : handlers.length > 0
              ? [{ ...entry, hooks: handlers }]
              : [];
        });
        if (kept.length > 0) hooks[event] = kept;
      }
      if (port !== null) {
        const resolvedExecutable = executable ?? process.execPath;
        const command = `${quote(resolvedExecutable)} ${quote(hookPath)} --backend ${backend} --port ${port}`;
        for (const event of events[backend]) {
          hooks[event] = [...(hooks[event] ?? []), { hooks: [{ type: 'command', command, timeout: 3 }] }];
        }
      }
      const temporary = `${file}.openchamber-${process.pid}.tmp`;
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      try {
        await fs.writeFile(temporary, `${JSON.stringify({ ...original, hooks }, null, 2)}\n`, { mode: 0o600 });
        await fs.rename(temporary, file);
      } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
      await fs.rm(`${file}.openchamber-memory-observed.json`, { force: true });
      return { backend, installed: port !== null, ready: false, reviewRequired: backend === 'codex' && port !== null, lastSeen: null };
    }));
    pending = work;
    return work;
  };

  const backends: readonly NativeMemoryTerminalBackend[] = ['claude', 'codex'];

  return {
    connect: (backend: NativeMemoryTerminalBackend, port: number, executable = process.execPath) => (
      update(backend, z.number().int().min(1).max(65535).parse(port), executable)
    ),
    disconnect: (backend: NativeMemoryTerminalBackend) => update(backend, null),
    async observe(backend: NativeMemoryTerminalBackend): Promise<void> {
      const file = `${paths()[backend]}.openchamber-memory-observed.json`;
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify({ lastSeen: now() }), { mode: 0o600 });
        await fs.rename(temporary, file);
      } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
    },
    async status(): Promise<NativeMemoryConnectionStatus[]> {
      return Promise.all(backends.map(async (backend): Promise<NativeMemoryConnectionStatus> => {
        try {
          const file = paths()[backend];
          const config = await read(file);
          const installed = events[backend].every((event) => (
            config.hooks?.[event]?.some((entry) => entry.hooks.some((handler) => owned(handler, backend)))
          ));
          let lastSeen: number | null = null;
          try {
            lastSeen = stamp.parse(JSON.parse(await fs.readFile(`${file}.openchamber-memory-observed.json`, 'utf8'))).lastSeen;
          } catch (error) {
            if (!missing.safeParse(error).success) throw error;
          }
          return {
            status: 'ok',
            backend,
            installed,
            ready: installed && lastSeen !== null,
            reviewRequired: backend === 'codex' && installed && lastSeen === null,
            lastSeen,
          };
        } catch {
          return { status: 'unavailable', backend };
        }
      }));
    },
  };
};
