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
 * @param {(method: string, params: Record<string, unknown>) => void} options.onNotification
 * @param {(method: string, params: Record<string, unknown>) => Promise<unknown>} options.onServerRequest
 * @param {(error: Error) => void} options.onExit the process or its connection went away
 * @param {string} options.clientVersion
 */
export const createCodexAppServer = ({
  resolveExecutable,
  buildEnv,
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

    const proc = spawnProcess(executable, ['app-server', '--listen', 'stdio://'], { cwd, env: buildEnv() });
    stderrTail = '';
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (text) => {
      stderrTail = `${stderrTail}${text}`.slice(-STDERR_TAIL_CHARS);
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
        if (!initialized || !stopped) noteFailure();
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

    async stop() {
      stopped = true;
      const running = child;
      connection?.close(new Error('Codex app-server stopped'));
      if (running) await terminateProcess(running);
    },
  };
};
