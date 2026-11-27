import { createInterface } from 'node:readline';

import { spawnCliProcess, signalCliProcess } from '../process.js';
import { encodeAgyPrompt, parseAgyStreamFrame } from './protocol.js';
import type { AgyInitFrame, AgyStreamFrame } from './protocol.js';

export interface AgyProcessArgsOptions {
  cwd: string;
  model?: string | null | undefined;
  conversationId?: string | null | undefined;
  agent?: 'build' | 'plan' | null | undefined;
  effort?: string | null | undefined;
  settingsFile?: string | null | undefined;
  allowSlashCommands?: boolean | undefined;
}

export interface StartAgyProcessOptions {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  onFrame: (frame: AgyStreamFrame) => void;
  onExit: (error: Error | null) => void;
  startupTimeoutMs?: number | undefined;
}

export interface AgyProcessHandle {
  ready: Promise<AgyInitFrame>;
  exited: Promise<void>;
  acceptsInput: () => boolean;
  write: (text: string) => Promise<void>;
  stop: (reason: 'close' | 'interrupt') => Promise<void>;
}

export const agyProcessArgs = ({
  cwd,
  model = null,
  conversationId = null,
  agent = 'build',
  effort = null,
  settingsFile = null,
  allowSlashCommands = false,
}: AgyProcessArgsOptions): string[] => [
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--add-dir', cwd,
  allowSlashCommands || agent === 'plan' ? '--disable-slash-commands=false' : '--disable-slash-commands',
  '--print-timeout', '0',
  ...(agent ? ['--mode', agent === 'plan' ? 'plan' : 'accept-edits'] : []),
  ...(agent ? ['--dangerously-skip-permissions'] : []),
  ...(model ? ['--model', model] : []),
  ...(effort ? ['--effort', effort] : []),
  ...(settingsFile ? ['--settings', settingsFile] : []),
  ...(conversationId ? ['--conversation', conversationId] : []),
];

export const agyDiagnostic = (message: string): string => (
  /auth|sign[ -]?in|log[ -]?in/i.test(message)
    ? 'Antigravity authentication failed. Run `agy` on the server and sign in, then retry.'
    : message
);

export const startAgyProcess = ({
  executable,
  args,
  cwd,
  env,
  onFrame,
  onExit,
  startupTimeoutMs = 30_000,
}: StartAgyProcessOptions): AgyProcessHandle => {
  const child = spawnCliProcess(executable, args, { cwd, env });
  const { stdin, stdout, stderr: stderrStream } = child;
  if (!stdin || !stdout || !stderrStream) {
    throw new Error('Antigravity child process stdio pipes are unavailable');
  }
  const lines = createInterface({ input: stdout });
  let state: 'starting' | 'ready' | 'stopping' | 'exited' = 'starting';
  let failure: Error | null = null;
  let exitNotified = false;
  let stderr = '';
  let resolveReady: (frame: AgyInitFrame) => void = () => undefined;
  let rejectReady: (error: Error) => void = () => undefined;
  let resolveExited: () => void = () => undefined;
  const ready = new Promise<AgyInitFrame>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const exited = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (callback: () => void, delay: number): ReturnType<typeof setTimeout> => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      callback();
    }, delay);
    timer.unref?.();
    timers.add(timer);
    return timer;
  };
  const clearTimers = (): void => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };
  const stop = (reason: 'close' | 'interrupt'): Promise<void> => {
    if (state === 'exited') return exited;
    if (state !== 'stopping') {
      state = 'stopping';
      if (reason === 'close') stdin.end();
      else signalCliProcess(child, 'SIGINT');
      later(() => signalCliProcess(child, 'SIGTERM'), 1_000);
      later(() => signalCliProcess(child, 'SIGKILL'), 2_000);
    }
    return exited;
  };
  const fail = (error: Error): void => {
    failure = error;
    if (state === 'starting') rejectReady(error);
    void stop('interrupt');
  };
  const startupDeadline = later(() => {
    fail(new Error('Antigravity did not initialize within 30 seconds'));
  }, startupTimeoutMs);

  stderrStream.on('data', (chunk: Buffer | string) => {
    stderr = (stderr + chunk.toString()).slice(-8192);
  });
  stdin.on('error', (error: Error) => {
    if (state !== 'stopping' && state !== 'exited') fail(error);
  });
  child.on('error', (error: Error) => fail(error));
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
  lines.on('line', (line: string) => {
    if (line.trim() === '' || state === 'exited') return;
    let decoded: AgyStreamFrame;
    try {
      decoded = parseAgyStreamFrame(line);
    } catch (error) {
      fail(new Error(`Invalid Antigravity output: ${error instanceof Error ? error.message : String(error)}`));
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
      return state === 'ready' && stdin.writable && !stdin.destroyed;
    },
    write(text) {
      if (state !== 'ready' || !stdin.writable) {
        return Promise.reject(new Error('Antigravity is not ready to accept a prompt'));
      }
      return new Promise<void>((resolve, reject) => {
        stdin.write(encodeAgyPrompt(text), (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
    stop,
  };
};
