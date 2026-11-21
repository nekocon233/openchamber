import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';

import type { JsonObject, JsonValue } from '../../shared/json-values.js';

const MAX_BUFFERED_BYTES = 32 * 1024 * 1024;

const jsonValueSchema = z.custom<JsonValue>(() => true);

const envelopeSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.record(z.string(), jsonValueSchema).optional(),
  result: jsonValueSchema.optional(),
  error: z.object({ code: z.number(), message: z.string() }).passthrough().optional(),
}).passthrough();

export type JsonRpcErrorKind = 'response' | 'transport' | 'timeout';
export type JsonRpcResult = JsonValue | undefined;
export type JsonRpcRequest = (method: string, params?: JsonObject) => Promise<JsonRpcResult>;

export interface JsonRpcChildStreams {
  stdin: Writable;
  stdout: Readable;
}

export interface JsonRpcConnectionOptions {
  child: JsonRpcChildStreams;
  onNotification: (method: string, params: JsonObject) => void;
  onRequest: (method: string, params: JsonObject) => Promise<JsonRpcResult>;
  onClose: (error: Error) => void;
  requestTimeoutMs?: number | undefined;
}

interface PendingRequest {
  resolve: (value: JsonRpcResult) => void;
  reject: (cause: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class JsonRpcError extends Error {
  readonly code: number;
  readonly kind: JsonRpcErrorKind;

  constructor(message: string, code: number, kind: JsonRpcErrorKind = 'response') {
    super(message);
    this.name = 'JsonRpcError';
    this.code = code;
    this.kind = kind;
  }
}

export const createJsonRpcConnection = ({
  child,
  onNotification,
  onRequest,
  onClose,
  requestTimeoutMs = 60_000,
}: JsonRpcConnectionOptions) => {
  const pending = new Map<string | number, PendingRequest>();
  let nextId = 0;
  let buffer = '';
  let closed = false;

  const close = (error: Error) => {
    if (closed) return;
    closed = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
    onClose(error);
  };

  const send = (message: JsonObject) => {
    if (closed) throw new JsonRpcError('Codex app-server connection is closed', -32000, 'transport');
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const answer = (id: string | number, method: string, params: JsonObject) => {
    onRequest(method, params).then(
      (result) => {
        if (!closed) send({ id, result: result ?? {} });
      },
      (error) => {
        if (!closed) send({ id, error: { code: -32000, message: error instanceof Error ? error.message : 'Request declined' } });
      },
    );
  };

  const receiveLine = (line: string) => {
    let parsed: z.infer<typeof envelopeSchema>;
    try {
      parsed = envelopeSchema.parse(JSON.parse(line));
    } catch (error) {
      close(new JsonRpcError(`Invalid Codex app-server message: ${error instanceof Error ? error.message : String(error)}`, -32700, 'transport'));
      return;
    }
    if (parsed.method !== undefined && parsed.id !== undefined) {
      answer(parsed.id, parsed.method, parsed.params ?? {});
      return;
    }
    if (parsed.method !== undefined) {
      onNotification(parsed.method, parsed.params ?? {});
      return;
    }
    if (parsed.id === undefined) return;
    const entry = pending.get(parsed.id);
    if (!entry) return;
    pending.delete(parsed.id);
    clearTimeout(entry.timer);
    if (parsed.error) entry.reject(new JsonRpcError(parsed.error.message, parsed.error.code));
    else entry.resolve(parsed.result);
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string | Buffer) => {
    buffer += String(chunk);
    if (buffer.length > MAX_BUFFERED_BYTES) {
      close(new JsonRpcError('Codex app-server message exceeds the size limit', -32700, 'transport'));
      return;
    }
    while (!closed) {
      const end = buffer.indexOf('\n');
      if (end < 0) break;
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (line) receiveLine(line);
    }
  });
  child.stdout.on('end', () => close(new JsonRpcError('Codex app-server closed its output', -32000, 'transport')));
  child.stdout.on('error', (error: Error) => close(error));
  child.stdin.on('error', (error: Error) => close(error));

  return {
    request(method: string, params: JsonObject = {}): Promise<JsonRpcResult> {
      const id = ++nextId;
      return new Promise<JsonRpcResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new JsonRpcError(`Codex app-server request timed out: ${method}`, -32001, 'timeout'));
        }, requestTimeoutMs);
        timer.unref?.();
        pending.set(id, { resolve, reject, timer });
        try {
          send({ id, method, params });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    },

    notify(method: string, params?: JsonObject) {
      send(params === undefined ? { method } : { method, params });
    },

    close,

    isClosed() {
      return closed;
    },
  };
};

export type JsonRpcConnection = ReturnType<typeof createJsonRpcConnection>;
