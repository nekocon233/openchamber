// One `codex app-server` process serves every Codex thread OpenChamber opens.
// It starts on first use, and a process that exits is started again on the
// next request, never in a loop of its own; start failures back off.

import os from 'node:os';

import { cliMissingError } from '../errors.js';
import { spawnCliProcess, terminateCliProcess } from '../process.js';
import { createJsonRpcConnection } from './rpc.js';

const MAX_BACKOFF_MS = 30_000;
const STDERR_TAIL_CHARS = 4000;

const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms).unref?.();
});

/**
 * @param {object} options
 * @param {() => Promise<string | null>} options.resolveExecutable path of the `codex` binary
 * @param {() => Record<string, string>} options.buildEnv
 * @param {() => Promise<{ arguments: string[], environment: Record<string, string> }>} [options.buildConnectionOverrides]
 *   the `-c` overrides and environment of the configured connections, read on every start
 * @param {(method: string, params: Record<string, unknown>) => void} options.onNotification
 * @param {(method: string, params: Record<string, unknown>) => Promise<unknown>} options.onServerRequest
 * @param {(error: Error) => void} options.onExit the process or its connection went away
 * @param {string} options.clientVersion
 */
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
}) => {
  let connection = null;
  let child = null;
  let starting = null;
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

  const start = async () => {
    const wait = nextStartAt - now();
    if (wait > 0) await sleep(wait);
    const executable = await resolveExecutable();
    if (!executable) throw cliMissingError('codex');
    const overrides = await buildConnectionOverrides();
    // The connection keys ride in this process's environment; provider
    // diagnostics sometimes echo the credential they rejected.
    const secrets = Object.values(overrides.environment).filter(Boolean);
    const redact = (text) => secrets.reduce((out, secret) => out.replaceAll(secret, '[redacted]'), text);

    const proc = spawnProcess(
      executable,
      ['app-server', '--listen', 'stdio://', ...overrides.arguments],
      { cwd, env: { ...buildEnv(), ...overrides.environment } },
    );
    stderrTail = '';
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (text) => {
      stderrTail = redact(`${stderrTail}${text}`).slice(-STDERR_TAIL_CHARS);
    });

    let initialized = false;
    const conn = createJsonRpcConnection({
      child: proc,
      onNotification,
      onRequest: onServerRequest,
      onClose: (error) => {
        if (connection === conn) {
          connection = null;
          child = null;
        }
        // A restart is a deliberate exit; it must not count toward backoff.
        if (!initialized || !(stopped || expectedExit)) noteFailure();
        if (initialized) onExit(error);
      },
    });
    proc.on('error', (error) => conn.close(error));
    proc.on('exit', (code, signal) => conn.close(new Error(
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

  const ensure = () => {
    if (stopped) return Promise.reject(new Error('Codex app-server is stopped'));
    if (connection && !connection.isClosed()) return Promise.resolve(connection);
    starting ??= start().finally(() => {
      starting = null;
    });
    return starting;
  };

  return {
    /**
     * @param {string} method
     * @param {Record<string, unknown>} [params]
     */
    async request(method, params = {}) {
      const conn = await ensure();
      return conn.request(method, params);
    },

    isRunning() {
      return connection !== null && !connection.isClosed();
    },

    /**
     * Records that the running process was started from outdated connection
     * overrides. A process that is not running is not stale: its next start
     * reads the current overrides anyway.
     */
    markStale() {
      stale = connection !== null && !connection.isClosed();
    },

    isStale() {
      return stale;
    },

    /**
     * Restarts the process so changed connection overrides take effect. Every
     * Codex thread shares this process, so a caller may only restart while no
     * thread is running a turn.
     */
    async restart() {
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

    async stop() {
      stopped = true;
      const running = child;
      connection?.close(new Error('Codex app-server stopped'));
      if (running) await terminateProcess(running);
    },
  };
};
