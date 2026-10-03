import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { createChatgptAuth } from './chatgpt-auth.js';
import { createChatgptStore } from './chatgpt-store.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const fixture = async (options = {}) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-chatgpt-auth-test-'));
  cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey); jwk.kid = 'fixture';
  const state = { nonce: '', invalidNonce: false, invalidAudience: false, subject: 'fixture-user', scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct', tokenError: null, revoked: 0, refreshes: 0, time: Date.now(), requests: [], refreshDelay: 0, revocationStatus: 200 };
  let issuer;
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/.well-known/openid-configuration') { res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks`, revocation_endpoint: `${issuer}/revoke` })); return; }
    if (req.url === '/jwks') { res.end(JSON.stringify({ keys: [jwk] })); return; }
    if (req.url === '/revoke') { state.revoked++; res.writeHead(state.revocationStatus).end(); return; }
    if (req.url === '/v1/models') { res.end(JSON.stringify({ models: [{ slug: 'gpt-fixture', display_name: 'GPT fixture', visibility: 'list' }, { slug: 'hidden', display_name: 'Hidden', visibility: 'hidden' }] })); return; }
    if (req.url !== '/api/accounts/oauth/token') { res.writeHead(404).end('{}'); return; }
    const params = new URLSearchParams(body); state.requests.push(params);
    const refresh = params.get('grant_type') === 'refresh_token';
    if (refresh) { state.refreshes++; await new Promise((resolve) => setTimeout(resolve, state.refreshDelay)); }
    if (state.tokenError) { res.writeHead(400).end(JSON.stringify({ error: state.tokenError })); return; }
    const idToken = await new SignJWT({ sub: state.subject, email: 'fixture@example.test', nonce: state.invalidNonce ? 'incorrect-nonce' : state.nonce }).setProtectedHeader({ alg: 'RS256', kid: 'fixture' }).setIssuedAt().setIssuer(issuer).setAudience(state.invalidAudience ? 'incorrect-client' : params.get('client_id')).setExpirationTime('1h').sign(privateKey);
    res.end(JSON.stringify({ access_token: `fake-access-${state.refreshes}`, refresh_token: `fake-refresh-${state.refreshes}`, id_token: idToken, token_type: 'Bearer', expires_in: 3600, scope: state.scope }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${server.address().port}`;
  cleanups.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const create = () => {
    const auth = createChatgptAuth({ dataDir, issuer, apiBase: `${issuer}/v1`, now: () => state.time, ...options });
    cleanups.push(() => auth.shutdown());
    return auth;
  };
  const auth = create();
  const finish = async (attempt, { wrongState = false, clientId = 'fixture-client' } = {}) => {
    const url = new URL(attempt.url);
    state.nonce = url.searchParams.get('nonce');
    const callback = new URL(url.searchParams.get('redirect_uri'));
    callback.searchParams.set('state', wrongState ? 'incorrect' : url.searchParams.get('state'));
    callback.searchParams.set('code', 'fixture-code'); callback.searchParams.set('client_id', clientId);
    return fetch(callback);
  };
  const login = async () => { const attempt = await auth.begin(); await finish(attempt); return auth.status(attempt.attemptId).accountId; };
  return { auth, state, dataDir, create, finish, login };
};

describe('ChatGPT authorization', () => {
  it('verifies OAuth identity, persists host/client identities and exposes no tokens', async () => {
    const f = await fixture();
    const attempt = await f.auth.begin();
    const url = new URL(attempt.url);
    expect(url.searchParams.get('client_id')).toBe('dynamic_agent_client');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect((await f.finish(attempt, { wrongState: true })).status).toBe(400);
    expect(f.auth.status(attempt.attemptId).status).toBe('pending');
    await f.finish(attempt);
    expect(f.auth.status(attempt.attemptId).status).toBe('connected');
    const accounts = await f.auth.accounts();
    expect(accounts).toHaveLength(1);
    expect(JSON.stringify(accounts)).not.toMatch(/fake-access|fake-refresh|idToken/);
    const account = accounts[0];
    expect(await f.auth.models(account.id)).toEqual([{ slug: 'gpt-fixture', display_name: 'GPT fixture', visibility: 'list' }]);
    const reloaded = f.create();
    const again = new URL((await reloaded.begin({ accountId: account.id })).url);
    expect(again.searchParams.get('client_id')).toBe('fixture-client');
    expect(again.searchParams.get('ext_agent_host_id')).toBe(url.searchParams.get('ext_agent_host_id'));
    expect(again.searchParams.has('id_token_hint')).toBe(false);
    expect(f.state.requests[0].get('code_verifier')).toBeTruthy();
    if (process.platform !== 'win32') expect((await fs.stat(path.join(f.dataDir, 'native-agents', 'chatgpt-accounts.json'))).mode & 0o777).toBe(0o600);
  });

  it('rejects signed ID tokens with an incorrect nonce or audience', async () => {
    const f = await fixture();
    f.state.invalidNonce = true;
    const nonceAttempt = await f.auth.begin();
    await f.finish(nonceAttempt);
    expect(f.auth.status(nonceAttempt.attemptId).status).toBe('failed');
    f.state.invalidNonce = false; f.state.invalidAudience = true;
    const audienceAttempt = await f.auth.begin();
    await f.finish(audienceAttempt);
    expect(f.auth.status(audienceAttempt.attemptId).status).toBe('failed');
    expect(await f.auth.accounts()).toEqual([]);
  });

  it('serializes rotating refreshes across two owners of the same credential file', async () => {
    const f = await fixture();
    const id = await f.login(); f.state.time += 3_600_000; f.state.refreshDelay = 30;
    const other = f.create();
    expect(await Promise.all([f.auth.accessToken(id), f.auth.accessToken(id), other.accessToken(id)])).toEqual(['fake-access-1', 'fake-access-1', 'fake-access-1']);
    expect(f.state.refreshes).toBe(1);
    const record = (await createChatgptStore({ dataDir: f.dataDir }).read()).accounts[0];
    expect(record.credentials.refreshToken).toBe('fake-refresh-1');
  });

  it('retains credentials on temporary refresh errors and clears unusable credentials', async () => {
    const f = await fixture(); const id = await f.login(); f.state.time += 3_600_000;
    f.state.tokenError = 'temporarily_unavailable';
    await expect(f.auth.accessToken(id)).rejects.toMatchObject({ code: 'CHATGPT_AUTH_UNAVAILABLE' });
    expect((await f.auth.accounts())[0].status).toBe('connected');
    f.state.tokenError = 'invalid_grant';
    await expect(f.auth.accessToken(id)).rejects.toMatchObject({ code: 'CHATGPT_REAUTH_REQUIRED' });
    expect((await f.auth.accounts())[0].status).toBe('signed-out');
  });

  it('keeps a valid identity without inference permission and does not request a model', async () => {
    const f = await fixture(); f.state.scope = 'openid profile email offline_access';
    const id = await f.login();
    expect((await f.auth.accounts())[0].status).toBe('permission-required');
    await expect(f.auth.accessToken(id)).rejects.toMatchObject({ code: 'CHATGPT_PERMISSION_REQUIRED' });
    const again = new URL((await f.auth.begin({ accountId: id })).url);
    expect(again.searchParams.get('prompt')).toBe('consent');
  });

  it('does not overwrite an account when reauthorization returns a different subject', async () => {
    const f = await fixture(); const id = await f.login();
    const attempt = await f.auth.begin({ accountId: id }); f.state.subject = 'different-user';
    await f.finish(attempt);
    expect(f.auth.status(attempt.attemptId).status).toBe('failed');
    expect(await f.auth.accessToken(id)).toBe('fake-access-0');
    expect((await f.auth.accounts())).toHaveLength(1);
  });

  it('cancels pending listeners, expires abandoned attempts and prevents overlapping starts', async () => {
    const f = await fixture({ attemptTimeoutMs: 40 });
    const starts = await Promise.allSettled([f.auth.begin(), f.auth.begin()]);
    expect(starts.map((entry) => entry.status)).toEqual(['fulfilled', 'rejected']);
    const first = starts[0].value;
    expect(f.auth.cancel(first.attemptId)).toEqual({ cancelled: true });
    expect(f.auth.status(first.attemptId).status).toBe('cancelled');
    const next = await f.auth.begin();
    await new Promise((resolve) => setTimeout(resolve, 65));
    expect(f.auth.status(next.attemptId).status).toBe('expired');
    expect(await f.auth.accounts()).toEqual([]);
  });

  it('signs out locally and reports unconfirmed remote revocation', async () => {
    const f = await fixture(); const id = await f.login(); f.state.revocationStatus = 503;
    expect(await f.auth.signOut(id)).toEqual({ signedOut: true, revoked: false });
    await expect(f.auth.accessToken(id)).rejects.toMatchObject({ code: 'CHATGPT_REAUTH_REQUIRED' });
    expect(f.state.revoked).toBe(1);
    const saved = (await createChatgptStore({ dataDir: f.dataDir }).read()).accounts[0];
    expect(saved.credentials).toBeNull();
    expect(saved.clientId).toBe('fixture-client');
  });

  it('refuses malformed storage instead of overwriting accounts', async () => {
    const f = await fixture(); await f.login();
    const file = path.join(f.dataDir, 'native-agents', 'chatgpt-accounts.json');
    await fs.writeFile(file, 'broken');
    await expect(f.auth.begin()).rejects.toMatchObject({ code: 'CHATGPT_STORAGE_READ_FAILED' });
    expect(await fs.readFile(file, 'utf8')).toBe('broken');
  });
});
