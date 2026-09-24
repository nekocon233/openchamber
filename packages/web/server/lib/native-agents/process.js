// Child processes for the native CLIs.
//
// The CLIs run with the user's environment (the server already merged the
// login shell's variables into process.env), minus what belongs to
// OpenChamber itself: its credentials must not be readable by an agent
// through `env`, and variables a parent Claude Code session exported would
// make the child believe it is nested inside another session.

import { spawn } from 'node:child_process';

import { isWindowsShim } from './executables.js';

const OPENCHAMBER_ENV = /^(OPENCHAMBER_|OPENCODE_SERVER_)/;
const PARENT_CLAUDE_SESSION_ENV = new Set(['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']);

/**
 * @param {NodeJS.ProcessEnv} baseEnv
 * @param {string} searchPath PATH the CLI should see
 * @returns {Record<string, string>}
 */
export const buildCliChildEnv = (baseEnv, searchPath) => {
  const env = {};
  for (const [name, value] of Object.entries(baseEnv)) {
    if (value === undefined || OPENCHAMBER_ENV.test(name) || PARENT_CLAUDE_SESSION_ENV.has(name)) continue;
    env[name] = value;
  }
  env.PATH = searchPath;
  return env;
};

/**
 * What to run for `executable args`. A Windows batch shim runs through
 * `cmd.exe`, which parses the command line itself, so shim arguments must be
 * plain tokens; the callers pass fixed ones.
 * @param {string} executable
 * @param {string[]} args
 * @param {{ platform?: NodeJS.Platform, comSpec?: string }} [host]
 * @returns {{ command: string, args: string[] }}
 */
export const cliCommand = (executable, args, { platform = process.platform, comSpec = process.env.ComSpec } = {}) => (
  isWindowsShim(executable, platform)
    ? { command: comSpec || 'cmd.exe', args: ['/d', '/s', '/c', 'call', executable, ...args] }
    : { command: executable, args }
);

/**
 * Starts a CLI in its own process group on POSIX so the whole tree can be
 * stopped, without a console window on Windows.
 * @param {string} executable
 * @param {string[]} args
 * @param {{ cwd: string, env: Record<string, string>, stdio?: import('node:child_process').StdioOptions }} options
 */
export const spawnCliProcess = (executable, args, { cwd, env, stdio = ['pipe', 'pipe', 'pipe'] }) => {
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

/**
 * Stops a CLI and its descendants: SIGTERM to the process group, then
 * SIGKILL if it is still running after a grace period. Windows ends the tree
 * with a hidden `taskkill`.
 * @param {import('node:child_process').ChildProcess} child
 */
export const terminateCliProcess = (child) => new Promise((resolve) => {
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

const signalTree = (pid, signal) => {
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
      // Already gone.
    }
  }
};
