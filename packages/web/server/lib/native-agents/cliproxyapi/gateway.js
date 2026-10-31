import path from 'node:path';
import fs from 'node:fs/promises';
import { NativeAgentError } from '../errors.js';
import { spawnCliProcess, terminateCliProcess } from '../process.js';
import { createCliproxyapiClient } from './client.js';
import { gatewayChildEnv, gatewayConfigPath, renderGatewayConfig } from './config.js';

const READINESS_POLL_MS = 200;
const STDERR_TAIL_CHARS = 4096;

const failure = (code, message, status = 502) => new NativeAgentError(message, { code, status });

/**
 * Owns the gateway process: it starts what the store says should be running,
 * waits until the port answers, and reports what is left after a crash. It
 * never adopts a process it did not spawn.
 */
export const createCliproxyapiGateway = ({
  store,
  binaryManager,
  dataDir,
  buildEnv,
  spawnProcess = spawnCliProcess,
  terminateProcess = terminateCliProcess,
  fetchImpl = fetch,
  now = Date.now,
  readinessTimeoutMs = 30_000,
  maxBackoffMs = 30_000,
}) => {
  let child = null;
  let starting = null;
  let stopping = null;
  let expectedExit = false;
  let runningVersion = null;
  let lastError = null;
  let consecutiveFailures = 0;
  let nextStartAt = 0;
  let exitHandlerRegistered = false;

  const client = async (document) => createCliproxyapiClient({
    baseURL: `http://127.0.0.1:${document.port}`,
    managementKey: document.managementKey,
    fetchImpl,
  });

  const killOnParentExit = () => {
    if (exitHandlerRegistered) return;
    exitHandlerRegistered = true;
    process.once('exit', () => {
      if (child !== null) child.kill('SIGKILL');
    });
  };

  const waitForReady = async (baseURL) => {
    const deadline = now() + readinessTimeoutMs;
    const probe = createCliproxyapiClient({ baseURL, managementKey: '', fetchImpl });
    while (now() < deadline) {
      if (child === null) throw failure('CLIPROXYAPI_START_FAILED', 'The gateway exited while starting');
      if (await probe.reachable()) return;
      await new Promise((resolve) => setTimeout(resolve, READINESS_POLL_MS));
    }
    throw failure('CLIPROXYAPI_START_FAILED', 'The gateway did not answer on its port in time');
  };

  const onExit = () => {
    const wasExpected = expectedExit;
    child = null;
    runningVersion = null;
    if (wasExpected) return;
    consecutiveFailures += 1;
    nextStartAt = now() + Math.min(maxBackoffMs, 2 ** (consecutiveFailures - 1) * 1000);
    lastError = lastError ?? 'The gateway stopped on its own';
  };

  const start = async ({ onProgress } = {}) => {
    if (child !== null) return { running: true };
    if (starting !== null) return starting;
    if (now() < nextStartAt) {
      throw failure('CLIPROXYAPI_START_FAILED', `The gateway failed ${consecutiveFailures} times; the next attempt waits until ${new Date(nextStartAt).toISOString()}`);
    }
    starting = (async () => {
      const document = await store.read();
      const baseURL = `http://127.0.0.1:${document.port}`;
      // Someone else already answers on this port: never spawn, never kill it.
      if (await createCliproxyapiClient({ baseURL, managementKey: '', fetchImpl }).reachable()) {
        throw failure('CLIPROXYAPI_PORT_IN_USE', `Port ${document.port} is already in use by another gateway`, 409);
      }

      const configPath = gatewayConfigPath(dataDir);
      await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
      const temporary = `${configPath}.${now()}.tmp`;
      await fs.writeFile(temporary, renderGatewayConfig(document), { mode: 0o600 });
      await fs.rename(temporary, configPath);

      const prepared = await binaryManager.prepare({ onProgress });
      await store.update((current) => ({ ...current, installedVersion: prepared.version, enabled: true }));

      lastError = null;
      expectedExit = false;
      const spawned = spawnProcess(prepared.path, ['-config', configPath], {
        cwd: path.dirname(prepared.path),
        env: gatewayChildEnv(buildEnv()),
        // An unread stdout pipe can block the gateway's shared logger and HTTP handlers.
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      child = spawned;
      let stderrTail = '';
      spawned.stderr?.on('data', (data) => {
        stderrTail = (stderrTail + String(data)).slice(-STDERR_TAIL_CHARS);
      });
      spawned.once('exit', () => {
        if (!expectedExit && stderrTail.trim() !== '') lastError = stderrTail.trim();
        onExit();
      });
      killOnParentExit();

      try {
        await waitForReady(baseURL);
      } catch (error) {
        lastError = stderrTail.trim() || lastError || null;
        consecutiveFailures += 1;
        nextStartAt = now() + Math.min(maxBackoffMs, 2 ** (consecutiveFailures - 1) * 1000);
        expectedExit = true;
        await terminateProcess(spawned).catch(() => undefined);
        throw error;
      }

      consecutiveFailures = 0;
      nextStartAt = 0;
      runningVersion = await (await client(document)).serverVersion().catch(() => null);
      return { running: true, version: runningVersion, source: prepared.source, path: prepared.path };
    })();
    try {
      return await starting;
    } finally {
      starting = null;
    }
  };

  const stop = async ({ persist = true } = {}) => {
    if (stopping !== null) return stopping;
    stopping = (async () => {
      if (persist) await store.update((current) => ({ ...current, enabled: false }));
      if (child !== null) {
        expectedExit = true;
        const target = child;
        await terminateProcess(target).catch(() => undefined);
        child = null;
        runningVersion = null;
      }
    })();
    try {
      await stopping;
    } finally {
      stopping = null;
    }
  };

  return {
    /** Starts only if the store says the gateway should be running. */
    async resume() {
      const document = await store.read();
      if (!document.enabled) return { running: false };
      return start();
    },
    async ensure() {
      if (child !== null) return { running: true };
      return start();
    },
    start,
    stop,
    async restart() {
      await stop({ persist: false });
      return start();
    },
    isRunning: () => child !== null,
    status: () => ({ running: child !== null, version: runningVersion, lastError }),
  };
};
