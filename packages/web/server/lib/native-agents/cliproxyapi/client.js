import { z } from 'zod';
import { NativeAgentError } from '../errors.js';

/** CLIProxyAPI's documented default; a stored key may point elsewhere. */
export const DEFAULT_CLIPROXYAPI_BASE_URL = 'http://127.0.0.1:8317';

/** The gateway expires a sign-in state after ten minutes; callers poll inside it. */
export const LOGIN_WINDOW_MS = 9 * 60 * 1000;

// A management call must not hang a settings page behind a gateway that took
// the connection and never answered.
const CALL_TIMEOUT_MS = 10_000;

const notReachable = () => new NativeAgentError(
  'The local CLIProxyAPI gateway did not answer on the server computer',
  { status: 503, code: 'CLIPROXYAPI_NOT_REACHABLE' },
);
const managementDisabled = () => new NativeAgentError(
  'The CLIProxyAPI management API is disabled: set management.secret-key in its config and restart it',
  { status: 409, code: 'CLIPROXYAPI_MANAGEMENT_DISABLED' },
);
const keyRejected = () => new NativeAgentError(
  'CLIProxyAPI rejected the management key',
  { status: 401, code: 'CLIPROXYAPI_KEY_REJECTED' },
);
const unexpected = () => new NativeAgentError(
  'CLIProxyAPI answered a management call with an unexpected body',
  { status: 502, code: 'CLIPROXYAPI_UNEXPECTED_RESPONSE' },
);

const authFileSchema = z.object({
  name: z.string().min(1).nullish(),
  id: z.string().min(1).nullish(),
  email: z.string().nullish(),
  account_type: z.string().nullish(),
  status: z.string().nullish(),
  disabled: z.boolean().nullish(),
  id_token: z.object({
    plan_type: z.string().nullish(),
    chatgpt_subscription_active_until: z.string().nullish(),
  }).nullish(),
});
const accountsSchema = z.object({ files: z.array(authFileSchema) });
const clientKeysSchema = z.object({ 'api-keys': z.array(z.string().min(1)) });
// 8.0.30 answers `{ status, url, state }`; the published docs describe
// `auth_url` and `expires_at`. Accept either spelling of the URL.
const authUrlSchema = z.object({
  status: z.string().nullish(),
  url: z.string().min(1).optional(),
  auth_url: z.string().min(1).optional(),
  state: z.string().min(1),
});
const loginStatusSchema = z.object({ status: z.string(), error: z.string().nullish() });

/** One credential file, in the terms the settings page shows. */
const account = (file) => ({
  name: file.name ?? file.id ?? '',
  email: file.email ?? null,
  planType: file.id_token?.plan_type ?? null,
  activeUntil: file.id_token?.chatgpt_subscription_active_until ?? null,
  status: file.status ?? null,
  disabled: file.disabled === true,
});

export const createCliproxyapiClient = ({ baseURL, managementKey, fetchImpl = fetch }) => {
  const origin = baseURL.replace(/\/+$/, '');

  const send = (path, { method = 'GET', body, auth = true } = {}) => {
    const headers = {};
    if (auth) headers.Authorization = `Bearer ${managementKey}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return fetchImpl(`${origin}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      // A redirect could hand an authenticated management call to another host.
      redirect: 'error',
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  };

  const managed = async (path, options) => {
    let response;
    try {
      response = await send(path, options);
    } catch {
      throw notReachable();
    }
    if (response.status === 404) throw managementDisabled();
    if (response.status === 401 || response.status === 403) throw keyRejected();
    if (!response.ok) throw new NativeAgentError(`CLIProxyAPI answered ${response.status}`, { status: 502, code: 'CLIPROXYAPI_REQUEST_FAILED' });
    return response;
  };

  return {
    /** True when something answers on the gateway's port, key or no key. */
    async reachable() {
      try {
        await send('/v1/models', { auth: false });
        return true;
      } catch {
        return false;
      }
    },
    async accounts() {
      const response = await managed('/v0/management/auth-files');
      const parsed = accountsSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) throw unexpected();
      return parsed.data.files.map(account).filter((entry) => entry.name !== '');
    },
    async removeAccount(name) {
      await managed(`/v0/management/auth-files?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
    },
    async clientKeys() {
      const response = await managed('/v0/management/api-keys');
      const parsed = clientKeysSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) throw unexpected();
      return parsed.data['api-keys'];
    },
    /**
     * Replaces the whole client-key list. 8.0.30 has no per-key write route:
     * `PATCH /v8/management/config` takes a config document and swaps the
     * `access.api-keys` section, rewriting the gateway's config file. Callers
     * read the list first and write back the edited one.
     */
    async setClientKeys(keys) {
      await managed('/v8/management/config', { method: 'PATCH', body: { access: { 'api-keys': keys } } });
    },
    async beginLogin() {
      const response = await managed('/v0/management/codex-auth-url?is_webui=true');
      const parsed = authUrlSchema.safeParse(await response.json().catch(() => null));
      const url = parsed.success ? parsed.data.url ?? parsed.data.auth_url : undefined;
      if (!parsed.success || url === undefined) throw unexpected();
      return { state: parsed.data.state, url };
    },
    async loginStatus(state) {
      const response = await managed(`/v0/management/get-auth-status?state=${encodeURIComponent(state)}`);
      const parsed = loginStatusSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) throw unexpected();
      if (parsed.data.status === 'ok') return { status: 'connected', message: null };
      if (parsed.data.status === 'error') return { status: 'failed', message: parsed.data.error ?? null };
      return { status: 'pending', message: null };
    },
    /** False when this build has no cancel route; the state expires on its own. */
    async cancelLogin(state) {
      let response;
      try {
        // Cancel exists on the v8 surface only.
        response = await send(`/v8/management/oauth/session?state=${encodeURIComponent(state)}`, { method: 'DELETE' });
      } catch {
        throw notReachable();
      }
      if (response.status === 404) return false;
      if (response.status === 401 || response.status === 403) throw keyRejected();
      if (!response.ok) throw new NativeAgentError(`CLIProxyAPI answered ${response.status}`, { status: 502, code: 'CLIPROXYAPI_REQUEST_FAILED' });
      return true;
    },
  };
};
