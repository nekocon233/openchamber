// The DSH listener and its owner cookie never cross OpenChamber's server boundary.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import WebSocket from 'ws';
import { z } from 'zod';

import { isEnterpriseMode } from '../../enterprise-mode.js';
import { NativeAgentError, cliMissingError } from '../errors.js';
import { spawnCliProcess, terminateCliProcess } from '../process.js';
import { fileUploadResult, remoteEvent, rpcResponse, streamMessage } from './protocol.js';
import { resolveDeepseekLaunch } from './launch.js';

const failure = (message, code = 'NATIVE_DEEPSEEK_UNAVAILABLE', status = 502) => new NativeAgentError(message, { code, status });
const unknownPromptOutcome = () => failure('Could not confirm whether DeepSeek Harness accepted the message', 'NATIVE_PROMPT_OUTCOME_UNKNOWN');
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // Stream termination can precede the caller receiving its handle.
  promise.catch(() => {});
  return { promise, resolve, reject };
};

export const createDeepseekTransport = ({
  resolveExecutable, buildEnv, maintenance = null, onEvent = () => {}, onDisconnect = () => {},
  resolveNodeExecutable = async () => process.versions.electron ? null : process.execPath,
  spawnProcess = spawnCliProcess, fetchImpl = fetch, WebSocketClass = WebSocket,
  enterpriseMode = isEnterpriseMode, startupTimeoutMs = 30_000, requestTimeoutMs = 30_000,
}) => {
  let active = null;
  let starting = null;
  let disposed = false;
  let paused = false;
  let closing = Promise.resolve();

  const allowed = () => {
    if (enterpriseMode()) {
      const error = failure('DeepSeek Harness is unavailable in enterprise mode', 'enterprise_mode', 403);
      if (active) void closeContext(active, error);
      throw error;
    }
    if (disposed) throw failure('DeepSeek Harness is shutting down');
    if (paused) throw failure('DeepSeek Harness session maintenance is in progress. Retry shortly.', 'NATIVE_DEEPSEEK_MAINTENANCE_BUSY', 409);
  };

  const closeConnection = (context, connection, error) => {
    if (connection.closed) return connection.closed;
    // Mark this generation closed before terminate can synchronously emit close.
    connection.closed = Promise.resolve().then(async () => {
      connection.ready.reject(error);
      for (const stream of connection.streams.values()) { stream.first.reject(error); stream.done.reject(error); }
      connection.streams.clear();
      connection.socket.terminate();
      if (connection.connected && context.connection === connection) await onDisconnect(error);
    });
    return connection.closed;
  };

  const closeContext = (context, error) => {
    if (context.closed) return context.closed;
    if (active === context) active = null;
    context.closed = Promise.resolve().then(async () => {
      context.controller.abort(error);
      context.ready.reject(error);
      for (const pending of context.maintenanceRequests.values()) pending.reject(error);
      context.maintenanceRequests.clear();
      context.maintenanceReady.reject(error);
      for (const reader of context.readers) reader.close();
      try { if (context.connection) await closeConnection(context, context.connection, error); }
      finally { await terminateCliProcess(context.child); }
    });
    closing = context.closed;
    return context.closed;
  };

  const sendFrame = (context, connection, frame) => {
    const error = failure('DeepSeek Harness connection failed');
    try {
      if (connection.closed || connection.socket.readyState !== WebSocket.OPEN) throw error;
      connection.socket.send(JSON.stringify(frame), (cause) => {
        if (cause) void closeConnection(context, connection, error);
      });
    } catch { void closeConnection(context, connection, error); }
  };

  const openIn = (context, connection, endpoint, args, onItem) => {
    if (context.closed || connection.closed || connection.socket.readyState !== WebSocket.OPEN) {
      const error = failure('DeepSeek Harness connection closed');
      void closeConnection(context, connection, error);
      throw error;
    }
    const streamId = randomUUID();
    const done = deferred();
    const first = deferred();
    const stream = { done, first, onItem, chain: Promise.resolve() };
    connection.streams.set(streamId, stream);
    const timer = setTimeout(() => {
      if (connection.closed) return;
      const error = failure('DeepSeek Harness stream opening timed out');
      // A quiet physical connection can still report OPEN. Retire all of its
      // streams and try one fresh carrier, keeping HTTP admission and DSH alive.
      void closeConnection(context, connection, error).then(() => {
        if (connection.connected && active === context && !context.closed) return connect(context);
      }).catch(() => {});
    }, requestTimeoutMs);
    first.promise.finally(() => clearTimeout(timer)).catch(() => {});
    sendFrame(context, connection, { type: 'open', streamId, endpoint, payload: { args } });
    return {
      first: first.promise, done: done.promise,
      cancel: () => {
        connection.streams.delete(streamId);
        if (!connection.closed) sendFrame(context, connection, { type: 'cancel', streamId });
        first.reject(failure('DeepSeek Harness stream was closed'));
        done.resolve();
      },
    };
  };

  const requestIn = async (context, endpoint, args, schema, signal) => {
    allowed();
    const rpcId = randomUUID();
    // Prompt admission may already be durable when its response is lost.
    // Its request id, not a transport retry, resolves that uncertainty.
    const deadline = endpoint === 'session/prompt' ? [] : [AbortSignal.timeout(requestTimeoutMs)];
    let response;
    try {
      response = await fetchImpl(`${context.base}/api/${endpoint}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: context.cookie, Origin: context.base },
        body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
        signal: AbortSignal.any([context.controller.signal, ...deadline, ...(signal ? [signal] : [])]),
      });
    } catch (error) {
      if (endpoint === 'session/prompt') throw unknownPromptOutcome();
      throw error;
    }
    if (endpoint === 'session/prompt' && response.status >= 500) throw unknownPromptOutcome();
    if (!response.ok) throw failure(`DeepSeek Harness request failed (${response.status})`);
    let envelope;
    try { envelope = rpcResponse.parse(await response.json()); }
    catch {
      if (endpoint === 'session/prompt') throw unknownPromptOutcome();
      throw failure('DeepSeek Harness returned an incompatible RPC response', 'NATIVE_DEEPSEEK_PROTOCOL');
    }
    if (envelope.rpcId !== rpcId) {
      if (endpoint === 'session/prompt') throw unknownPromptOutcome();
      throw failure('DeepSeek Harness returned an unrelated response');
    }
    if (!envelope.result.ok) {
      const error = envelope.result.error;
      if (endpoint === 'session/prompt' && error.code === 'gateway/internal') throw unknownPromptOutcome();
      if (error.code === 'settings/conflict') throw failure('DeepSeek settings changed. Reload them before saving.', 'NATIVE_DEEPSEEK_SETTINGS_CONFLICT', 409);
      const code = error.code === 'session/writer-held' ? 'NATIVE_DEEPSEEK_WRITER_HELD' : 'NATIVE_BACKEND_ERROR';
      const message = error.code === 'session/writer-held'
        ? 'This session is open in another DeepSeek Harness process. Close it there before continuing.' : error.message;
      throw failure(message, code, error.code === 'session/writer-held' ? 409 : 502);
    }
    try { return schema.parse(envelope.result.value); }
    catch {
      if (endpoint === 'session/prompt') throw unknownPromptOutcome();
      throw failure('DeepSeek Harness returned an incompatible result', 'NATIVE_DEEPSEEK_PROTOCOL');
    }
  };

  const connect = async (context) => {
    allowed();
    if (context.closed) throw failure('DeepSeek Harness exited');
    const previous = context.connection;
    if (previous?.connected && !previous.closed && previous.socket.readyState === WebSocket.OPEN) return previous;
    if (context.connecting) return context.connecting;
    const current = (async () => {
      if (previous) await closeConnection(context, previous, failure('DeepSeek Harness connection closed'));
      allowed();
      if (context.closed) throw failure('DeepSeek Harness exited');
      const connection = { ready: deferred(), streams: new Map(), connected: false, closed: null };
      const socket = new WebSocketClass(`${context.base.replace('http:', 'ws:')}/api/remote.mux`, {
        headers: { Cookie: context.cookie, Origin: context.base },
      });
      connection.socket = socket;
      context.connection = connection;
      const timer = setTimeout(() => {
        void closeConnection(context, connection, failure('DeepSeek Harness connection timed out'));
      }, requestTimeoutMs);
      connection.ready.promise.finally(() => clearTimeout(timer)).catch(() => {});
      socket.on('error', () => { void closeConnection(context, connection, failure('DeepSeek Harness connection failed')); });
      socket.on('close', () => { void closeConnection(context, connection, failure('DeepSeek Harness connection closed')); });
      socket.on('message', (bytes) => {
        if (connection.closed) return;
        try {
          const frame = streamMessage.parse(JSON.parse(bytes.toString()));
          const stream = connection.streams.get(frame.streamId);
          if (!stream) return;
          if (frame.type === 'item') {
            stream.chain = stream.chain.then(() => {
              if (!connection.closed) return stream.onItem(frame.value);
            }).then(() => stream.first.resolve(frame.value));
            stream.chain.catch((cause) => {
              const error = cause instanceof z.ZodError ? failure('DeepSeek Harness returned an incompatible session event', 'NATIVE_DEEPSEEK_PROTOCOL') : cause;
              stream.first.reject(error);
              stream.done.reject(error);
              connection.streams.delete(frame.streamId);
            });
          } else {
            connection.streams.delete(frame.streamId);
            stream.chain.then(() => {
              if (frame.type === 'error') {
                const error = failure(frame.error.message);
                stream.first.reject(error);
                stream.done.reject(error);
              } else {
                stream.first.reject(failure('DeepSeek Harness stream ended before its opening'));
                stream.done.resolve();
              }
            }).catch(stream.done.reject);
          }
        } catch {
          void closeConnection(context, connection, failure('DeepSeek Harness returned an incompatible stream'));
        }
      });
      socket.once('open', () => {
        if (connection.closed) return;
        const events = openIn(context, connection, '$events', {}, (raw) => {
          const event = remoteEvent.parse(raw);
          if (event.type === 'ready') {
            connection.clientId = event.clientId;
            connection.connected = true;
            connection.ready.resolve(connection);
          } else onEvent(event);
        });
        events.done.then(
          () => { void closeConnection(context, connection, failure('DeepSeek Harness connection closed')); },
          (error) => { void closeConnection(context, connection, error); },
        );
      });
      return connection.ready.promise;
    })();
    context.connecting = current;
    try { return await current; }
    finally { if (context.connecting === current) context.connecting = null; }
  };

  const authenticate = async (context, url) => {
    if (context.authenticating) return;
    context.authenticating = true;
    const address = new URL(url);
    if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1' || address.pathname !== '/' || !address.searchParams.get('token')) {
      throw failure('DeepSeek Harness must announce its owned loopback listener');
    }
    context.base = address.origin;
    const response = await fetchImpl(address, { redirect: 'manual', signal: context.controller.signal });
    const cookies = response.headers.getSetCookie();
    if (response.status !== 303 || cookies.length === 0) throw failure('DeepSeek Harness authentication failed');
    context.cookie = cookies.map((cookie) => cookie.split(';', 1)[0]).join('; ');
    await connect(context);
    context.ready.resolve(context);
  };

  const start = async () => {
    allowed();
    if (active && !active.closed) {
      const context = await active.ready.promise;
      await connect(context);
      return context;
    }
    if (starting) return starting;
    starting = (async () => {
      await closing;
      const executable = await resolveExecutable();
      if (!executable) throw cliMissingError('dsh');
      allowed();
      const support = await maintenance?.prepare(executable);
      const launch = await resolveDeepseekLaunch({ executable, resolveNodeExecutable,
        args: ['--profile', 'web', ...(support ? ['--patch', support.overlay] : []), '--no-open', '--host', '127.0.0.1', '--port', '0'],
      });
      allowed();
      const env = { ...buildEnv() };
      const options = { cwd: process.cwd(), env };
      if (support) {
        env.OPENCHAMBER_DSH_PACKAGE = support.packageFile;
        options.stdio = ['pipe', 'pipe', 'pipe', 'pipe'];
      }
      const child = spawnProcess(launch.executable, launch.args, options);
      const context = { child, ready: deferred(), controller: new AbortController(), readers: [], connection: null, connecting: null, support, maintenanceReady: deferred(), maintenanceRequests: new Map() };
      active = context;
      if (support) {
        const reader = createInterface({ input: child.stdio[3] });
        context.readers.push(reader);
        const frame = z.discriminatedUnion('type', [
          z.object({ type: z.literal('unsupported') }),
          z.object({ type: z.literal('ready'), root: z.string().refine(path.isAbsolute), compression: z.enum(['none', 'zstd']) }),
          z.object({ type: z.literal('inspection'), id: z.string(), active: z.array(z.string()), sessions: z.array(z.object({ id: z.string(), parent: z.string().optional(), origin: z.string().optional() })) }),
          z.object({ type: z.literal('error'), id: z.string() }),
        ]);
        reader.on('line', (line) => {
          try {
            if (line.length > 8 * 1024 * 1024) throw new Error('Oversized maintenance frame');
            const value = frame.parse(JSON.parse(line));
            if (value.type === 'ready') {
              context.maintenanceAvailable = true;
              context.maintenanceReady.resolve({ ...support, root: value.root, compression: value.compression });
            } else if (value.type === 'unsupported') {
              context.maintenanceAvailable = false;
              context.maintenanceReady.resolve(null);
            } else {
              const pending = context.maintenanceRequests.get(value.id);
              context.maintenanceRequests.delete(value.id);
              if (value.type === 'error') pending?.reject(failure('Could not inspect DeepSeek Harness activity'));
              else pending?.resolve({ active: value.active, sessions: value.sessions });
            }
          } catch { void closeContext(context, failure('Incompatible DeepSeek Harness maintenance protocol')); }
        });
      } else context.maintenanceReady.resolve(null);

      const timer = setTimeout(() => {
        void closeContext(context, failure('DeepSeek Harness startup timed out. Check dsh --profile web in a terminal.'));
      }, startupTimeoutMs);
      for (const output of [child.stdout, child.stderr]) {
        const reader = createInterface({ input: output });
        context.readers.push(reader);
        reader.on('line', (line) => {
          // All other child output is discarded: either stream may contain credentials.
          const match = /dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(line);
          if (match && !context.closed) void authenticate(context, match[1]).catch((error) => closeContext(context, error));
        });
      }
      child.once('error', () => { void closeContext(context, failure('Could not start the installed dsh CLI')); });
      child.once('exit', () => { void closeContext(context, failure('DeepSeek Harness exited')); });
      try { return await context.ready.promise; }
      finally { clearTimeout(timer); }
    })();
    try { return await starting; }
    finally { starting = null; }
  };

  return {
    assertAllowed: allowed,
    supportsMaintenance: () => active?.maintenanceAvailable === true,
    async inspectMaintenance() {
      const context = await start();
      const config = await Promise.race([context.maintenanceReady.promise, new Promise((_, reject) => {
        const timer = setTimeout(() => reject(failure('DeepSeek maintenance startup timed out')), requestTimeoutMs);
        timer.unref?.();
        context.maintenanceReady.promise.finally(() => clearTimeout(timer)).catch(() => {});
      })]);
      if (!config) throw failure('This dsh installation does not support permanent deletion', 'NATIVE_DEEPSEEK_ACTION_UNSUPPORTED', 501);
      const id = randomUUID();
      const pending = deferred();
      context.maintenanceRequests.set(id, pending);
      const timer = setTimeout(() => { context.maintenanceRequests.delete(id); pending.reject(failure('DeepSeek activity inspection timed out')); }, requestTimeoutMs);
      try {
        context.child.stdio[3].write(`${JSON.stringify({ type: 'inspect', id })}\n`);
        return { ...config, ...await pending.promise };
      } finally { clearTimeout(timer); }
    },
    async closeForMaintenance() {
      allowed();
      paused = true;
      if (active) await closeContext(active, failure('DeepSeek Harness is restarting for session maintenance'));
    },
    async resumeAfterMaintenance() { paused = false; return start(); },
    async request(endpoint, args, schema, signal) { return requestIn(await start(), endpoint, args, schema, signal); },
    async uploadFile(nativeId, filePath, name, signal) {
      const context = await start();
      const cancellation = AbortSignal.any([context.controller.signal, AbortSignal.timeout(requestTimeoutMs), ...(signal ? [signal] : [])]);
      cancellation.throwIfAborted();
      const url = new URL('/api/session/uploadFileBinary', context.base);
      url.searchParams.set('sessionId', nativeId);
      url.searchParams.set('name', name);
      const body = createReadStream(filePath, { signal: cancellation });
      try {
        const response = await fetchImpl(url, {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Cookie: context.cookie, Origin: context.base },
          body, duplex: 'half', signal: cancellation,
        });
        if (!response.ok) throw failure(`DeepSeek Harness file upload failed (${response.status})`);
        const result = fileUploadResult.parse(await response.json());
        if (!result.ok) throw failure(result.error.message, 'NATIVE_BACKEND_ERROR');
        return result.value;
      } finally { body.destroy(); }
    },
    async open(endpoint, args, onItem) {
      const context = await start();
      return openIn(context, await connect(context), endpoint, args, onItem);
    },
    async answer(eventId, outcome, signal) {
      const context = await start();
      const connection = await connect(context);
      return requestIn(context, '$events/result', { clientId: connection.clientId, eventId, outcome },
        // The published endpoint acknowledges an accepted event result.
        z.json().optional(), signal);
    },
    async shutdown() {
      disposed = true;
      if (active) await closeContext(active, failure('DeepSeek Harness is shutting down'));
      if (starting) await starting.catch(() => {});
    },
  };
};
