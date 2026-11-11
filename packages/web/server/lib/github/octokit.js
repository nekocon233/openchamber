import crypto from 'node:crypto';
import { Octokit } from '@octokit/rest';
import {
  getGitHubAuth,
  getGitHubAuthByAccountId,
  isGhCliActiveForHost,
  isGhCliDisabledForHost,
} from './auth.js';
import { forgetGhCliToken, getGhCliToken } from './gh-cli-credential.js';
import { isTrustedGitHubHostOrStored } from './host-trust.js';

// Per-request timeout for every GitHub call. Octokit v22 uses native fetch,
// which has no built-in timeout — without this, a stuck connection hangs until
// some outer bound (the PR-status route's 12s overall budget) fires, and a
// single slow request can eat the whole budget. Bounding each request lets the
// caller fail fast and fall back to cached state instead.
const OCTOKIT_REQUEST_TIMEOUT_MS = 8000;

const timeoutFetch = (url, options = {}, host = '') => {
  // Refuse redirects for a named enterprise host: the credential goes to the
  // instance only, so a redirect never carries it to another origin (the same
  // rule as GitLab's client). github.com keeps the previous default and follows
  // redirects, exactly as before this change.
  if (options.signal) {
    if (host && host !== 'github.com') return fetch(url, { ...options, redirect: 'error' });
    return fetch(url, options);
  }
  if (host && host !== 'github.com') {
    return fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(OCTOKIT_REQUEST_TIMEOUT_MS) });
  }
  return fetch(url, { ...options, signal: AbortSignal.timeout(OCTOKIT_REQUEST_TIMEOUT_MS) });
};

// Conditional-request cache for GET calls: GitHub serves 304 Not Modified for
// matching If-None-Match WITHOUT counting the request against the REST rate
// limit, so polling unchanged PRs/checks becomes rate-limit-free. Keyed by a
// credential digest plus URL so raw tokens do not become cache keys.
const ETAG_CACHE_MAX_ENTRIES = 300;
const etagCache = new Map();
const octokitAuthMeta = new WeakMap();
const DEFAULT_JOB_LOG_MAX_BYTES = 128 * 1024;
const MAX_JOB_LOG_STREAM_BYTES = 32 * 1024 * 1024;
const JOB_LOG_TIMEOUT_MS = 15_000;
// Strip ANSI CSI/OSC sequences so plain-text viewers and agent attachments read cleanly.
const ANSI_ESCAPE_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

const rememberEtag = (key, etag, body, headers) => {
  etagCache.delete(key);
  etagCache.set(key, { etag, body, headers });
  if (etagCache.size > ETAG_CACHE_MAX_ENTRIES) {
    const oldest = etagCache.keys().next().value;
    if (oldest !== undefined) {
      etagCache.delete(oldest);
    }
  }
};

const createConditionalFetch = (cacheIdentity, host = '') => async (url, options = {}) => {
  const method = (options.method || 'GET').toUpperCase();
  if (method !== 'GET') {
    return timeoutFetch(url, options, host);
  }

  const cacheKey = `${cacheIdentity}\n${url}`;
  const cached = etagCache.get(cacheKey);
  const headers = { ...(options.headers || {}) };
  if (cached?.etag) {
    headers['if-none-match'] = cached.etag;
  }

  const response = await timeoutFetch(url, { ...options, headers }, host);

  if (response.status === 304 && cached) {
    // Touch for LRU and replay the cached success response.
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

/**
 * Create an Octokit instance with per-request timeout + ETag revalidation.
 *
 * `host` targets a specific GitHub Enterprise API root. github.com (or omitted)
 * uses Octokit's default `api.github.com` base URL. The cache identity is the
 * credential digest only: the request URL inside the cache carries the host, so
 * one host's 304 replay can never serve another host's body.
 */
export function createOctokit(token, accountId = '', host = '') {
  const cacheIdentity = `github:${crypto.createHash('sha256')
    .update(accountId)
    .update('\0')
    .update(token)
    .digest('base64url')}`;
  const options = { auth: token, request: { fetch: createConditionalFetch(cacheIdentity, host) } };
  const normalizedHost = String(host ?? '').trim().toLowerCase();
  if (normalizedHost && normalizedHost !== 'github.com') {
    options.baseUrl = `https://${normalizedHost}/api/v3`;
  }
  const octokit = new Octokit(options);
  // A refused token that came from gh is asked from gh again next time.
  octokit.hook.error('request', (error) => {
    if (error?.status === 401) forgetGhCliToken(normalizedHost, token);
    throw error;
  });
  Object.defineProperty(octokit, 'openChamberCacheIdentity', {
    value: cacheIdentity,
  });
  // The host it talks to, for checks of what it answers (routes.js).
  Object.defineProperty(octokit, 'openChamberHost', {
    value: normalizedHost || 'github.com',
  });
  octokitAuthMeta.set(octokit, {
    token,
    accountId,
    host: normalizedHost || 'github.com',
    onUnauthorized: null,
  });
  return octokit;
}

const setOctokitUnauthorizedHandler = (octokit, handler) => {
  const meta = octokitAuthMeta.get(octokit);
  if (meta) meta.onUnauthorized = handler;
};

const readBoundedTailBuffer = async (stream, maxBytes) => {
  if (!stream || !(stream.getReader instanceof Function)) {
    return { bytes: new Uint8Array(0), truncated: false };
  }
  const reader = stream.getReader();
  const chunks = [];
  let bufferedBytes = 0;
  let totalBytes = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
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
        while (bufferedBytes > maxBytes && chunks.length > 0) {
          truncated = true;
          const overflow = bufferedBytes - maxBytes;
          const first = chunks[0];
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

const sanitizeJobLogText = (rawText, truncated) => {
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

/**
 * Download the tail of a GitHub Actions job log without forwarding the GitHub
 * credential across redirects (preserving enterprise host isolation).
 */
export async function downloadGitHubJobLog(octokit, {
  owner,
  repo,
  jobId,
  maxBytes = DEFAULT_JOB_LOG_MAX_BYTES,
  fetchImpl = fetch,
  timeoutMs = JOB_LOG_TIMEOUT_MS,
}) {
  if (octokit?.downloadJobLog instanceof Function) {
    return octokit.downloadJobLog({ owner, repo, jobId, maxBytes });
  }
  const meta = octokitAuthMeta.get(octokit);
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

export function getOctokitCacheIdentity(octokit) {
  return octokit?.openChamberCacheIdentity || '';
}

/**
 * Pick the token for a host. The stored credential — github.com's OAuth token on
 * github.com, a stored per-host personal access token on a trusted enterprise
 * host — is the preference. The gh token is used only while that instance's CLI
 * is explicitly active: the github.com Settings switch on github.com, the
 * instance's own activation on an enterprise host. The stored github.com OAuth
 * token is always a github.com credential (the device flow is hardcoded to
 * github.com) — the caller scopes which stored token belongs to which host, so
 * that token never becomes a candidate for another instance's API root.
 */
export function selectTokenForHost(host, { ghToken, storedToken, ghCliActive }) {
  return ghCliActive ? ghToken || storedToken : storedToken;
}

/**
 * The one source of the credential decision for a host. The stored per-host
 * credential is the preference; the host's gh token is used only while that
 * instance's gh login is active (the same rule as GitLab). Every entry point
 * that answers "what credential does this host use" asks this, so the policy
 * cannot drift between callers.
 */
async function resolveHostCredential(host) {
  const stored = await getGitHubAuth(host);
  const ghCliActive = await isGhCliActiveForHost(host);
  const ghToken = ghCliActive && !(await isGhCliDisabledForHost(host)) ? await getGhCliToken(host) : null;
  return { stored, ghCliActive, ghToken };
}

export async function getOctokitOrNull(host) {
  // Never mint a token for a host the user never authenticated with: sending a
  // github.com credential to an arbitrary remote host would leak it there. This
  // gate runs before ANY token lookup, so a direct caller with a client-supplied
  // host cannot bypass repo resolution. github.com (and an omitted host) is
  // always fine.
  const normalizedHost = String(host ?? '').trim().toLowerCase();
  if (normalizedHost && normalizedHost !== 'github.com' && !(await isTrustedGitHubHostOrStored(normalizedHost))) {
    return null;
  }
  // The stored credential is per host: github.com's active OAuth token, or the
  // active per-host token of a trusted enterprise host. resolveHostCredential
  // decides which token the host uses (stored, or gh while its CLI is active).
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

/**
 * The gh CLI account as a credential record shaped like a persisted one, for
 * Git transport. Same consent rule as getOctokitForAccountId: a
 * `github.com#cli:` account resolves only while the user has switched to gh in
 * Settings, while a trusted enterprise host's `<host>#cli:` account uses that
 * host's gh login only after the instance itself was activated. gh must still be
 * signed in as that same user. The CLI credential has no revisions beyond 1.
 */
export async function getGitHubCliCredential(accountId, revision) {
  const cliMatch = /^([^#]+)#cli:(\d+)$/.exec(accountId ?? '');
  if (!cliMatch) return null;
  const host = cliMatch[1].toLowerCase();
  if (host !== 'github.com' && !(await isTrustedGitHubHostOrStored(host))) return null;
  if (await isGhCliDisabledForHost(host)) return null;
  if (!(await isGhCliActiveForHost(host))) return null;
  if (revision !== undefined && revision !== 1) return null;
  const token = await getGhCliToken(host);
  if (!token) return null;
  let response;
  try {
    response = await createOctokit(token, accountId, host).rest.users.getAuthenticated();
  } catch (error) {
    if (error?.status === 401) return null;
    throw error;
  }
  if (`${host}#cli:${response.data.id}` !== accountId) return null;
  return {
    credentialId: accountId,
    accountId,
    credentialRevision: 1,
    providerUserId: `${host}#${response.data.id}`,
    accessToken: token,
    source: 'cli',
    status: 'valid',
    user: response.data,
  };
}

/**
 * The host-pinned Octokit for a GitHub Enterprise host, or null when the host is
 * untrusted or has neither a stored credential nor an activated gh login. The
 * stored per-host credential is the preference, and the host's gh token is used
 * only while the instance's gh login is active, like GitLab and
 * getOctokitForAccountId. github.com is served by the account layer.
 */
export async function getOctokitForHost(host, options = {}) {
  const normalizedHost = String(host ?? '').trim().toLowerCase();
  if (!normalizedHost || normalizedHost === 'github.com' || !(await isTrustedGitHubHostOrStored(normalizedHost))) {
    return null;
  }
  const { stored, ghCliActive, ghToken } = await resolveHostCredential(normalizedHost);
  if (ghCliActive && ghToken) {
    const octokit = createOctokit(ghToken, '', normalizedHost);
    const handleUnauthorized = async (error) => {
      const identity = { provider: 'github', instance: normalizedHost, accountId: null };
      error.sourceControlIdentity = identity;
      error.sourceControlPersistedAccount = false;
      if (error.status === 401) {
        await options.onUnauthorized?.(identity, false);
        error.sourceControlInvalidated = true;
      }
    };
    setOctokitUnauthorizedHandler(octokit, handleUnauthorized);
    octokit.hook.error('request', async (error) => {
      await handleUnauthorized(error);
      throw error;
    });
    return octokit;
  }
  if (!stored) return null;
  const octokit = createOctokit(stored.accessToken, stored.accountId, normalizedHost);
  const handleUnauthorized = async (error) => {
    const identity = { provider: 'github', instance: normalizedHost, accountId: stored.accountId };
    error.sourceControlIdentity = identity;
    error.sourceControlPersistedAccount = true;
    if (error.status === 401) {
      await options.onUnauthorized?.(identity, true);
      error.sourceControlInvalidated = true;
    }
  };
  setOctokitUnauthorizedHandler(octokit, handleUnauthorized);
  octokit.hook.error('request', async (error) => {
    await handleUnauthorized(error);
    throw error;
  });
  return octokit;
}

export async function getOctokitForAccountId(accountId, options = {}) {
  const auth = await getGitHubAuthByAccountId(accountId);
  if (auth) {
    const host = auth.host;
    const octokit = createOctokit(auth.accessToken, accountId, host);
    const handleUnauthorized = async (error) => {
      const identity = { provider: 'github', instance: host, accountId };
      error.sourceControlIdentity = identity;
      error.sourceControlPersistedAccount = true;
      if (error.status === 401) {
        await options.onUnauthorized?.(identity, true);
        error.sourceControlInvalidated = true;
      }
    };
    setOctokitUnauthorizedHandler(octokit, handleUnauthorized);
    octokit.hook.error('request', async (error) => {
      await handleUnauthorized(error);
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
  // An exact CLI account id is not consent on its own: a `<host>#cli:<id>` id
  // uses that host's gh token only while the instance's gh login is active and
  // signed in as that user. Otherwise it resolves to nothing, never to another
  // account stored for the host, which may be a different person (as on
  // GitLab). An untrusted host never resolves at all.
  const cliMatch = /^([^#]+)#cli:(\d+)$/.exec(accountId);
  if (!cliMatch) return null;
  const host = cliMatch[1].toLowerCase();
  if (host !== 'github.com' && !(await isTrustedGitHubHostOrStored(host))) return null;
  const { ghCliActive, ghToken } = await resolveHostCredential(host);
  if (ghCliActive && ghToken) {
    const octokit = createOctokit(ghToken, accountId, host);
    let response;
    try {
      response = await octokit.rest.users.getAuthenticated();
    } catch (error) {
      if (error?.status === 401) {
        const identity = { provider: 'github', instance: host, accountId };
        await options.onUnauthorized?.(identity, false);
        error.sourceControlIdentity = identity;
        error.sourceControlPersistedAccount = false;
        error.sourceControlInvalidated = true;
      }
      throw error;
    }
    if (`${host}#cli:${response.data.id}` !== accountId) {
      await options.onUnauthorized?.({ provider: 'github', instance: host, accountId }, false);
      return null;
    }
    const handleCliUnauthorized = async (error) => {
      const identity = { provider: 'github', instance: host, accountId };
      error.sourceControlIdentity = identity;
      error.sourceControlPersistedAccount = false;
      if (error.status === 401) {
        await options.onUnauthorized?.(identity, false);
        error.sourceControlInvalidated = true;
      }
    };
    setOctokitUnauthorizedHandler(octokit, handleCliUnauthorized);
    octokit.hook.error('request', async (error) => {
      await handleCliUnauthorized(error);
      throw error;
    });
    return {
      accountId,
      credentialRevision: 1,
      providerUserId: `${host}#${response.data.id}`,
      source: 'cli',
      user: response.data,
      octokit,
    };
  }
  return null;
}
