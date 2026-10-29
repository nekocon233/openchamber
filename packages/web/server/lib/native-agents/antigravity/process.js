// Process supervision adapted from Paseo's antigravity-provider (MIT):
// https://github.com/getpaseo/paseo/blob/main/plugins/antigravity-provider/server/internal/process.ts

import { createInterface } from 'node:readline';

import { spawnCliProcess, signalCliProcess } from '../process.js';
import { encodeAgyPrompt, parseAgyStreamFrame } from './protocol.js';

export const agyProcessArgs = ({ cwd, model = null, conversationId = null }) => [
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--add-dir', cwd,
  '--disable-slash-commands',
  '--print-timeout', '0',
  '--dangerously-skip-permissions',
  ...(model ? ['--model', model] : []),
  ...(conversationId ? ['--conversation', conversationId] : []),
];

export const agyDiagnostic = (message) => (
  /auth|sign[ -]?in|log[ -]?in/i.test(message)
    ? 'Antigravity authentication failed. Run `agy` on the server and sign in, then retry.'
    : message
);

/** Starts one persistent agy process. Frame consumers serialize their own work. */
export const startAgyProcess = ({
  executable,
  args,
  cwd,
  env,
  onFrame,
  onExit,
  startupTimeoutMs = 30_000,
}) => {
  const child = spawnCliProcess(executable, args, { cwd, env });
  const lines = createInterface({ input: child.stdout });
  let state = 'starting';
  let failure = null;
  let exitNotified = false;
  let stderr = '';
  let resolveReady;
  let rejectReady;
  let resolveExited;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const exited = new Promise((resolve) => {
    resolveExited = resolve;
  });
  const timers = new Set();
  const later = (callback, delay) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      callback();
    }, delay);
    timer.unref?.();
    timers.add(timer);
    return timer;
  };
  const clearTimers = () => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };
  const stop = (reason) => {
    if (state === 'exited') return exited;
    if (state !== 'stopping') {
      state = 'stopping';
      if (reason === 'close') child.stdin.end();
      else signalCliProcess(child, 'SIGINT');
      later(() => signalCliProcess(child, 'SIGTERM'), 1_000);
      later(() => signalCliProcess(child, 'SIGKILL'), 2_000);
    }
    return exited;
  };
  const fail = (error) => {
    failure = error;
    if (state === 'starting') rejectReady(error);
    void stop('interrupt');
  };
  const startupDeadline = later(() => {
    fail(new Error('Antigravity did not initialize within 30 seconds'));
  }, startupTimeoutMs);

  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-8192);
  });
  child.stdin.on('error', (error) => {
    if (state !== 'stopping' && state !== 'exited') fail(error);
  });
  child.on('error', (error) => fail(error));
  child.on('close', (code, signal) => {
    clearTimers();
    lines.close();
    const previousState = state;
    state = 'exited';
    const error = failure ?? (previousState === 'stopping'
      ? null
      : new Error(agyDiagnostic(stderr.trim() || `Antigravity exited (${signal || code})`)));
    if (previousState === 'starting') rejectReady(error ?? new Error('Antigravity startup canceled'));
    if (!exitNotified) {
      exitNotified = true;
      onExit(error);
    }
    resolveExited();
  });
  lines.on('line', (line) => {
    if (line.trim() === '' || state === 'exited') return;
    let decoded;
    try {
      decoded = parseAgyStreamFrame(line);
    } catch (error) {
      fail(new Error(`Invalid Antigravity output: ${error instanceof Error ? error.message : error}`));
      return;
    }
    if (state === 'starting') {
      if (decoded.event === 'init') {
        clearTimeout(startupDeadline);
        timers.delete(startupDeadline);
        state = 'ready';
        resolveReady(decoded);
      } else if (decoded.event === 'result') {
        fail(new Error(agyDiagnostic(decoded.result.error || decoded.result.response || 'Antigravity startup failed')));
      }
      return;
    }
    onFrame(decoded);
  });

  return {
    ready,
    exited,
    acceptsInput() {
      return state === 'ready' && child.stdin.writable && !child.stdin.destroyed;
    },
    write(text) {
      if (state !== 'ready' || !child.stdin.writable) {
        return Promise.reject(new Error('Antigravity is not ready to accept a prompt'));
      }
      return new Promise((resolve, reject) => {
        child.stdin.write(encodeAgyPrompt(text), (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
    stop,
  };
};
