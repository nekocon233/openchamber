import http from 'node:http';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { z } from 'zod';
import { NativeAgentError } from '../errors.js';
import { createChatgptStore, chatgptModelSchema } from './chatgpt-store.js';

const ISSUER = 'https://auth.openai.com';
const API_BASE = 'https://api.openai.com/v1';
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const tokensSchema = z.object({
  access_token: z.string().min(1), refresh_token: z.string().min(1), id_token: z.string().min(1).optional(),
  token_type: z.literal('Bearer'), expires_in: z.number().positive(), scope: z.string(),
});
const discoverySchema = z.object({ issuer: z.string().url(), jwks_uri: z.string().url(), revocation_endpoint: z.string().url() });
const identitySchema = z.object({ sub: z.string().min(1), email: z.string().default(''), nonce: z.string().optional() });
const upstreamErrorSchema = z.object({ error: z.union([z.string(), z.object({ code: z.string().optional() })]).optional() });
const modelsSchema = z.object({ models: z.array(chatgptModelSchema) });
const terminalRefreshErrors = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);
const error = (code, status = 400) => new NativeAgentError(code, { code, status });
const equal = (left, right) => Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const hasPlan = (account) => account.credentials?.scopes.includes(PLAN_SCOPE) === true;
const publicAccount = (account) => ({
  id: account.id, kind: 'chatgpt-plan', label: `${account.email || 'ChatGPT'} · ${account.id.slice(0, 8)}`,
  status: account.credentials === null ? 'signed-out' : hasPlan(account) ? 'connected' : 'permission-required',
  welcomed: account.welcomed,
});

/** Owns SIWC registrations, callback listeners and token refresh. Never reads Codex credentials. */
export const createChatgptAuth = ({ dataDir, fetchImpl = fetch, issuer = ISSUER, apiBase = API_BASE, now = Date.now, attemptTimeoutMs = 300_000 }) => {
  const store = createChatgptStore({ dataDir });
  const attempts = new Map();
  const refreshing = new Map();
  const modelReads = new Map();
  const revoking = new Set();
  let discovery;
  let keys;
  let closed = false;
  let beginning = false;
  const request = (url, init = {}) => fetchImpl(url, { ...init, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(20_000) });
  const discover = async () => {
    if (discovery) return discovery;
    const response = await request(`${issuer}/.well-known/openid-configuration`);
    if (!response.ok) throw error('CHATGPT_AUTH_UNAVAILABLE', 503);
    const value = discoverySchema.parse(await response.json());
    if (value.issuer !== issuer || [value.jwks_uri, value.revocation_endpoint].some((url) => new URL(url).origin !== issuer)) throw error('CHATGPT_INVALID_DISCOVERY');
    discovery = value;
    keys = createRemoteJWKSet(new URL(value.jwks_uri), { [customFetch]: fetchImpl });
    return value;
  };
  const identityOf = async (token, clientId, nonce) => {
    await discover();
    const { payload } = await jwtVerify(token, keys, { issuer, audience: clientId, requiredClaims: ['exp', 'sub', 'iat'] });
    const identity = identitySchema.parse(payload);
    if (nonce !== undefined && (!identity.nonce || !equal(identity.nonce, nonce))) throw error('CHATGPT_INVALID_IDENTITY');
    return identity;
  };
  const exchange = async (body, signal) => {
    const response = await request(`${issuer}/api/accounts/oauth/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body), signal,
    });
    const json = await response.json();
    if (!response.ok) {
      const parsed = upstreamErrorSchema.safeParse(json).data?.error;
      const code = z.string().safeParse(parsed).data ?? z.object({ code: z.string() }).safeParse(parsed).data?.code;
      throw error(terminalRefreshErrors.has(code) ? 'CHATGPT_REAUTH_REQUIRED' : 'CHATGPT_AUTH_UNAVAILABLE', response.status === 401 ? 401 : 503);
    }
    return tokensSchema.parse(json);
  };
  const credentialsOf = (tokens, previous) => ({
    accessToken: tokens.access_token, refreshToken: tokens.refresh_token, idToken: tokens.id_token ?? previous.idToken,
    expiresAt: now() + tokens.expires_in * 1000, scopes: tokens.scope.split(/\s+/).filter(Boolean),
  });
  const account = async (id) => {
    const found = (await store.read()).accounts.find((entry) => entry.id === id);
    if (!found) throw error('CHATGPT_ACCOUNT_NOT_FOUND', 404);
    return found;
  };
  const accessToken = async (id, signal) => {
    if (closed || revoking.has(id)) throw error('CHATGPT_REAUTH_REQUIRED', 401);
    const current = await account(id);
    if (!hasPlan(current)) throw error(current.credentials ? 'CHATGPT_PERMISSION_REQUIRED' : 'CHATGPT_REAUTH_REQUIRED', 401);
    if (current.credentials.expiresAt > now() + 60_000) return current.credentials.accessToken;
    if (!refreshing.has(id)) {
      const operation = store.transaction(async (document) => {
        const saved = document.accounts.find((entry) => entry.id === id);
        if (closed || revoking.has(id) || !saved || !hasPlan(saved)) return { code: 'CHATGPT_REAUTH_REQUIRED' };
        if (saved.credentials.expiresAt > now() + 60_000) return { token: saved.credentials.accessToken };
        try {
          const tokens = await exchange({ grant_type: 'refresh_token', client_id: saved.clientId, refresh_token: saved.credentials.refreshToken, resource: apiBase });
          if (tokens.id_token) {
            const identity = await identityOf(tokens.id_token, saved.clientId);
            if (identity.sub !== saved.subject) throw error('CHATGPT_INVALID_IDENTITY');
          }
          saved.credentials = credentialsOf(tokens, saved.credentials);
          return hasPlan(saved) ? { token: saved.credentials.accessToken } : { code: 'CHATGPT_PERMISSION_REQUIRED' };
        } catch (failure) {
          if (failure instanceof NativeAgentError && failure.code === 'CHATGPT_REAUTH_REQUIRED') {
            saved.credentials = null;
            saved.revision += 1;
            return { code: failure.code };
          }
          throw failure;
        }
      });
      refreshing.set(id, operation);
      void operation.finally(() => refreshing.delete(id)).catch(() => {});
    }
    const result = await refreshing.get(id);
    signal?.throwIfAborted();
    if (result.code || closed || revoking.has(id)) throw error(result.code ?? 'CHATGPT_REAUTH_REQUIRED', 401);
    return result.token;
  };
  const finishAttempt = (attempt, status) => {
    if (attempt.status !== 'pending' && attempt.status !== 'exchanging') return;
    attempt.status = status;
    clearTimeout(attempt.timer);
    attempt.server.close();
    // A bounded window lets the UI observe terminal status without retaining secrets.
    attempt.verifier = '';
    attempt.nonce = '';
    attempt.state = '';
    attempt.expiry = setTimeout(() => attempts.delete(attempt.id), 60_000);
    attempt.expiry.unref?.();
  };
  return {
    accessToken,
    async accounts() { return (await store.read()).accounts.map(publicAccount); },
    async getAccount(id) { return publicAccount(await account(id)); },
    async models(id) {
      const before = await account(id);
      const key = `${id}:${before.revision}`;
      if (modelReads.has(key)) return modelReads.get(key);
      const operation = (async () => {
        const token = await accessToken(id);
        const response = await request(`${apiBase}/models`, { headers: { Authorization: `Bearer ${token}` } });
        if (!response.ok) throw error('CHATGPT_MODELS_UNAVAILABLE', 503);
        const models = modelsSchema.parse(await response.json()).models.filter((model) => model.visibility === 'list');
        await store.transaction((document) => {
          const current = document.accounts.find((entry) => entry.id === id);
          if (!current?.credentials || current.revision !== before.revision) throw error('CHATGPT_REAUTH_REQUIRED', 401);
          current.models = models;
        });
        return models;
      })();
      modelReads.set(key, operation);
      try { return await operation; }
      finally { if (modelReads.get(key) === operation) modelReads.delete(key); }
    },
    async cachedModels(id) { return (await account(id)).models; },
    async begin({ accountId = null, completionMessage = 'Return to OpenChamber.' } = {}) {
      if (closed) throw error('CHATGPT_AUTH_UNAVAILABLE', 503);
      if (beginning || [...attempts.values()].some((entry) => entry.status === 'pending' || entry.status === 'exchanging')) throw error('CHATGPT_AUTH_IN_PROGRESS', 409);
      beginning = true;
      try {
      const saved = accountId ? await account(accountId) : null;
      const hostId = await store.transaction((document) => { document.hostId ??= `urn:uuid:${randomUUID()}`; return document.hostId; });
      if (closed) throw error('CHATGPT_AUTH_UNAVAILABLE', 503);
      const attempt = {
        id: randomUUID(), status: 'pending', accountId, state: randomBytes(32).toString('base64url'),
        nonce: randomBytes(32).toString('base64url'), verifier: randomBytes(32).toString('base64url'),
        controller: new AbortController(), server: null, timer: null, expiry: null,
      };
      const server = http.createServer(async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Content-Security-Policy', "default-src 'none'");
        let url;
        try { url = new URL(req.url, 'http://127.0.0.1'); }
        catch { res.writeHead(400).end(); return; }
        if (req.method !== 'GET' || url.pathname !== '/auth/callback') { res.writeHead(404).end(); return; }
        if (attempt.status !== 'pending' || !equal(url.searchParams.get('state') ?? '', attempt.state)) { res.writeHead(400).end(); return; }
        attempt.status = 'exchanging';
        try {
          if (url.searchParams.get('error')) throw error('CHATGPT_AUTH_DECLINED');
          const code = url.searchParams.get('code');
          const clientId = url.searchParams.get('client_id') ?? saved?.clientId;
          if (!code || !clientId || clientId === 'dynamic_agent_client' || (saved && clientId !== saved.clientId)) throw error('CHATGPT_INVALID_CALLBACK');
          const tokens = await exchange({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: attempt.verifier, redirect_uri: redirectUri, resource: apiBase }, AbortSignal.any([attempt.controller.signal, AbortSignal.timeout(20_000)]));
          if (!tokens.id_token) throw error('CHATGPT_INVALID_IDENTITY');
          const identity = await identityOf(tokens.id_token, clientId, attempt.nonce);
          if (saved && identity.sub !== saved.subject) throw error('CHATGPT_INVALID_IDENTITY');
          attempt.controller.signal.throwIfAborted();
          const id = await store.transaction((document) => {
            attempt.controller.signal.throwIfAborted();
            let record = document.accounts.find((entry) => entry.clientId === clientId && entry.subject === identity.sub);
            if (saved && (!record || record.revision !== saved.revision)) throw error('CHATGPT_AUTH_SUPERSEDED');
            if (!record) {
              record = { id: randomUUID(), clientId, subject: identity.sub, email: identity.email, revision: 1, credentials: null, models: [], welcomed: false };
              document.accounts.push(record);
            } else record.revision += 1;
            record.email = identity.email;
            record.credentials = credentialsOf(tokens, { idToken: tokens.id_token });
            return record.id;
          });
          attempt.accountId = id;
          finishAttempt(attempt, tokens.scope.split(/\s+/).includes(PLAN_SCOPE) ? 'connected' : 'permission-required');
        } catch (failure) {
          finishAttempt(attempt, failure instanceof NativeAgentError && failure.code === 'CHATGPT_AUTH_DECLINED' ? 'cancelled' : 'failed');
        }
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(completionMessage);
      });
      attempt.server = server;
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      if (closed) { server.close(); throw error('CHATGPT_AUTH_UNAVAILABLE', 503); }
      const address = server.address();
      const parsedAddress = z.object({ port: z.number() }).parse(address);
      const redirectUri = `http://127.0.0.1:${parsedAddress.port}/auth/callback`;
      attempt.timer = setTimeout(() => { attempt.controller.abort(); finishAttempt(attempt, 'expired'); }, attemptTimeoutMs);
      attempt.timer.unref?.();
      attempts.set(attempt.id, attempt);
      const url = new URL(`${issuer}/api/accounts/authorize`);
      const params = {
        client_id: saved?.clientId ?? 'dynamic_agent_client', ext_agent_host_id: hostId,
        response_type: 'code', redirect_uri: redirectUri, scope: SCOPE, resource: apiBase,
        state: attempt.state, nonce: attempt.nonce, code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update(attempt.verifier).digest('base64url'),
      };
      if (!saved) params.agent_name_hint = 'OpenChamber';
      if (saved?.credentials && !hasPlan(saved)) params.prompt = 'consent';
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      // No ID-token hint crosses the browser API boundary.
      return { attemptId: attempt.id, url: url.href };
      } finally { beginning = false; }
    },
    status(id) {
      const attempt = attempts.get(id);
      if (!attempt) return { status: 'expired', accountId: null };
      return { status: attempt.status, accountId: attempt.accountId };
    },
    cancel(id) {
      const attempt = attempts.get(id);
      if (attempt?.status === 'pending') { attempt.controller.abort(); finishAttempt(attempt, 'cancelled'); }
      return { cancelled: attempt?.status === 'cancelled' };
    },
    async welcome(id) {
      await store.transaction((document) => {
        const record = document.accounts.find((entry) => entry.id === id);
        if (!record) throw error('CHATGPT_ACCOUNT_NOT_FOUND', 404);
        record.welcomed = true;
      });
      return { acknowledged: true };
    },
    async signOut(id) {
      revoking.add(id);
      try {
        return await store.transaction(async (document) => {
          const record = document.accounts.find((entry) => entry.id === id);
          if (!record) throw error('CHATGPT_ACCOUNT_NOT_FOUND', 404);
          let revoked = record.credentials === null;
          if (record.credentials) {
            try {
              const configuration = await discover();
              const response = await request(configuration.revocation_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: record.credentials.refreshToken, token_type_hint: 'refresh_token', client_id: record.clientId }) });
              revoked = response.status === 200;
            } catch { /* Local sign-out still completes; the UI reports unconfirmed revocation. */ }
          }
          record.credentials = null;
          record.revision += 1;
          return { signedOut: true, revoked };
        });
      } finally { revoking.delete(id); }
    },
    async revision(id) { return (await account(id)).revision; },
    async shutdown() {
      closed = true;
      for (const attempt of attempts.values()) {
        attempt.controller.abort(); clearTimeout(attempt.timer); clearTimeout(attempt.expiry);
        attempt.server.closeAllConnections(); attempt.server.close();
      }
      attempts.clear();
      await Promise.allSettled([...modelReads.values()]);
      await store.drain();
    },
  };
};
