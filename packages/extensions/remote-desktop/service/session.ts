import { z } from 'zod';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { currentUser, findBrowserBinary, buildBrowserCommand, inspectEnvironment, type DesktopEnvironment, type DesktopUser } from './environment.ts';
import { reserveDisplay, supervisorSpawnReplySchema, type SessionSpec, type SupervisorSpawnRequest } from './supervisor.ts';
import type { DesktopFailure } from '../contract.ts';

export class DesktopError extends Error {
  constructor(readonly code: DesktopFailure) { super(code); }
}
type DesktopSession = {
  id: string; display: string; password: string; port: number; state: 'starting' | 'ready'; displayLock: string | null;
  child: ChildProcess | null; directory: string | null; abort: AbortController;
  releaseDisplay: (() => Promise<void>) | null; viewers: Set<() => void>;
  user: DesktopUser | null; browserEnv: Record<string, string> | null;
  spawnWaiters: Map<string, (ok: boolean) => void>;
  ready: Promise<DesktopSession>;
};

const addressSchema = z.object({ port: z.number().int().positive() });
const reservePort = (): Promise<number> => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = addressSchema.safeParse(server.address());
    if (!address.success) { server.close(); reject(new DesktopError('START_FAILED')); return; }
    server.close((error) => error ? reject(error) : resolve(address.data.port));
  });
});

const childEnvironment = (user: DesktopUser, display: string, authority: string, asNode = true) => {
  const base = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: user.home,
    USER: user.name,
    LOGNAME: user.name,
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    DISPLAY: display,
    XAUTHORITY: authority,
    XDG_RUNTIME_DIR: `/run/user/${user.uid}`,
  };
  return asNode ? { ...base, ELECTRON_RUN_AS_NODE: '1' } : base;
};

const passwordBytes = (binary: string, password: string, signal: AbortSignal): Promise<Buffer> => new Promise((resolve, reject) => {
  const child = spawn(binary, ['-f'], { stdio: ['pipe', 'pipe', 'ignore'], signal, windowsHide: true });
  const chunks: Buffer[] = [];
  child.stdout.on('data', (data: Buffer) => { if (chunks.reduce((sum, item) => sum + item.length, 0) < 1024) chunks.push(data); });
  child.once('error', reject);
  child.once('exit', (code) => {
    const bytes = Buffer.concat(chunks);
    if (code !== 0 || bytes.length !== 8) reject(new DesktopError('START_FAILED')); else resolve(bytes);
  });
  child.stdin.on('error', () => {});
  child.stdin.end(`${password}\n`);
});

const xAuthority = (display: string): Buffer => {
  const field = (data: Buffer) => { const size = Buffer.alloc(2); size.writeUInt16BE(data.length); return Buffer.concat([size, data]); };
  return Buffer.concat([Buffer.from([0xff, 0xff]), field(Buffer.alloc(0)), field(Buffer.from(display.slice(1))), field(Buffer.from('MIT-MAGIC-COOKIE-1')), field(randomBytes(16))]);
};

const stopChild = async (child: ChildProcess): Promise<void> => {
  if (!child.pid) return;
  const pid = child.pid;
  child.stdin?.destroy();
  const kill = (signal: NodeJS.Signals) => { try { process.kill(-pid, signal); } catch { /* Already gone. */ } };
  kill('SIGTERM');
  // The supervisor keeps the group alive until its own SIGKILL, including
  // descendants that ignored SIGTERM. Parent cleanup waits for that boundary.
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { kill('SIGKILL'); resolve(); }, 1500);
    child.once('exit', () => { clearTimeout(timer); kill('SIGKILL'); resolve(); });
    if (child.exitCode !== null || child.signalCode !== null) { clearTimeout(timer); kill('SIGKILL'); resolve(); }
  });
};

export const createDesktopSessions = (
  entry = fileURLToPath(import.meta.url),
  createDirectory = () => fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-desktop-')),
  resolveBrowser: () => Promise<Awaited<ReturnType<typeof findBrowserBinary>>> = findBrowserBinary,
) => {
  let activeSession: DesktopSession | null = null;
  const cleaning = new WeakMap<DesktopSession, Promise<void>>();
  let shuttingDown = false;
  const cleanup = (session: DesktopSession): Promise<void> => {
    const current = cleaning.get(session);
    if (current) return current;
    const pending = (async () => {
      session.abort.abort();
      for (const settleSpawn of session.spawnWaiters.values()) settleSpawn(false);
      session.spawnWaiters.clear();
      for (const close of [...session.viewers]) close();
      session.viewers.clear();
      if (session.child) await stopChild(session.child);
      if (session.directory) await fs.rm(session.directory, { recursive: true, force: true });
      await session.releaseDisplay?.();
      if (activeSession === session) activeSession = null;
    })();
    cleaning.set(session, pending);
    return pending;
  };
  const prepare = async (session: DesktopSession, options: { width?: number; height?: number }) => {
    const assertActive = () => { if (session.abort.signal.aborted || shuttingDown) throw new DesktopError('STOPPED'); };
    try {
      const environment = await inspectEnvironment();
      assertActive();
      if (environment.platform !== 'linux') throw new DesktopError('UNSUPPORTED');
      if (!environment.binaries.password) throw new DesktopError('NO_PASSWORD_TOOL');
      if (!environment.binaries.virtual) throw new DesktopError('NO_VIRTUAL_SERVER');
      if (!environment.binaries.desktop) throw new DesktopError('NO_DESKTOP');
      const user = currentUser();
      session.user = user;
      const reserved = await reserveDisplay();
      session.display = reserved.display;
      session.releaseDisplay = reserved.release;
      session.displayLock = reserved.lock;
      if (process.getuid?.() === 0) await fs.chown(reserved.lock, user.uid, user.gid);
      assertActive();
      session.directory = await createDirectory();
      await fs.chmod(session.directory, 0o700);
      if (process.getuid?.() === 0) await fs.chown(session.directory, user.uid, user.gid);
      assertActive();
      const passwordFile = path.join(session.directory, 'vnc-password');
      const password = await passwordBytes(environment.binaries.password, session.password, session.abort.signal);
      await fs.writeFile(passwordFile, password, { mode: 0o600 });
      if (process.getuid?.() === 0) await fs.chown(passwordFile, user.uid, user.gid);
      const authority = path.join(session.directory, 'Xauthority');
      await fs.writeFile(authority, xAuthority(session.display), { mode: 0o600 });
      if (process.getuid?.() === 0) await fs.chown(authority, user.uid, user.gid);
      assertActive();
      session.port = await reservePort();
      assertActive();
      session.browserEnv = childEnvironment(user, session.display, authority, false);
      const spec = sessionCommand(session, environment, options, passwordFile, childEnvironment(user, session.display, authority));
      const child = spawn(process.execPath, [entry, '--desktop-session'], {
        env: { PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: '1' },
        detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
        uid: process.getuid?.() === 0 ? user.uid : undefined,
        gid: process.getuid?.() === 0 ? user.gid : undefined,
      });
      session.child = child;
      child.stdin.on('error', () => {});
      let stdoutBuffer = '';
      let readySettled = false;
      child.stdin.write(`${JSON.stringify(spec)}\n`);
      await new Promise<void>((resolve, reject) => {
        const settleReady = (fn: () => void) => {
          if (readySettled) return;
          readySettled = true;
          clearTimeout(timer);
          session.abort.signal.removeEventListener('abort', abort);
          child.off('error', onError);
          child.off('exit', onExit);
          fn();
        };
        const timer = setTimeout(() => settleReady(() => reject(new DesktopError('START_FAILED'))), 15_000);
        const abort = () => settleReady(() => reject(new DesktopError('STOPPED')));
        const onError = () => settleReady(() => reject(new DesktopError('START_FAILED')));
        const onExit = () => settleReady(() => reject(new DesktopError('START_FAILED')));
        session.abort.signal.addEventListener('abort', abort, { once: true });
        child.once('error', onError);
        child.once('exit', onExit);
        child.once('spawn', () => { if (session.abort.signal.aborted) abort(); });
        child.stdout.on('data', (data: Buffer) => {
          stdoutBuffer += data.toString('utf8');
          let end = stdoutBuffer.indexOf('\n');
          while (end >= 0) {
            const line = stdoutBuffer.slice(0, end).trim();
            stdoutBuffer = stdoutBuffer.slice(end + 1);
            if (!readySettled) {
              if (line === 'ready') settleReady(resolve);
              else settleReady(() => reject(new DesktopError('START_FAILED')));
            } else if (line) {
              try {
                const reply = supervisorSpawnReplySchema.safeParse(JSON.parse(line));
                if (reply.success) {
                  const waiter = session.spawnWaiters.get(reply.data.id);
                  if (waiter) {
                    session.spawnWaiters.delete(reply.data.id);
                    waiter(reply.data.ok);
                  }
                }
              } catch { /* Ignore malformed supervisor output. */ }
            }
            end = stdoutBuffer.indexOf('\n');
          }
        });
      });
      assertActive();
      child.once('exit', () => { void cleanup(session); });
      session.state = 'ready';
      return session;
    } catch (error) { await cleanup(session); throw error instanceof DesktopError ? error : new DesktopError('START_FAILED'); }
  };
  const spawnOnSession = (session: DesktopSession, command: { file: string; args: string[] }, env: Record<string, string>): Promise<boolean> => {
    if (!session.child?.stdin || session.child.stdin.destroyed || session.abort.signal.aborted) return Promise.resolve(false);
    const id = randomUUID();
    const payload: SupervisorSpawnRequest = { type: 'spawn', id, command, env };
    return new Promise((resolve) => {
      const timer = setTimeout(() => { session.spawnWaiters.delete(id); resolve(false); }, 10_000);
      const onAbort = () => { clearTimeout(timer); session.spawnWaiters.delete(id); resolve(false); };
      session.abort.signal.addEventListener('abort', onAbort, { once: true });
      session.spawnWaiters.set(id, (ok) => {
        clearTimeout(timer);
        session.abort.signal.removeEventListener('abort', onAbort);
        resolve(ok);
      });
      try {
        session.child!.stdin!.write(`${JSON.stringify(payload)}\n`);
      } catch {
        clearTimeout(timer);
        session.abort.signal.removeEventListener('abort', onAbort);
        session.spawnWaiters.delete(id);
        resolve(false);
      }
    });
  };
  return {
    start(options: { width?: number; height?: number } = {}): Promise<DesktopSession> {
      if (shuttingDown) return Promise.reject(new DesktopError('STOPPED'));
      const current = activeSession;
      if (current) return current.abort.signal.aborted
        ? current.ready.catch(() => undefined).then(() => cleanup(current)).then(() => this.start(options))
        : current.ready;
      const session: DesktopSession = {
        id: randomUUID(), display: '', state: 'starting', displayLock: null, password: randomBytes(6).toString('base64'), port: 0,
        child: null, directory: null, releaseDisplay: null, viewers: new Set(), user: null, browserEnv: null, spawnWaiters: new Map(), abort: new AbortController(),
        ready: Promise.resolve().then(() => prepare(session, options)),
      };
      activeSession = session;
      return session.ready;
    },
    async openUrl(options: { url: string; width?: number; height?: number }): Promise<DesktopSession> {
      if (shuttingDown) throw new DesktopError('STOPPED');
      if (process.platform !== 'linux') throw new DesktopError('UNSUPPORTED');
      const browser = await resolveBrowser();
      if (!browser) throw new DesktopError('NO_BROWSER');
      const session = await this.start({ width: options.width, height: options.height });
      if (session.abort.signal.aborted || !session.user || !session.browserEnv) throw new DesktopError('STOPPED');
      const profileDir = path.join(session.user.home, '.config', 'openchamber', 'remote-desktop-browser');
      await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
      if (process.getuid?.() === 0) await fs.chown(profileDir, session.user.uid, session.user.gid);
      const command = buildBrowserCommand(browser, options.url, { profileDir, uid: session.user.uid });
      const spawned = await spawnOnSession(session, command, session.browserEnv);
      if (!spawned) throw new DesktopError('BROWSER_FAILED');
      return session;
    },
    get(id: string) { return activeSession && activeSession.id === id && activeSession.state === 'ready' && !activeSession.abort.signal.aborted ? activeSession : null; },
    status() {
      return activeSession && !activeSession.abort.signal.aborted
        ? { id: activeSession.id, display: activeSession.display, ready: activeSession.state === 'ready' }
        : null;
    },
    watch(session: DesktopSession, close: () => void) {
      session.viewers.add(close);
      return () => { session.viewers.delete(close); };
    },
    async stop() {
      const current = activeSession;
      if (!current) return;
      current.abort.abort();
      await current.ready.catch(() => undefined);
      await cleanup(current);
    },
    async stopAll() { shuttingDown = true; await this.stop(); },
  };
};

const sessionCommand = (session: DesktopSession, environment: DesktopEnvironment, options: { width?: number; height?: number }, passwordFile: string, env: Record<string, string>): SessionSpec => {
  const cleanup = { directory: session.directory!, ownerPid: process.pid, displayLock: session.displayLock ?? undefined };
  const file = environment.binaries.virtual!;
  const desktop = { file: environment.binaries.dbus ?? environment.binaries.desktop!, args: environment.binaries.dbus ? ['--', environment.binaries.desktop!] : [] };
  return { vnc: { file, args: [session.display, '-interface', '127.0.0.1', '-localhost', '-rfbport', String(session.port), '-PasswordFile', passwordFile, '-SecurityTypes', 'VncAuth', '-AlwaysShared', '-geometry', `${options.width ?? 1280}x${options.height ?? 800}`, '-depth', '24', '-nolisten', 'tcp', '-auth', env.XAUTHORITY!, '-desktop', 'OpenChamber'] }, desktop, port: session.port, env, cleanup };
};
