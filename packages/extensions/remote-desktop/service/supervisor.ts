import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs/promises';

export type SessionCommand = { file: string; args: string[] };
export type SessionSpec = { vnc: SessionCommand; desktop?: SessionCommand; port: number; env: Record<string, string>; cleanup: { directory: string; displayLock?: string; ownerPid: number } };

export const canConnect = (port: number): Promise<boolean> => new Promise((resolve) => {
  const socket = net.createConnection({ host: '127.0.0.1', port });
  const finish = (ok: boolean) => { socket.destroy(); resolve(ok); };
  socket.once('connect', () => finish(true));
  socket.once('error', () => finish(false));
  socket.setTimeout(200, () => finish(false));
});

/** Shares a process group with VNC and the desktop. EOF means its service died. */
export const runSessionSupervisor = (): void => {
  let stopping = false;
  let cleanup: SessionSpec['cleanup'] | null = null;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    process.stdin.pause();
    if (cleanup) {
      void fs.rm(cleanup.directory, { recursive: true, force: true }).catch(() => undefined);
      if (cleanup.displayLock && process.ppid !== cleanup.ownerPid) void fs.unlink(cleanup.displayLock).catch(() => undefined);
    }
    try { process.kill(-process.pid, 'SIGTERM'); } catch { /* The group already ended. */ }
    setTimeout(() => { try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(0); } }, 1000);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.stdin.once('end', shutdown);
  process.stdin.once('error', shutdown);
  let config = '';
  process.stdin.on('data', (chunk: Buffer) => {
    config += chunk.toString();
    if (config.length > 16_000) { shutdown(); return; }
    const end = config.indexOf('\n');
    if (end < 0) return;
    process.stdin.removeAllListeners('data');
    void (async () => {
      // Only the parent service writes this private pipe.
      const spec: SessionSpec = JSON.parse(config.slice(0, end));
      cleanup = spec.cleanup;
      const start = (command: SessionCommand) => {
        const child = spawn(command.file, command.args, { env: spec.env, stdio: 'ignore', windowsHide: true });
        child.once('error', shutdown);
        child.once('exit', shutdown);
        return child;
      };
      start(spec.vnc);
      const deadline = Date.now() + 12_000;
      while (!stopping && Date.now() < deadline) {
        if (await canConnect(spec.port)) {
          if (spec.desktop) start(spec.desktop);
          process.stdout.write('ready\n');
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      shutdown();
    })().catch(shutdown);
  });
  // A hard parent exit closes the pipe. No detached desktop survives it.
};

export const reserveDisplay = async (start = 90, end = 190): Promise<{ display: string; lock: string; release: () => Promise<void> }> => {
  for (let number = start; number <= end; number += 1) {
    const lock = `/tmp/openchamber-desktop-${number}.lock`;
    try {
      if (await fs.lstat(`/tmp/.X11-unix/X${number}`).catch(() => null) || await fs.lstat(`/tmp/.X${number}-lock`).catch(() => null)) continue;
      const file = await fs.open(lock, 'wx', 0o600);
      await file.writeFile(String(process.pid));
      await file.close();
      let released = false;
      return { display: `:${number}`, lock, release: async () => { if (released) return; released = true; await fs.unlink(lock).catch(() => undefined); } };
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('NO_DISPLAY');
};
