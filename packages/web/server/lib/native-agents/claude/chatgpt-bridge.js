import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { z } from 'zod';
import { NativeAgentError } from '../errors.js';
import { toResponsesRequest, readResponsesEvents, createAnthropicStream } from './responses-protocol.js';

const errorSchema = z.object({ error: z.object({ code: z.string().optional(), param: z.string().nullish() }).optional() });
const maxBody = 32 * 1024 * 1024;
const fail = (code, status = 502) => new NativeAgentError(code, { code, status });

/** Loopback-only, authenticated Messages endpoint. OAuth tokens never leave this module's upstream call. */
export const createChatgptBridge = ({ auth, fetchImpl = fetch, apiBase = 'https://api.openai.com/v1' }) => {
  const grants = new Map();
  const requests = new Map();
  let starting;
  let server;
  let origin;
  let closed = false;
  const handle = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('x-should-retry', 'false');
    let controller;
    try {
      if (req.headers.origin) throw fail('CHATGPT_BRIDGE_BROWSER_REQUEST', 403);
      const token = z.string().safeParse(req.headers['x-api-key']).data;
      const grant = grants.get(token);
      if (!grant || closed) throw fail('CHATGPT_BRIDGE_UNAUTHORIZED', 401);
      const url = new URL(req.url, origin);
      if (req.method !== 'POST' || url.pathname !== '/v1/messages') throw fail('CHATGPT_BRIDGE_UNSUPPORTED_ENDPOINT', 404);
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > maxBody) throw fail('CHATGPT_BRIDGE_BODY_TOO_LARGE', 413);
        chunks.push(chunk);
      }
      let raw;
      try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw fail('CHATGPT_INVALID_JSON', 400); }
      const translated = toResponsesRequest(raw, grant.model);
      controller = new AbortController();
      requests.set(controller, { accountId: grant.accountId, token });
      const disconnected = () => { if (!res.writableEnded) controller.abort(); };
      res.once('close', disconnected);
      try {
        const accessToken = await auth.accessToken(grant.accountId, controller.signal);
        controller.signal.throwIfAborted();
        if (!grants.has(token)) throw fail('CHATGPT_BRIDGE_UNAUTHORIZED', 401);
        const upstream = await fetchImpl(`${apiBase}/responses`, {
          method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(translated.body), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(300_000)]), redirect: 'error',
        });
        const requestId = upstream.headers.get('x-request-id');
        if (requestId) res.setHeader('x-request-id', requestId);
        if (!upstream.ok) {
          const payload = errorSchema.safeParse(await upstream.json().catch(() => null));
          const failure = fail(payload.data?.error?.code ?? 'CHATGPT_UPSTREAM_REJECTED', upstream.status);
          // Only diagnostic identifiers cross the bridge; upstream messages can echo credentials.
          throw failure;
        }
        if (!upstream.body) throw fail('CHATGPT_EMPTY_STREAM');
        const stream = createAnthropicStream({ model: grant.model, names: translated.names });
        if (translated.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' });
        }
        for await (const event of readResponsesEvents(upstream.body)) {
          const frames = stream.push(event);
          if (!translated.stream) continue;
          for (const frame of frames) {
            if (!res.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`)) await once(res, 'drain', { signal: controller.signal });
          }
        }
        const result = stream.result();
        if (!translated.stream) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } else res.end();
      } finally { res.off('close', disconnected); }
    } catch (failure) {
      if (res.destroyed || controller?.signal.aborted) { res.destroy(); return; }
      const code = failure instanceof NativeAgentError ? failure.code : 'CHATGPT_BRIDGE_FAILED';
      const message = failure instanceof NativeAgentError ? failure.message : code;
      const body = { type: 'error', error: { type: 'api_error', message } };
      if (res.headersSent) res.end(`event: error\ndata: ${JSON.stringify(body)}\n\n`);
      else res.writeHead(failure instanceof NativeAgentError ? failure.status : 502, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    } finally {
      if (controller) { controller.abort(); requests.delete(controller); }
    }
  };
  const start = () => {
    if (closed) return Promise.reject(fail('CHATGPT_BRIDGE_CLOSED', 503));
    starting ??= (async () => {
      server = http.createServer((req, res) => { void handle(req, res); });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const { port } = z.object({ port: z.number() }).parse(server.address());
      origin = `http://127.0.0.1:${port}`;
      return origin;
    })();
    return starting;
  };
  return {
    async acquire(accountId, model) {
      const baseURL = await start();
      if (closed) throw fail('CHATGPT_BRIDGE_CLOSED', 503);
      const token = randomBytes(32).toString('hex');
      grants.set(token, { accountId, model });
      return {
        baseURL, token,
        dispose() {
          grants.delete(token);
          for (const [controller, request] of requests) if (request.token === token) controller.abort();
        },
      };
    },
    revoke(accountId) {
      for (const [token, grant] of grants) if (grant.accountId === accountId) grants.delete(token);
      for (const [controller, request] of requests) if (request.accountId === accountId) controller.abort();
    },
    async shutdown() {
      closed = true;
      grants.clear();
      for (const controller of requests.keys()) controller.abort();
      if (starting) await starting.catch(() => {});
      if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    },
  };
};
