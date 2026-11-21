import { spawn } from 'node:child_process';
import type { ChildProcess, StdioOptions } from 'node:child_process';

import { isWindowsShim } from './executables.js';

const OPENCHAMBER_ENV = /^(OPENCHAMBER_|OPENCODE_SERVER_)/;
const PARENT_CLAUDE_SESSION_ENV = new Set(['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']);

export interface CliCommandHost {
  platform?: NodeJS.Platform | undefined;
  comSpec?: string | undefined;
}

export interface CliCommand {
  command: string;
  args: string[];
}

export interface SpawnCliProcessOptions {
  cwd: string;
  env: Record<string, string>;
  stdio?: StdioOptions | undefined;
}

export const buildCliChildEnv = (baseEnv: NodeJS.ProcessEnv, searchPath: string) => {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(baseEnv)) {
    if (value === undefined || name === 'NODE_ENV' || OPENCHAMBER_ENV.test(name) || PARENT_CLAUDE_SESSION_ENV.has(name)) continue;
    env[name] = value;
  }
  env.PATH = searchPath;
  return env;
};

export const cliCommand = (
  executable: string,
  args: string[],
  { platform = process.platform, comSpec = process.env.ComSpec }: CliCommandHost = {},
): CliCommand => (
  isWindowsShim(executable, platform)
    ? { command: comSpec || 'cmd.exe', args: ['/d', '/s', '/c', 'call', executable, ...args] }
    : { command: executable, args }
);

export const spawnCliProcess = (
  executable: string,
  args: string[],
  { cwd, env, stdio = ['pipe', 'pipe', 'pipe'] }: SpawnCliProcessOptions,
): ChildProcess => {
  const command = cliCommand(executable, args);
  return spawn(command.command, command.args, {
    cwd,
    env,
    stdio,
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
};

const KILL_GRACE_MS = 2500;

const signalTree = (pid: number, signal: NodeJS.Signals): void => {
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    killer.on('error', () => undefined);
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      return;
    }
  }
};

export const terminateCliProcess = (child: ChildProcess): Promise<void> => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
    resolve();
    return;
  }
  const pid = child.pid;
  const finish = () => {
    clearTimeout(timer);
    resolve();
  };
  child.once('exit', finish);
  const timer = setTimeout(() => {
    signalTree(pid, 'SIGKILL');
    finish();
  }, KILL_GRACE_MS);
  timer.unref?.();
  signalTree(pid, 'SIGTERM');
});

export const signalCliProcess = (child: ChildProcess, signal: NodeJS.Signals): void => {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  signalTree(child.pid, signal);
};
