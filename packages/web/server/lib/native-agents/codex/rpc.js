// Line-delimited JSON-RPC over a child process's stdio, as `codex app-server
// --listen stdio://` speaks it. Three message kinds arrive on stdout:
// responses to our requests (id, result|error), notifications (method, no id)
// and requests from the server (method and id), which must be answered.

import { z } from 'zod';

const MAX_BUFFERED_BYTES = 32 * 1024 * 1024;

const envelopeSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).passthrough().optional(),
}).passthrough();

export class JsonRpcError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'JsonRpcError';
    this.code = code;
  }
}

/**
 * @param {object} options
 * @param {{ stdin: import('node:stream').Writable, stdout: import('node:stream').Readable }} options.child
 * @param {(method: string, params: Record<string, unknown>) => void} options.onNotification
 * @param {(method: string, params: Record<string, unknown>) => Promise<unknown>} options.onRequest
 *   Answers a server request; a rejection is sent back as a JSON-RPC error.
 * @param {(error: Error) => void} options.onClose fired once, when the stream ends or breaks
 * @param {number} [options.requestTimeoutMs]
 */
export const createJsonRpcConnection = ({ child, onNotification, onRequest, onClose, requestTimeoutMs = 60_000 }) => {
  const pending = new Map();
  let nextId = 0;
  let buffer = '';
  let closed = false;

  const close = (error) => {
    if (closed) return;
    closed = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
    onClose(error);
  };

  const send = (message) => {
    if (closed) throw new JsonRpcError('Codex app-server connection is closed', -32000);
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const answer = (id, method, params) => {
    onRequest(method, params).then(
      (result) => {
        if (!closed) send({ id, result: result ?? {} });
      },
      (error) => {
        if (!closed) send({ id, error: { code: -32000, message: error instanceof Error ? error.message : 'Request declined' } });
      },
    );
  };

  const receiveLine = (line) => {
    let parsed;
    try {
      parsed = envelopeSchema.parse(JSON.parse(line));
    } catch (error) {
      close(new JsonRpcError(`Invalid Codex app-server message: ${error instanceof Error ? error.message : error}`, -32700));
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
  child.stdout.on('data', (text) => {
    buffer += text;
    if (buffer.length > MAX_BUFFERED_BYTES) {
      close(new JsonRpcError('Codex app-server message exceeds the size limit', -32700));
      return;
    }
    let end;
    while (!closed && (end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (line) receiveLine(line);
    }
  });
  child.stdout.on('end', () => close(new JsonRpcError('Codex app-server closed its output', -32000)));
  child.stdout.on('error', (error) => close(error));
  child.stdin.on('error', (error) => close(error));

  return {
    /**
     * @param {string} method
     * @param {Record<string, unknown>} [params]
     */
    request(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new JsonRpcError(`Codex app-server request timed out: ${method}`, -32001));
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

    notify(method, params) {
      send(params === undefined ? { method } : { method, params });
    },

    close,

    isClosed() {
      return closed;
    },
  };
};
