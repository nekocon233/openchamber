import crypto from 'node:crypto';
import { Octokit } from '@octokit/rest';
import {
  getGitHubAuth,
  getGitHubAuthByAccountId,
  getGhCliLoginForHost,
  isGhCliActiveForHost,
  isGhCliDisabledForHost,
} from './auth.js';
import { forgetGhCliToken, getGhCliToken } from './gh-cli-credential.js';
import { findGhCliLogin, getGhCliLoginToken } from './gh-cli-logins.js';
import { isTrustedGitHubHostOrStored } from './host-trust.js';
import { hasProperty } from './contracts.js';
import { isString } from '../shared/guards.js';
import type { AuthJson } from '../source-control/auth-storage.js';

interface EtagEntry {
  etag: string;
  body: ArrayBuffer;
  headers: Headers;
}

export interface SourceControlIdentity {
  provider: string;
  instance: string;
  accountId: string | null | undefined;
}

interface AccountOptions {
  onUnauthorized?: (identity: SourceControlIdentity, persisted: boolean) => void | Promise<void>;
}

type IdentifiedOctokit = Octokit & { openChamberCacheIdentity?: string; openChamberHost?: string };
interface ConditionalHeaders {
  [name: string]: string;
}
type RequestOptions = RequestInit & { headers?: ConditionalHeaders };

const OCTOKIT_REQUEST_TIMEOUT_MS = 8000;

const timeoutFetch = (url: string | URL | Request, options: RequestInit = {}, host = '') => {
  if (options.signal) {
    if (host && host !== 'github.com') return fetch(url, { ...options, redirect: 'error' });
    return fetch(url, options);
  }
  if (host && host !== 'github.com') {
    return fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(OCTOKIT_REQUEST_TIMEOUT_MS) });
  }
  return fetch(url, { ...options, signal: AbortSignal.timeout(OCTOKIT_REQUEST_TIMEOUT_MS) });
};

const ETAG_CACHE_MAX_ENTRIES = 300;
const etagCache = new Map<string, EtagEntry>();
type AccountErrorHandler = (error: Error) => Promise<never>;
const jobLogCredentials = new WeakMap<Octokit, { token: string; host: string; onUnauthorized?: AccountErrorHandler }>();
const DEFAULT_JOB_LOG_MAX_BYTES = 128 * 1024;
const MAX_JOB_LOG_STREAM_BYTES = 32 * 1024 * 1024;
const JOB_LOG_TIMEOUT_MS = 15_000;
const ANSI_ESCAPE = String.fromCharCode(27);
const ANSI_BELL = String.fromCharCode(7);
const ANSI_ESCAPE_RE = new RegExp(String.raw`${ANSI_ESCAPE}\[[0-9;?]*[ -/]*[@-~]|${ANSI_ESCAPE}\][^${ANSI_BELL}${ANSI_ESCAPE}]*(?:${ANSI_BELL}|${ANSI_ESCAPE}\\)`, 'g');

const rememberEtag = (key: string, etag: string, body: ArrayBuffer, headers: Headers) => {
  etagCache.delete(key);
  etagCache.set(key, { etag, body, headers });
  if (etagCache.size > ETAG_CACHE_MAX_ENTRIES) {
    const oldest = etagCache.keys().next().value;
    if (oldest !== undefined) {
      etagCache.delete(oldest);
    }
  }
};

const createConditionalFetch = (cacheIdentity: string, host = '') => async (url: string | URL | Request, options: RequestOptions = {}) => {
  const method = (options.method || 'GET').toUpperCase();
  if (method !== 'GET') {
    return timeoutFetch(url, options, host);
  }

  const accept = (new Headers(options.headers).get('accept') ?? '').trim().toLowerCase();
  const cacheKey = `${cacheIdentity}\n${accept}\n${url}`;
  const cached = etagCache.get(cacheKey);
  const headers: ConditionalHeaders = { ...(options.headers || {}) };
  if (cached?.etag) {
    headers['if-none-match'] = cached.etag;
  }

  const response = await timeoutFetch(url, { ...options, headers }, host);

  if (response.status === 304 && cached) {
    rememberEtag(cacheKey, cached.etag, cached.body, cached.headers);
    return new Response(cached.body, { status: 200, headers: cached.headers });
  }

  if (response.ok) {
    const etag = response.headers.get('etag');
    if (etag) {
      const body = await response.arrayBuffer();
      rememberEtag(cacheKey, etag, body, response.headers);
      return new Response(body, { status: response.status, headers: response.headers });
    }
  }

  return response;
};

export function createOctokit(token: AuthJson, accountId = '', host = ''): IdentifiedOctokit {
  const hash = crypto.createHash('sha256')
    .update(accountId)
    .update('\0');
  if (isString(token)) hash.update(token);
  else hash.update(token);
  const cacheIdentity = `github:${hash.digest('base64url')}`;
  const options: ConstructorParameters<typeof Octokit>[0] = { auth: token, request: { fetch: createConditionalFetch(cacheIdentity, host) } };
  const normalizedHost = String(host ?? '').trim().toLowerCase();
  if (normalizedHost && normalizedHost !== 'github.com') {
    options.baseUrl = `https://${normalizedHost}/api/v3`;
  }
  const octokit = new Octokit(options);
  octokit.hook.error('request', (error: Error) => {
    if (hasProperty(error, 'status') && error.status === 401) forgetGhCliToken(normalizedHost, token);
    throw error;
  });
  Object.defineProperty(octokit, 'openChamberCacheIdentity', {
    value: cacheIdentity,
  });
  Object.defineProperty(octokit, 'openChamberHost', {
    value: normalizedHost || 'github.com',
  });
  if (isString(token)) jobLogCredentials.set(octokit, { token, host: normalizedHost || 'github.com' });
  return octokit;
}

const bindAccountErrors = (octokit: Octokit, handler: AccountErrorHandler) => {
  const auth = jobLogCredentials.get(octokit);
  if (auth) auth.onUnauthorized = handler;
  octokit.hook.error('request', handler);
};

const readBoundedTailBuffer = async (stream: ReadableStream<Uint8Array> | null, maxBytes: number) => {
  if (!stream) {
    return { bytes: new Uint8Array(0), truncated: false };
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bufferedBytes = 0;
  let totalBytes = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value;
      if (chunk.byteLength === 0) continue;
      totalBytes += chunk.byteLength;
      if (chunk.byteLength >= maxBytes) {
        chunks.length = 0;
        chunks.push(chunk.subarray(chunk.byteLength - maxBytes));
        bufferedBytes = maxBytes;
        truncated = true;
      } else {
        chunks.push(chunk);
        bufferedBytes += chunk.byteLength;
        while (bufferedBytes > maxBytes) {
          const first = chunks[0];
          if (!first) break;
          truncated = true;
          const overflow = bufferedBytes - maxBytes;
          if (first.byteLength <= overflow) {
            chunks.shift();
            bufferedBytes -= first.byteLength;
          } else {
            chunks[0] = first.subarray(overflow);
            bufferedBytes -= overflow;
          }
        }
      }
      if (totalBytes >= MAX_JOB_LOG_STREAM_BYTES) {
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(bufferedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes: out, truncated };
};

const sanitizeJobLogText = (rawText: string, truncated: boolean) => {
  let cleaned = String(rawText ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(ANSI_ESCAPE_RE, '');
  if (truncated) {
    const newline = cleaned.indexOf('\n');
    if (newline >= 0 && newline < 512) {
      cleaned = cleaned.slice(newline + 1);
    }
  }
  return cleaned;
};

interface JobLogTarget {
  owner: string;
  repo: string;
  jobId: number | string;
  maxBytes?: number;
}
interface JobLogDownload { available: boolean; content: string; truncated: boolean }

export async function downloadGitHubJobLog(octokit: Octokit | { downloadJobLog: (target: JobLogTarget) => Promise<JobLogDownload> }, {
  owner,
  repo,
  jobId,
  maxBytes = DEFAULT_JOB_LOG_MAX_BYTES,
  fetchImpl = fetch,
  timeoutMs = JOB_LOG_TIMEOUT_MS,
}: JobLogTarget & { fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<JobLogDownload> {
  if ('downloadJobLog' in octokit) {
    return octokit.downloadJobLog({ owner, repo, jobId, maxBytes });
  }
  const meta = jobLogCredentials.get(octokit);
  if (!meta?.token) {
    throw Object.assign(new Error('GitHub account is unavailable'), { status: 401 });
  }
  const apiBase = meta.host === 'github.com' ? 'https://api.github.com' : `https://${meta.host}/api/v3`;
  const apiUrl = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/jobs/${encodeURIComponent(String(jobId))}/logs`;
  const initial = await fetchImpl(apiUrl, {
    method: 'GET',
    redirect: 'manual',
    headers: {
      Authorization: `token ${meta.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (initial.status === 401) {
    forgetGhCliToken(meta.host === 'github.com' ? '' : meta.host, meta.token);
    const error = Object.assign(new Error('GitHub token unauthorized'), { status: 401 });
    await meta.onUnauthorized?.(error);
    throw error;
  }
  if (initial.status === 404 || initial.status === 410) {
    await initial.body?.cancel?.().catch(() => {});
    return { available: false, content: '', truncated: false };
  }

  let logResponse = initial;
  if (initial.status >= 300 && initial.status < 400) {
    await initial.body?.cancel?.().catch(() => {});
    const location = initial.headers.get('location');
    if (!location) {
      throw Object.assign(new Error('GitHub job log redirect was missing Location'), { status: 502 });
    }
    let redirectUrl;
    try {
      redirectUrl = new URL(location, apiUrl);
    } catch {
      throw Object.assign(new Error('GitHub job log redirect URL was invalid'), { status: 502 });
    }
    if (redirectUrl.protocol !== 'https:') {
      throw Object.assign(new Error('GitHub job log redirect must use HTTPS'), { status: 502 });
    }
    logResponse = await fetchImpl(redirectUrl.toString(), {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (logResponse.status === 404 || logResponse.status === 410) {
      await logResponse.body?.cancel?.().catch(() => {});
      return { available: false, content: '', truncated: false };
    }
  }

  if (!logResponse.ok) {
    await logResponse.body?.cancel?.().catch(() => {});
    throw Object.assign(new Error(`Failed to fetch GitHub job log (${logResponse.status})`), {
      status: logResponse.status,
    });
  }

  const { bytes, truncated } = await readBoundedTailBuffer(logResponse.body, maxBytes);
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return {
    available: true,
    content: sanitizeJobLogText(decoded, truncated),
    truncated,
  };
}

export function getOctokitCacheIdentity(octokit: IdentifiedOctokit | null | undefined) {
  return octokit?.openChamberCacheIdentity || '';
}

export function selectTokenForHost(host: string | null | undefined, { ghToken, storedToken, ghCliActive }: {
  ghToken: string | null; storedToken: string | null | undefined; ghCliActive: boolean;
}) {
  return ghCliActive ? ghToken || storedToken : storedToken;
}

async function resolveHostCredential(host: string) {
  const stored = await getGitHubAuth(host);
  const ghCliActive = await isGhCliActiveForHost(host);
  const ghCliLogin = ghCliActive ? await getGhCliLoginForHost(host) : null;
  const ghToken = ghCliActive && !(await isGhCliDisabledForHost(host))
    ? await getGhCliToken(host, ghCliLogin)
    : null;
  return { stored, ghCliActive, ghCliLogin, ghToken };
}

export async function getOctokitOrNull(host?: string | null) {
  const normalizedHost = String(host ?? '').trim().toLowerCase();
  if (normalizedHost && normalizedHost !== 'github.com' && !(await isTrustedGitHubHostOrStored(normalizedHost))) {
    return null;
  }
  const { stored, ghCliActive, ghToken } = await resolveHostCredential(normalizedHost);
  const token = selectTokenForHost(normalizedHost, {
    ghToken,
    storedToken: stored?.accessToken,
    ghCliActive,
  });
  if (!token) {
    return null;
  }
  const accountId = token === stored?.accessToken ? stored.accountId : '';
  return createOctokit(token, accountId, normalizedHost);
}

export async function getGitHubCliCredential(accountId: string | null | undefined, revision?: number) {
  const cliMatch = /^([^#]+)#cli:(\d+)$/.exec(accountId ?? '');
  if (!cliMatch) return null;
  const host = cliMatch[1]?.toLowerCase() ?? '';
  if (host !== 'github.com' && !(await isTrustedGitHubHostOrStored(host))) return null;
  if (await isGhCliDisabledForHost(host)) return null;
  if (!(await isGhCliActiveForHost(host))) return null;
  if (revision !== undefined && revision !== 1) return null;
  const login = await findGhCliLogin(host, accountId, { createOctokit });
  if (!login) return null;
  const token = await getGhCliLoginToken(host, login);
  if (!token) return null;
  return {
    credentialId: cliMatch[0],
    accountId,
    credentialRevision: 1,
    providerUserId: `${host}#${login.id}`,
    accessToken: token,
    source: 'cli' as const,
    status: 'valid' as const,
    user: login.profile,
  };
}

export async function getOctokitForHost(host: string | null | undefined, options: AccountOptions = {}) {
  const normalizedHost = String(host ?? '').trim().toLowerCase();
  if (!normalizedHost || normalizedHost === 'github.com' || !(await isTrustedGitHubHostOrStored(normalizedHost))) {
    return null;
  }
  const { stored, ghCliActive, ghToken } = await resolveHostCredential(normalizedHost);
  if (ghCliActive && ghToken) {
    const octokit = createOctokit(ghToken, '', normalizedHost);
    bindAccountErrors(octokit, async (error) => {
      const identity = { provider: 'github', instance: normalizedHost, accountId: null };
      Object.assign(error, { sourceControlIdentity: identity, sourceControlPersistedAccount: false });
      if (hasProperty(error, 'status') && error.status === 401) {
        await options.onUnauthorized?.(identity, false);
        Object.assign(error, { sourceControlInvalidated: true });
      }
      throw error;
    });
    return octokit;
  }
  if (!stored) return null;
  const octokit = createOctokit(stored.accessToken, stored.accountId, normalizedHost);
  bindAccountErrors(octokit, async (error) => {
    const identity = { provider: 'github', instance: normalizedHost, accountId: stored.accountId };
    Object.assign(error, { sourceControlIdentity: identity, sourceControlPersistedAccount: true });
    if (hasProperty(error, 'status') && error.status === 401) {
      await options.onUnauthorized?.(identity, true);
      Object.assign(error, { sourceControlInvalidated: true });
    }
    throw error;
  });
  return octokit;
}

export async function getOctokitForAccountId(accountId: string | undefined, options: AccountOptions = {}) {
  const auth = await getGitHubAuthByAccountId(accountId, undefined);
  if (auth) {
    const host = auth.host;
    const octokit = createOctokit(auth.accessToken, accountId, host);
    bindAccountErrors(octokit, async (error) => {
      const identity = { provider: 'github', instance: host, accountId };
      Object.assign(error, { sourceControlIdentity: identity, sourceControlPersistedAccount: true });
      if (hasProperty(error, 'status') && error.status === 401) {
        await options.onUnauthorized?.(identity, true);
        Object.assign(error, { sourceControlInvalidated: true });
      }
      throw error;
    });
    return {
      accountId,
      credentialRevision: auth.credentialRevision,
      providerUserId: auth.providerUserId,
      source: auth.source,
      user: auth.user,
      octokit,
    };
  }
  const cliMatch = /^([^#]+)#cli:(\d+)$/.exec(accountId);
  if (!cliMatch) return null;
  const host = cliMatch[1]?.toLowerCase() ?? '';
  if (host !== 'github.com' && !(await isTrustedGitHubHostOrStored(host))) return null;
  if (!(await isGhCliActiveForHost(host)) || (await isGhCliDisabledForHost(host))) return null;
  const login = await findGhCliLogin(host, accountId, { createOctokit });
  const token = login ? await getGhCliLoginToken(host, login) : null;
  if (!login || !token) return null;
  const octokit = createOctokit(token, accountId, host);
  bindAccountErrors(octokit, async (error) => {
    const identity = { provider: 'github', instance: host, accountId };
    Object.assign(error, { sourceControlIdentity: identity, sourceControlPersistedAccount: false });
    if (hasProperty(error, 'status') && error.status === 401) {
      await options.onUnauthorized?.(identity, false);
      Object.assign(error, { sourceControlInvalidated: true });
    }
    throw error;
  });
  return {
    accountId,
    credentialRevision: 1,
    providerUserId: `${host}#${login.id}`,
    source: 'cli',
    user: login.profile,
    octokit,
  };
}
