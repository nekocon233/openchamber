import type { ChildProcess } from 'node:child_process';
import os from 'node:os';

import type { JsonObject } from '../../shared/json-values.js';
import { cliMissingError } from '../errors.js';
import { spawnCliProcess, terminateCliProcess } from '../process.js';
import type { CodexConnectionOverrides } from './connections.js';
import { createJsonRpcConnection, type JsonRpcConnection, type JsonRpcResult } from './rpc.js';

const MAX_BACKOFF_MS = 30_000;
const STDERR_TAIL_CHARS = 4000;
const APP_SERVER_ARGUMENTS = ['-c', 'tools.update_plan.enabled=true'];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, ms).unref?.();
});

export interface CodexAppServerOptions {
  resolveExecutable: () => Promise<string | null>;
  buildEnv: () => Record<string, string>;
  buildConnectionOverrides?: (() => Promise<CodexConnectionOverrides>) | undefined;
  onNotification: (method: string, params: JsonObject) => void;
  onServerRequest: (method: string, params: JsonObject) => Promise<JsonRpcResult>;
  onExit: (error: Error) => void;
  clientVersion: string;
  spawnProcess?: typeof spawnCliProcess | undefined;
  terminateProcess?: typeof terminateCliProcess | undefined;
  now?: (() => number) | undefined;
  cwd?: string | undefined;
}

export const createCodexAppServer = ({
  resolveExecutable,
  buildEnv,
  buildConnectionOverrides = async () => ({ arguments: [], environment: {} }),
  onNotification,
  onServerRequest,
  onExit,
  clientVersion,
  spawnProcess = spawnCliProcess,
  terminateProcess = terminateCliProcess,
  now = Date.now,
  cwd = os.homedir(),
}: CodexAppServerOptions) => {
  let connection: JsonRpcConnection | null = null;
  let child: ChildProcess | null = null;
  let starting: Promise<JsonRpcConnection> | null = null;
  let consecutiveFailures = 0;
  let nextStartAt = 0;
  let stopped = false;
  let expectedExit = false;
  let stale = false;
  let stderrTail = '';

  const noteFailure = () => {
    consecutiveFailures += 1;
    nextStartAt = now() + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (consecutiveFailures - 1));
  };

  const start = async (): Promise<JsonRpcConnection> => {
    const wait = nextStartAt - now();
    if (wait > 0) await sleep(wait);
    const executable = await resolveExecutable();
    if (!executable) throw cliMissingError('codex');
    const overrides = await buildConnectionOverrides();
    const secrets = Object.values(overrides.environment).filter(Boolean);
    const redact = (text: string): string => secrets.reduce((out, secret) => out.replaceAll(secret, '[redacted]'), text);

    const proc = spawnProcess(
      executable,
      ['app-server', '--listen', 'stdio://', ...APP_SERVER_ARGUMENTS, ...overrides.arguments],
      { cwd, env: { ...buildEnv(), ...overrides.environment } },
    );
    if (!proc.stdin || !proc.stdout) {
      await terminateProcess(proc);
      throw new Error('Codex app-server started without stdio pipes');
    }
    stderrTail = '';
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (chunk: string | Buffer) => {
      stderrTail = redact(`${stderrTail}${String(chunk)}`).slice(-STDERR_TAIL_CHARS);
    });

    let initialized = false;
    const conn = createJsonRpcConnection({
      child: { stdin: proc.stdin, stdout: proc.stdout },
      onNotification,
      onRequest: onServerRequest,
      onClose: (error) => {
        if (connection === conn) {
          connection = null;
          child = null;
        }
        if (!initialized || !(stopped || expectedExit)) noteFailure();
        if (initialized) onExit(error);
      },
    });
    proc.on('error', (error: Error) => conn.close(error));
    proc.on('exit', (code: number | null, signal: NodeJS.Signals | null) => conn.close(new Error(
      `Codex app-server exited (${signal ?? code})${stderrTail ? `: ${stderrTail.trim().split('\n').at(-1)}` : ''}`,
    )));

    try {
      await conn.request('initialize', {
        clientInfo: { name: 'openchamber', title: 'OpenChamber', version: clientVersion },
        capabilities: { experimentalApi: true },
      });
      conn.notify('initialized');
    } catch (error) {
      conn.close(error instanceof Error ? error : new Error(String(error)));
      await terminateProcess(proc);
      throw error;
    }
    initialized = true;
    consecutiveFailures = 0;
    connection = conn;
    child = proc;
    return conn;
  };

  const ensure = (): Promise<JsonRpcConnection> => {
    if (stopped) return Promise.reject(new Error('Codex app-server is stopped'));
    if (connection && !connection.isClosed()) return Promise.resolve(connection);
    starting ??= start().finally(() => {
      starting = null;
    });
    return starting;
  };

  return {
    async request(method: string, params: JsonObject = {}): Promise<JsonRpcResult> {
      const conn = await ensure();
      return conn.request(method, params);
    },

    isRunning(): boolean {
      return connection !== null && !connection.isClosed();
    },

    markStale() {
      stale = connection !== null && !connection.isClosed();
    },

    isStale(): boolean {
      return stale;
    },

    async restart(): Promise<void> {
      if (stopped) return;
      stale = false;
      const running = child;
      if (!running) return;
      expectedExit = true;
      try {
        connection?.close(new Error('Codex app-server restarting'));
        await terminateProcess(running);
      } finally {
        expectedExit = false;
      }
    },

    async stop(): Promise<void> {
      stopped = true;
      const running = child;
      connection?.close(new Error('Codex app-server stopped'));
      if (running) await terminateProcess(running);
    },
  };
};

export type CodexAppServer = ReturnType<typeof createCodexAppServer>;
