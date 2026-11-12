import { z } from 'zod';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { currentUser, inspectEnvironment, type DesktopEnvironment, type DesktopUser } from './environment.ts';
import { reserveDisplay, type SessionSpec } from './supervisor.ts';

import type { DesktopMode, DesktopFailure } from '../contract.ts';
export class DesktopError extends Error {
  constructor(readonly code: DesktopFailure) { super(code); }
}
type SessionKey = 'virtual' | `physical:${string}`;
type DesktopSession = {
  key: SessionKey; id: string; mode: DesktopMode; display: string; password: string; port: number; state: 'starting' | 'ready'; displayLock: string | null;
  child: ChildProcess | null; directory: string | null; abort: AbortController;
  releaseDisplay: (() => Promise<void>) | null; viewers: Set<() => void>;
  ready: Promise<DesktopSession>; idleTimer: ReturnType<typeof setTimeout> | null;
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

const childEnvironment = (user: DesktopUser, display: string, authority: string) => ({
  PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: user.home, USER: user.name, LOGNAME: user.name,
  LANG: process.env.LANG ?? 'en_US.UTF-8', DISPLAY: display, XAUTHORITY: authority,
  XDG_RUNTIME_DIR: `/run/user/${user.uid}`,
  ELECTRON_RUN_AS_NODE: '1',
});

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

export const createDesktopSessions = (entry = fileURLToPath(import.meta.url), createDirectory = () => fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-desktop-'))) => {
  const sessions = new Map<SessionKey, DesktopSession>();
  const cleaning = new WeakMap<DesktopSession, Promise<void>>();
  let shuttingDown = false;
  const cleanup = (session: DesktopSession): Promise<void> => {
    const current = cleaning.get(session);
    if (current) return current;
    const pending = (async () => {
    session.abort.abort();
    if (session.idleTimer) clearTimeout(session.idleTimer);
    for (const close of [...session.viewers]) close();
    session.viewers.clear();
    if (session.child) await stopChild(session.child);
    if (session.directory) await fs.rm(session.directory, { recursive: true, force: true });
    await session.releaseDisplay?.();
    if (sessions.get(session.key) === session) sessions.delete(session.key);
    })();
    cleaning.set(session, pending);
    return pending;
  };
  const prepare = async (session: DesktopSession, options: { display?: string; width?: number; height?: number }) => {
    const assertActive = () => { if (session.abort.signal.aborted || shuttingDown) throw new DesktopError('STOPPED'); };
    try {
      const environment = await inspectEnvironment();
      assertActive();
      if (environment.platform !== 'linux') throw new DesktopError('UNSUPPORTED');
      if (!environment.binaries.password) throw new DesktopError('NO_PASSWORD_TOOL');
      environment.displays = environment.displays.filter((item) => item.display !== sessions.get('virtual')?.display);
      const display = environment.displays.find((item) => item.display === options.display) ?? (!options.display ? environment.displays.find((item) => item.authority) ?? environment.displays[0] : undefined);
      let user = display ?? currentUser();
      let authority = '';
      if (session.mode === 'physical') {
        if (!display) throw new DesktopError('NO_X11');
        if (!environment.binaries.physical) throw new DesktopError('NO_PHYSICAL_SERVER');
        if (!display.authority) throw new DesktopError('NO_XAUTHORITY');
        user = display;
        authority = display.authority;
        session.display = display.display;
      } else {
        if (!environment.binaries.virtual) throw new DesktopError('NO_VIRTUAL_SERVER');
        if (!environment.binaries.desktop) throw new DesktopError('NO_DESKTOP');
        const reserved = await reserveDisplay();
        session.display = reserved.display;
        session.releaseDisplay = reserved.release;
        session.displayLock = reserved.lock;
        if (process.getuid?.() === 0) await fs.chown(reserved.lock, user.uid, user.gid);
      }
      assertActive();
      session.directory = await createDirectory();
      await fs.chmod(session.directory, 0o700);
      if (process.getuid?.() === 0) await fs.chown(session.directory, user.uid, user.gid);
      assertActive();
      const passwordFile = path.join(session.directory, 'vnc-password');
      const password = await passwordBytes(environment.binaries.password, session.password, session.abort.signal);
      await fs.writeFile(passwordFile, password, { mode: 0o600 });
      if (process.getuid?.() === 0) await fs.chown(passwordFile, user.uid, user.gid);
      if (session.mode === 'virtual') {
        authority = path.join(session.directory, 'Xauthority');
        await fs.writeFile(authority, xAuthority(session.display), { mode: 0o600 });
        if (process.getuid?.() === 0) await fs.chown(authority, user.uid, user.gid);
      }
      assertActive();
      session.port = await reservePort();
      assertActive();
      const spec = sessionCommand(session, environment, options, passwordFile, childEnvironment(user, session.display, authority));
      const child = spawn(process.execPath, [entry, '--desktop-session'], {
        env: { PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: '1' },
        detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
        uid: process.getuid?.() === 0 ? user.uid : undefined,
        gid: process.getuid?.() === 0 ? user.gid : undefined,
      });
      session.child = child;
      child.stdin.on('error', () => {});
      child.stdin.write(`${JSON.stringify(spec)}\n`);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new DesktopError('START_FAILED')), 15_000);
        const abort = () => reject(new DesktopError('STOPPED'));
        session.abort.signal.addEventListener('abort', abort, { once: true });
        child.once('error', () => reject(new DesktopError('START_FAILED')));
        child.once('exit', () => reject(new DesktopError('START_FAILED')));
        child.stdout.once('data', (data: Buffer) => data.toString().trim() === 'ready' ? resolve() : reject(new DesktopError('START_FAILED')));
        child.once('spawn', () => { if (session.abort.signal.aborted) abort(); });
        const done = () => { clearTimeout(timer); session.abort.signal.removeEventListener('abort', abort); };
        child.stdout.once('data', done); child.once('exit', done); child.once('error', done);
        session.abort.signal.addEventListener('abort', done, { once: true });
      });
      assertActive();
      child.once('exit', () => { void cleanup(session); });
      session.state = 'ready';
      if (session.mode === 'physical') scheduleIdle(session);
      return session;
    } catch (error) { await cleanup(session); throw error instanceof DesktopError ? error : new DesktopError('START_FAILED'); }
  };
  const scheduleIdle = (session: DesktopSession) => {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    if (session.mode !== 'physical' || session.viewers.size > 0 || session.abort.signal.aborted) return;
    session.idleTimer = setTimeout(() => { session.idleTimer = null; void cleanup(session); }, 15_000);
    session.idleTimer.unref?.();
  };
  return {
    start(mode: DesktopMode, options: { display?: string; width?: number; height?: number } = {}): Promise<DesktopSession> {
      if (shuttingDown) return Promise.reject(new DesktopError('STOPPED'));
      const key: SessionKey = mode === 'virtual' ? 'virtual' : `physical:${options.display ?? 'default'}`;
      const current = sessions.get(key);
      if (current) return current.abort.signal.aborted
        ? current.ready.catch(() => undefined).then(() => cleanup(current)).then(() => this.start(mode, options))
        : current.ready;
      const session: DesktopSession = { key, id: randomUUID(), mode, display: '', state: 'starting', displayLock: null, password: randomBytes(6).toString('base64'), port: 0,
        child: null, directory: null, releaseDisplay: null, viewers: new Set(), abort: new AbortController(), ready: Promise.resolve().then(() => prepare(session, options)), idleTimer: null };
      sessions.set(key, session);
      return session.ready;
    },
    get(id: string) { return [...sessions.values()].find((item) => item.id === id && item.state === 'ready' && !item.abort.signal.aborted) ?? null; },
    list() { return [...sessions.values()].filter((item) => !item.abort.signal.aborted).map(({ id, mode, display, state }) => ({ id, mode, display, ready: state === 'ready' })); },
    watch(session: DesktopSession, close: () => void) {
      if (session.idleTimer) clearTimeout(session.idleTimer);
      session.viewers.add(close);
      return () => { session.viewers.delete(close); scheduleIdle(session); };
    },
    async stop(mode: DesktopMode) {
      const selected = [...sessions.values()].filter((session) => session.mode === mode);
      for (const session of selected) session.abort.abort();
      await Promise.all(selected.map(async (session) => {
        await session.ready.catch(() => undefined);
        await cleanup(session);
      }));
    },
    async stopAll() { shuttingDown = true; await Promise.all([this.stop('physical'), this.stop('virtual')]); },
  };
};

const sessionCommand = (session: DesktopSession, environment: DesktopEnvironment, options: { width?: number; height?: number }, passwordFile: string, env: Record<string, string>): SessionSpec => {
  const cleanup = { directory: session.directory!, ownerPid: process.pid, displayLock: session.displayLock ?? undefined };
  if (session.mode === 'physical') {
    const file = environment.binaries.physical!;
    const args = path.basename(file) === 'x11vnc'
      ? ['-display', session.display, '-auth', env.XAUTHORITY!, '-localhost', '-listen', '127.0.0.1', '-rfbport', String(session.port), '-rfbauth', passwordFile, '-forever', '-shared', '-quiet']
      : ['-display', session.display, '-interface', '127.0.0.1', '-localhost', '-rfbport', String(session.port), '-PasswordFile', passwordFile, '-SecurityTypes', 'VncAuth', '-AlwaysShared'];
    return { vnc: { file, args }, port: session.port, env, cleanup };
  }
  const file = environment.binaries.virtual!;
  const desktop = { file: environment.binaries.dbus ?? environment.binaries.desktop!, args: environment.binaries.dbus ? ['--', environment.binaries.desktop!] : [] };
  return { vnc: { file, args: [session.display, '-interface', '127.0.0.1', '-localhost', '-rfbport', String(session.port), '-PasswordFile', passwordFile, '-SecurityTypes', 'VncAuth', '-AlwaysShared', '-geometry', `${options.width ?? 1280}x${options.height ?? 800}`, '-depth', '24', '-nolisten', 'tcp', '-auth', env.XAUTHORITY!, '-desktop', 'OpenChamber'] }, desktop, port: session.port, env, cleanup };
};
