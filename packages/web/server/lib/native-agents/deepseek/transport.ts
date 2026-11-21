import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { Interface as ReadlineInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import WebSocket from 'ws';
import { z } from 'zod';

import type { JsonObject, JsonValue } from '../../shared/json-values.js';
import type { WebSocket as WebSocketInstance, WebSocketConstructor } from '../../shared/websocket-contracts.js';
import { isEnterpriseMode } from '../../enterprise-mode.js';
import { NativeAgentError, cliMissingError } from '../errors.js';
import { spawnCliProcess, terminateCliProcess } from '../process.js';
import type { SpawnCliProcessOptions } from '../process.js';
import { fileUploadResult, remoteEvent, rpcResponse, streamMessage } from './protocol.js';
import type { DeepseekFileReceipt, DeepseekRemoteEvent } from './protocol.js';
import { resolveDeepseekLaunch } from './launch.js';
import type { DeepseekMaintenance, DeepseekMaintenanceCompression, DeepseekMaintenanceSupport } from './maintenance.js';

const failure = (message: string, code = 'NATIVE_DEEPSEEK_UNAVAILABLE', status = 502): NativeAgentError => new NativeAgentError(message, { code, status });
const unknownPromptOutcome = (): NativeAgentError => failure('Could not confirm whether DeepSeek Harness accepted the message', 'NATIVE_PROMPT_OUTCOME_UNKNOWN');

type Deferred<Value> = {
  promise: Promise<Value>;
  resolve: (value: Value | PromiseLike<Value>) => void;
  reject: (cause?: unknown) => void;
};

const deferred = <Value>(): Deferred<Value> => {
  let resolve: (value: Value | PromiseLike<Value>) => void = () => {};
  let reject: (cause?: unknown) => void = () => {};
  const promise = new Promise<Value>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
};

type MaintenanceChannel = Readable & Writable;

const maintenanceChannelSchema = z.custom<MaintenanceChannel>((value) => (
  z.object({ write: z.function(), on: z.function() }).safeParse(value).success
));

const maintenanceFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('unsupported') }),
  z.object({ type: z.literal('ready'), root: z.string().refine(path.isAbsolute), compression: z.enum(['none', 'zstd']) }),
  z.object({
    type: z.literal('inspection'),
    id: z.string(),
    active: z.array(z.string()),
    sessions: z.array(z.object({ id: z.string(), parent: z.string().optional(), origin: z.string().optional() })),
  }),
  z.object({ type: z.literal('error'), id: z.string() }),
  z.object({ type: z.literal('configured'), id: z.string() }),
]);

export type DeepseekDelegationConfiguration = {
  child: boolean;
  env: {
    OPENCHAMBER_DELEGATION_URL: string;
    OPENCHAMBER_DELEGATION_TOKEN: string;
  };
};

export type DeepseekMaintenanceReadyConfig = DeepseekMaintenanceSupport & {
  root: string;
  compression: DeepseekMaintenanceCompression;
};

export type DeepseekMaintenanceInspectionSession = {
  id: string;
  parent?: string;
  origin?: string;
};

export type DeepseekMaintenanceInspection = DeepseekMaintenanceReadyConfig & {
  active: string[];
  sessions: DeepseekMaintenanceInspectionSession[];
};

export type DeepseekStreamHandle = {
  first: Promise<JsonValue>;
  done: Promise<void>;
  cancel: () => void;
};

export type DeepseekFetchInit = Omit<RequestInit, 'body'> & {
  body?: BodyInit | Readable | null | undefined;
  duplex?: 'half' | undefined;
};

export type DeepseekFetch = (input: string | URL, init?: DeepseekFetchInit) => Promise<Response>;

declare const fetch: DeepseekFetch;

export type DeepseekRemoteNotification = Exclude<DeepseekRemoteEvent, { type: 'ready' }>;

export interface DeepseekTransportOptions {
  resolveExecutable: () => Promise<string | null>;
  buildEnv: () => Record<string, string>;
  maintenance?: Pick<DeepseekMaintenance, 'prepare'> | null | undefined;
  onEvent?: ((event: DeepseekRemoteNotification) => void) | undefined;
  onDisconnect?: ((error: NativeAgentError) => Promise<void> | void) | undefined;
  resolveNodeExecutable?: (() => Promise<string | null>) | undefined;
  spawnProcess?: ((executable: string, args: string[], options: SpawnCliProcessOptions) => ChildProcess) | undefined;
  fetchImpl?: DeepseekFetch | undefined;
  WebSocketClass?: WebSocketConstructor | undefined;
  enterpriseMode?: (() => boolean) | undefined;
  startupTimeoutMs?: number | undefined;
  requestTimeoutMs?: number | undefined;
}

export interface DeepseekTransport {
  assertAllowed: () => void;
  supportsMaintenance: () => boolean;
  maintenanceState: () => boolean | null;
  configureDelegation: (sessionId: string, configuration: DeepseekDelegationConfiguration | null) => Promise<void>;
  inspectMaintenance: () => Promise<DeepseekMaintenanceInspection>;
  closeForMaintenance: () => Promise<void>;
  resumeAfterMaintenance: () => Promise<void>;
  request: <Output>(endpoint: string, args: JsonObject, schema: z.ZodType<Output>, signal?: AbortSignal) => Promise<Output>;
  uploadFile: (nativeId: string, filePath: string, name: string, signal?: AbortSignal) => Promise<DeepseekFileReceipt>;
  open: (endpoint: string, args: JsonObject, onItem: (value: JsonValue) => Promise<void> | void) => Promise<DeepseekStreamHandle>;
  answer: (eventId: string, outcome: JsonValue, signal?: AbortSignal) => Promise<JsonValue | undefined>;
  shutdown: () => Promise<void>;
}

type StreamState = {
  done: Deferred<void>;
  first: Deferred<JsonValue>;
  onItem: (value: JsonValue) => Promise<void> | void;
  chain: Promise<void>;
};

type TransportConnection = {
  ready: Deferred<TransportConnection>;
  streams: Map<string, StreamState>;
  connected: boolean;
  closed: Promise<void> | null;
  socket: WebSocketInstance;
  clientId: string;
};

type MaintenanceRequestResponse =
  | { configured: true }
  | { active: string[]; sessions: DeepseekMaintenanceInspectionSession[] };

type TransportContext = {
  child: ChildProcess;
  channel: MaintenanceChannel | null;
  ready: Deferred<TransportContext>;
  controller: AbortController;
  readers: ReadlineInterface[];
  connection: TransportConnection | null;
  connecting: Promise<TransportConnection> | null;
  closed: Promise<void> | null;
  authenticating: boolean;
  base: string;
  cookie: string;
  support: DeepseekMaintenanceSupport | null | undefined;
  maintenanceAvailable: boolean;
  maintenanceReady: Deferred<DeepseekMaintenanceReadyConfig | null>;
  maintenanceRequests: Map<string, Deferred<MaintenanceRequestResponse>>;
};

export const createDeepseekTransport = ({
  resolveExecutable,
  buildEnv,
  maintenance = null,
  onEvent = () => {},
  onDisconnect = () => {},
  resolveNodeExecutable = async () => (process.versions.electron ? null : process.execPath),
  spawnProcess = spawnCliProcess,
  fetchImpl = fetch,
  WebSocketClass = WebSocket,
  enterpriseMode = isEnterpriseMode,
  startupTimeoutMs = 30_000,
  requestTimeoutMs = 30_000,
}: DeepseekTransportOptions): DeepseekTransport => {
  let active: TransportContext | null = null;
  let starting: Promise<TransportContext> | null = null;
  let disposed = false;
  let paused = false;
  let closing: Promise<void> = Promise.resolve();

  const allowed = (): void => {
    if (enterpriseMode()) {
      const error = failure('DeepSeek Harness is unavailable in enterprise mode', 'enterprise_mode', 403);
      if (active) void closeContext(active, error);
      throw error;
    }
    if (disposed) throw failure('DeepSeek Harness is shutting down');
    if (paused) throw failure('DeepSeek Harness session maintenance is in progress. Retry shortly.', 'NATIVE_DEEPSEEK_MAINTENANCE_BUSY', 409);
  };

  const closeConnection = (context: TransportContext, connection: TransportConnection, error: NativeAgentError): Promise<void> => {
    if (connection.closed) return connection.closed;
    connection.closed = Promise.resolve().then(async () => {
      connection.ready.reject(error);
      for (const stream of connection.streams.values()) {
        stream.first.reject(error);
        stream.done.reject(error);
      }
      connection.streams.clear();
      connection.socket.terminate();
      if (connection.connected && context.connection === connection) await onDisconnect(error);
    });
    return connection.closed;
  };

  const closeContext = (context: TransportContext, error: NativeAgentError): Promise<void> => {
    if (context.closed) return context.closed;
    if (active === context) active = null;
    context.closed = Promise.resolve().then(async () => {
      context.controller.abort(error);
      context.ready.reject(error);
      for (const pending of context.maintenanceRequests.values()) pending.reject(error);
      context.maintenanceRequests.clear();
      context.maintenanceReady.reject(error);
      for (const reader of context.readers) reader.close();
      try {
        if (context.connection) await closeConnection(context, context.connection, error);
      } finally {
        await terminateCliProcess(context.child);
      }
    });
    closing = context.closed;
    return context.closed;
  };

  const sendFrame = (context: TransportContext, connection: TransportConnection, frame: JsonObject): void => {
    const error = failure('DeepSeek Harness connection failed');
    try {
      if (connection.closed || connection.socket.readyState !== WebSocket.OPEN) throw error;
      connection.socket.send(JSON.stringify(frame), (cause) => {
        if (cause) void closeConnection(context, connection, error);
      });
    } catch {
      void closeConnection(context, connection, error);
    }
  };

  const openIn = (
    context: TransportContext,
    connection: TransportConnection,
    endpoint: string,
    args: JsonObject,
    onItem: (value: JsonValue) => Promise<void> | void,
  ): DeepseekStreamHandle => {
    if (context.closed || connection.closed || connection.socket.readyState !== WebSocket.OPEN) {
      const error = failure('DeepSeek Harness connection closed');
      void closeConnection(context, connection, error);
      throw error;
    }
    const streamId = randomUUID();
    const done = deferred<void>();
    const first = deferred<JsonValue>();
    const stream: StreamState = { done, first, onItem, chain: Promise.resolve() };
    connection.streams.set(streamId, stream);
    const timer = setTimeout(() => {
      if (connection.closed) return;
      const error = failure('DeepSeek Harness stream opening timed out');
      void closeConnection(context, connection, error).then(() => {
        if (connection.connected && active === context && !context.closed) return connect(context);
        return undefined;
      }).catch(() => {});
    }, requestTimeoutMs);
    first.promise.finally(() => clearTimeout(timer)).catch(() => {});
    sendFrame(context, connection, { type: 'open', streamId, endpoint, payload: { args } });
    return {
      first: first.promise,
      done: done.promise,
      cancel: () => {
        connection.streams.delete(streamId);
        if (!connection.closed) sendFrame(context, connection, { type: 'cancel', streamId });
        first.reject(failure('DeepSeek Harness stream was closed'));
        done.resolve();
      },
    };
  };

  const requestIn = async <Output>(
    context: TransportContext,
    endpoint: string,
    args: JsonObject,
    schema: z.ZodType<Output>,
    signal?: AbortSignal,
  ): Promise<Output> => {
    allowed();
    const rpcId = randomUUID();
    const deadline = endpoint === 'session/prompt' ? [] : [AbortSignal.timeout(requestTimeoutMs)];
    let response: Response;
    try {
      response = await fetchImpl(`${context.base}/api/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: context.cookie, Origin: context.base },
        body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
        signal: AbortSignal.any([context.controller.signal, ...deadline, ...(signal ? [signal] : [])]),
      });
    } catch (error) {
      if (endpoint === 'session/prompt') throw unknownPromptOutcome();
      throw error;
    }
    if (endpoint === 'session/prompt' && response.status >= 500) throw unknownPromptOutcome();
    if (!response.ok) throw failure(`DeepSeek Harness request failed (${response.status})`);
    let envelope: z.infer<typeof rpcResponse>;
    try {
      envelope = rpcResponse.parse(await response.json());
    } catch {
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
        ? 'This session is open in another DeepSeek Harness process. Close it there before continuing.'
        : error.message;
      throw failure(message, code, error.code === 'session/writer-held' ? 409 : 502);
    }
    try {
      return schema.parse(envelope.result.value);
    } catch {
      if (endpoint === 'session/prompt') throw unknownPromptOutcome();
      throw failure('DeepSeek Harness returned an incompatible result', 'NATIVE_DEEPSEEK_PROTOCOL');
    }
  };

  const connect = async (context: TransportContext): Promise<TransportConnection> => {
    allowed();
    if (context.closed) throw failure('DeepSeek Harness exited');
    const previous = context.connection;
    if (previous?.connected && !previous.closed && previous.socket.readyState === WebSocket.OPEN) return previous;
    if (context.connecting) return context.connecting;
    const current = (async () => {
      if (previous) await closeConnection(context, previous, failure('DeepSeek Harness connection closed'));
      allowed();
      if (context.closed) throw failure('DeepSeek Harness exited');
      const socket = new WebSocketClass(`${context.base.replace('http:', 'ws:')}/api/remote.mux`, {
        headers: { Cookie: context.cookie, Origin: context.base },
      });
      const connection: TransportConnection = {
        ready: deferred<TransportConnection>(),
        streams: new Map(),
        connected: false,
        closed: null,
        socket,
        clientId: '',
      };
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
          const text = Array.isArray(bytes)
            ? Buffer.concat(bytes).toString('utf8')
            : bytes instanceof ArrayBuffer
              ? Buffer.from(bytes).toString('utf8')
              : bytes.toString();
          const frame = streamMessage.parse(JSON.parse(text));
          const stream = connection.streams.get(frame.streamId);
          if (!stream) return;
          if (frame.type === 'item') {
            stream.chain = stream.chain.then(() => {
              if (!connection.closed) return stream.onItem(frame.value);
              return undefined;
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
          } else {
            onEvent(event);
          }
        });
        events.done.then(
          () => { void closeConnection(context, connection, failure('DeepSeek Harness connection closed')); },
          (error) => { void closeConnection(context, connection, error instanceof NativeAgentError ? error : failure('DeepSeek Harness connection closed')); },
        );
      });
      return connection.ready.promise;
    })();
    context.connecting = current;
    try {
      return await current;
    } finally {
      if (context.connecting === current) context.connecting = null;
    }
  };

  const authenticate = async (context: TransportContext, url: string): Promise<void> => {
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

  const start = async (): Promise<TransportContext> => {
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
      const launch = await resolveDeepseekLaunch({
        executable,
        resolveNodeExecutable,
        args: ['--profile', 'web', ...(support ? ['--patch', support.overlay] : []), '--no-open', '--host', '127.0.0.1', '--port', '0'],
      });
      allowed();
      const env = { ...buildEnv() };
      const options: SpawnCliProcessOptions = { cwd: process.cwd(), env };
      if (support) {
        env.OPENCHAMBER_DSH_PACKAGE = support.packageFile;
        options.stdio = ['pipe', 'pipe', 'pipe', 'pipe'];
      }
      const child = spawnProcess(launch.executable, launch.args, options);
      const channel = support ? maintenanceChannelSchema.parse(child.stdio[3]) : null;
      const context: TransportContext = {
        child,
        channel,
        ready: deferred<TransportContext>(),
        controller: new AbortController(),
        readers: [],
        connection: null,
        connecting: null,
        closed: null,
        authenticating: false,
        base: '',
        cookie: '',
        support,
        maintenanceAvailable: false,
        maintenanceReady: deferred<DeepseekMaintenanceReadyConfig | null>(),
        maintenanceRequests: new Map(),
      };
      active = context;
      if (support && channel) {
        const reader = createInterface({ input: channel });
        context.readers.push(reader);
        reader.on('line', (line) => {
          try {
            if (line.length > 8 * 1024 * 1024) throw new Error('Oversized maintenance frame');
            const value = maintenanceFrameSchema.parse(JSON.parse(line));
            if (value.type === 'ready') {
              context.maintenanceAvailable = support.maintenance !== false;
              context.maintenanceReady.resolve({ ...support, root: value.root, compression: value.compression });
            } else if (value.type === 'unsupported') {
              context.maintenanceAvailable = false;
              context.maintenanceReady.resolve(null);
            } else {
              const pending = context.maintenanceRequests.get(value.id);
              context.maintenanceRequests.delete(value.id);
              if (value.type === 'error') pending?.reject(failure('Could not inspect DeepSeek Harness activity'));
              else if (value.type === 'configured') pending?.resolve({ configured: true });
              else {
                const sessions: DeepseekMaintenanceInspectionSession[] = value.sessions.map((item) => {
                  const session: DeepseekMaintenanceInspectionSession = { id: item.id };
                  if (item.parent !== undefined) session.parent = item.parent;
                  if (item.origin !== undefined) session.origin = item.origin;
                  return session;
                });
                pending?.resolve({ active: value.active, sessions });
              }
            }
          } catch {
            void closeContext(context, failure('Incompatible DeepSeek Harness maintenance protocol'));
          }
        });
      } else {
        context.maintenanceReady.resolve(null);
      }

      const timer = setTimeout(() => {
        void closeContext(context, failure('DeepSeek Harness startup timed out. Check dsh --profile web in a terminal.'));
      }, startupTimeoutMs);
      for (const output of [child.stdout, child.stderr]) {
        if (!output) continue;
        const reader = createInterface({ input: output });
        context.readers.push(reader);
        reader.on('line', (line) => {
          const match = /dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(line);
          if (match?.[1] && !context.closed) {
            void authenticate(context, match[1]).catch((error) => closeContext(
              context,
              error instanceof NativeAgentError ? error : failure(error instanceof Error ? error.message : 'DeepSeek Harness authentication failed'),
            ));
          }
        });
      }
      child.once('error', () => { void closeContext(context, failure('Could not start the installed dsh CLI')); });
      child.once('exit', () => { void closeContext(context, failure('DeepSeek Harness exited')); });
      try {
        return await context.ready.promise;
      } finally {
        clearTimeout(timer);
      }
    })();
    try {
      return await starting;
    } finally {
      starting = null;
    }
  };

  return {
    assertAllowed: allowed,
    supportsMaintenance: () => active?.maintenanceAvailable === true,
    maintenanceState: () => (active ? active.maintenanceAvailable === true : null),
    async configureDelegation(sessionId, configuration) {
      const context = await start();
      if (!context.support || !context.channel) {
        if (configuration) throw failure('This DeepSeek Harness version cannot configure cross-CLI subagents');
        return;
      }
      const id = randomUUID();
      const pending = deferred<MaintenanceRequestResponse>();
      context.maintenanceRequests.set(id, pending);
      const timer = setTimeout(() => pending.reject(failure('DeepSeek subagent configuration timed out')), requestTimeoutMs);
      try {
        context.channel.write(`${JSON.stringify({ type: 'configure-delegation', id, sessionId, configuration })}\n`);
        await pending.promise;
      } finally {
        clearTimeout(timer);
        context.maintenanceRequests.delete(id);
      }
    },
    async inspectMaintenance() {
      const context = await start();
      const config = await Promise.race([context.maintenanceReady.promise, new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(failure('DeepSeek maintenance startup timed out')), requestTimeoutMs);
        timer.unref?.();
        context.maintenanceReady.promise.finally(() => clearTimeout(timer)).catch(() => {});
      })]);
      if (!config || config.maintenance === false || !context.channel) {
        throw failure('This dsh installation does not support permanent deletion', 'NATIVE_DEEPSEEK_ACTION_UNSUPPORTED', 501);
      }
      const id = randomUUID();
      const pending = deferred<MaintenanceRequestResponse>();
      context.maintenanceRequests.set(id, pending);
      const timer = setTimeout(() => {
        context.maintenanceRequests.delete(id);
        pending.reject(failure('DeepSeek activity inspection timed out'));
      }, requestTimeoutMs);
      try {
        context.channel.write(`${JSON.stringify({ type: 'inspect', id })}\n`);
        const reply = await pending.promise;
        if (!('active' in reply)) throw failure('Could not inspect DeepSeek Harness activity');
        return { ...config, active: reply.active, sessions: reply.sessions };
      } finally {
        clearTimeout(timer);
      }
    },
    async closeForMaintenance() {
      allowed();
      paused = true;
      if (active) await closeContext(active, failure('DeepSeek Harness is restarting for session maintenance'));
    },
    async resumeAfterMaintenance() {
      paused = false;
      await start();
    },
    async request(endpoint, args, schema, signal) {
      return requestIn(await start(), endpoint, args, schema, signal);
    },
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
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream', Cookie: context.cookie, Origin: context.base },
          body,
          duplex: 'half',
          signal: cancellation,
        });
        if (!response.ok) throw failure(`DeepSeek Harness file upload failed (${response.status})`);
        const result = fileUploadResult.parse(await response.json());
        if (!result.ok) throw failure(result.error.message, 'NATIVE_BACKEND_ERROR');
        return result.value;
      } finally {
        body.destroy();
      }
    },
    async open(endpoint, args, onItem) {
      const context = await start();
      return openIn(context, await connect(context), endpoint, args, onItem);
    },
    async answer(eventId, outcome, signal) {
      const context = await start();
      const connection = await connect(context);
      return requestIn(context, '$events/result', { clientId: connection.clientId, eventId, outcome }, z.json().optional(), signal);
    },
    async shutdown() {
      disposed = true;
      if (active) await closeContext(active, failure('DeepSeek Harness is shutting down'));
      if (starting) await starting.catch(() => {});
    },
  };
};
