import { describe, expect, it } from 'vitest';
import { createCliproxyapiClient } from './client.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const gateway = (respond) => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return respond(url, options);
  };
  return { calls, client: createCliproxyapiClient({ baseURL: 'http://127.0.0.1:8317/', managementKey: 'management-test-key', fetchImpl }) };
};

const credential = {
  provider: 'codex',
  id: 'codex-d016f257-user@example.com-pro.json',
  name: 'codex-d016f257-user@example.com-pro.json',
  email: 'user@example.com',
  account_type: 'oauth',
  status: 'active',
  disabled: false,
  id_token: { plan_type: 'pro', chatgpt_subscription_active_until: '2026-11-11T18:14:58+00:00' },
};

describe('CLIProxyAPI client', () => {
  it('honors a caller deadline in addition to the management request timeout', async () => {
    const controller = new AbortController();
    const client = createCliproxyapiClient({ baseURL: 'http://127.0.0.1:8317', managementKey: 'test-key', signal: controller.signal,
      fetchImpl: async (url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      }),
    });
    const pending = client.models('test-client-key');
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CLIPROXYAPI_NOT_REACHABLE' });
  });

  it('probes reachability without a key and treats any answer as running', async () => {
    const { calls, client } = gateway(() => json({ error: 'missing api key' }, 401));
    expect(await client.reachable()).toBe(true);
    expect(calls[0].url).toBe('http://127.0.0.1:8317/v1/models');
    expect(calls[0].options.headers).not.toHaveProperty('Authorization');
    expect(calls[0].options.redirect).toBe('error');
  });

  it('reports an unreachable gateway on the probe and on a management call', async () => {
    const { client } = gateway(() => { throw new Error('connect ECONNREFUSED 127.0.0.1:8317'); });
    expect(await client.reachable()).toBe(false);
    await expect(client.accounts()).rejects.toMatchObject({ code: 'CLIPROXYAPI_NOT_REACHABLE', status: 503 });
  });

  it('separates a disabled management API from a rejected key', async () => {
    const disabled = gateway(() => json({ error: 'not found' }, 404));
    await expect(disabled.client.accounts()).rejects.toMatchObject({ code: 'CLIPROXYAPI_MANAGEMENT_DISABLED' });
    const rejected = gateway(() => json({ error: 'invalid api key' }, 401));
    await expect(rejected.client.accounts()).rejects.toMatchObject({ code: 'CLIPROXYAPI_KEY_REJECTED' });
    expect(rejected.calls[0].options.headers.Authorization).toBe('Bearer management-test-key');
  });

  it('reads the credential list in the terms the settings page shows', async () => {
    const { client } = gateway((url) => (new URL(url).pathname === '/v0/management/auth-files' ? json({ files: [credential, {}] }) : json({}, 404)));
    expect(await client.accounts()).toEqual([{
      name: 'codex-d016f257-user@example.com-pro.json',
      email: 'user@example.com',
      priority: null,
      planType: 'pro',
      activeUntil: '2026-11-11T18:14:58+00:00',
      status: 'active',
      disabled: false,
      provider: 'codex',
    }]);
  });

  it('refuses a management body it cannot read', async () => {
    const { client } = gateway(() => json({ accounts: [] }));
    await expect(client.accounts()).rejects.toMatchObject({ code: 'CLIPROXYAPI_UNEXPECTED_RESPONSE' });
  });

  it('accepts either spelling of the sign-in URL and rejects a body with neither', async () => {
    const modern = gateway(() => json({ status: 'ok', url: 'https://auth.openai.com/codex/device', state: 'abc123' }));
    expect(await modern.client.beginLogin()).toEqual({ state: 'abc123', url: 'https://auth.openai.com/codex/device' });
    const documented = gateway(() => json({ status: 'ok', auth_url: 'https://auth.openai.com/codex/device', state: 'abc123' }));
    expect((await documented.client.beginLogin()).url).toBe('https://auth.openai.com/codex/device');
    const broken = gateway(() => json({ status: 'ok', state: 'abc123' }));
    await expect(broken.client.beginLogin()).rejects.toMatchObject({ code: 'CLIPROXYAPI_UNEXPECTED_RESPONSE' });
  });

  it('uses the requested OAuth provider and retains mixed account identities', async () => {
    const { calls, client } = gateway((url) => url.includes('auth-url')
      ? json({ state: 'ag-login', url: 'https://accounts.google.com/o/oauth2/auth' })
      : json({ files: [credential, { ...credential, provider: 'antigravity', name: 'ag.json' }] }));
    await client.beginLogin('antigravity');
    expect(new URL(calls[0].url).pathname).toBe('/v8/management/oauth/auth-url');
    expect(new URL(calls[0].url).searchParams.get('provider')).toBe('antigravity');
    expect((await client.accounts()).map((entry) => entry.provider)).toEqual(['codex', 'antigravity']);
  });

  it('maps sign-in status and keeps an unknown state pending', async () => {
    const { client } = gateway((url) => {
      const state = new URL(url).searchParams.get('state');
      if (state === 'done') return json({ status: 'ok' });
      if (state === 'gone') return json({ status: 'error', error: 'unknown or expired state' });
      return json({ status: 'wait' });
    });
    expect(await client.loginStatus('pending')).toEqual({ status: 'pending', message: null });
    expect(await client.loginStatus('done')).toEqual({ status: 'connected', message: null });
    expect(await client.loginStatus('gone')).toEqual({ status: 'failed', message: 'unknown or expired state' });
  });

  it('reports a cancel route it does not have instead of a failure', async () => {
    const missing = gateway(() => new Response(null, { status: 404 }));
    expect(await missing.client.cancelLogin('abc123')).toBe(false);
    const present = gateway(() => json({ status: 'ok' }));
    expect(await present.client.cancelLogin('abc123')).toBe(true);
    expect(present.calls[0].url).toBe('http://127.0.0.1:8317/v8/management/oauth/session?state=abc123');
  });

  it('writes the client-key list through the config document route', async () => {
    const { calls, client } = gateway(() => json({ 'config-version': 8, status: 'ok' }));
    await client.setClientKeys(['one', 'two']);
    expect(calls[0].url).toBe('http://127.0.0.1:8317/v8/management/config');
    expect(calls[0].options.method).toBe('PATCH');
    expect(JSON.parse(calls[0].options.body)).toEqual({ access: { 'api-keys': ['one', 'two'] } });
  });

  it('removes one credential by its reported file name', async () => {
    const { calls, client } = gateway(() => json({ status: 'ok' }));
    await client.removeAccount('codex-d016f257-user@example.com-pro.json');
    expect(calls[0].url).toBe('http://127.0.0.1:8317/v0/management/auth-files?name=codex-d016f257-user%40example.com-pro.json');
    expect(calls[0].options.method).toBe('DELETE');
  });

  it('posts a pasted callback to the gateway under the management key', async () => {
    const { calls, client } = gateway(() => json({ status: 'ok' }));
    await expect(client.submitLoginCallback('abc123', 'the-code')).resolves.toBeUndefined();
    expect(calls[0].url).toBe('http://127.0.0.1:8317/v0/management/oauth-callback');
    expect(calls[0].options.method).toBe('POST');
    expect(calls[0].options.headers.Authorization).toBe('Bearer management-test-key');
    expect(JSON.parse(calls[0].options.body)).toEqual({ provider: 'codex', state: 'abc123', code: 'the-code' });
  });

  it('classifies a refused callback by its body, not by its status code', async () => {
    const expired = gateway(() => json({ status: 'error', error: 'unknown or expired state' }, 404));
    await expect(expired.client.submitLoginCallback('abc123', 'x')).rejects.toMatchObject({
      code: 'CLIPROXYAPI_LOGIN_CALLBACK_REJECTED', status: 409, message: 'unknown or expired state',
    });
    const disabled = gateway(() => new Response(null, { status: 404 }));
    await expect(disabled.client.submitLoginCallback('abc123', 'x')).rejects.toMatchObject({ code: 'CLIPROXYAPI_MANAGEMENT_DISABLED' });
    const rejected = gateway(() => json({ error: 'invalid api key' }, 401));
    await expect(rejected.client.submitLoginCallback('abc123', 'x')).rejects.toMatchObject({ code: 'CLIPROXYAPI_KEY_REJECTED' });
    const down = gateway(() => { throw new Error('connect ECONNREFUSED 127.0.0.1:8317'); });
    await expect(down.client.submitLoginCallback('abc123', 'x')).rejects.toMatchObject({ code: 'CLIPROXYAPI_NOT_REACHABLE' });
  });
});
