// Provider state that exists only inside the running OpenCode process.
//
// A plugin registers its provider from the `config` hook and supplies the
// credential from its `auth` loader, both at startup. Neither ends up in
// `opencode.json` or `auth.json`, so a server that only reads files sees
// nothing — which is why plugin-backed models used to fail here with
// "has no known API base URL" while working fine in chat (#2666).
//
// `GET /provider` is where that state becomes visible. It reports, per
// provider, the resolved `options.baseURL` and `options.apiKey`, and per model
// the wire adapter (`api.npm`) and endpoint (`api.url`). The provider-level
// endpoint remains only as a fallback when the selected model has no endpoint.
//
// What it does NOT report is `options.fetch`. OpenCode strips functions from
// the response, and a plugin is free to put its whole protocol in there:
// rewriting the path, signing the request, translating the payload. Such a
// provider advertises a perfectly ordinary base URL that answers nothing we
// know how to ask, and no field distinguishes the two.
//
// Asking the endpoint (`GET /models`) looked like the way to tell them apart,
// and it does answer correctly for that case — but measured against the 166
// providers in the models.dev catalog it also denies six that work fine and
// simply have no `/models` route. A provider that vanishes from the picker
// explains nothing; one that fails on use says why. So this module reports
// what it knows and leaves the verdict to the call itself.

const SNAPSHOT_TTL_MS = 30_000;
const SNAPSHOT_TIMEOUT_MS = 5_000;

// opencode zen hands out this sentinel instead of a key when the user has no
// zen login, and trims its catalog to the free models. Those run on OpenCode's
// own subsidised infrastructure and are meant to be reached through OpenCode,
// not by us. Treating the sentinel as a credential would do exactly that, so
// it is never accepted as one.
export const ZEN_ANONYMOUS_API_KEY = 'public';

let connection = null;
let generation = 0;
const scopes = new Map();

const directoryKey = (directory) => directory ?? '';

const getScope = (key) => {
  let scope = scopes.get(key);
  if (!scope) {
    scope = { snapshot: null, snapshotAt: 0, inflight: null };
    scopes.set(key, scope);
  }
  return scope;
};

/**
 * Wires this module to the running OpenCode instance. Called once at server
 * startup; pass `null` to detach. Until it is wired every lookup answers
 * "nothing known", which leaves the file-based resolution unchanged.
 */
export function configureOpenCodeRuntimeProviders(next) {
  connection = next ?? null;
  resetOpenCodeRuntimeProviders();
}

/**
 * Drops every cached answer. OpenCode restarts reload plugins, which can
 * change ports, keys and the provider list itself.
 */
export function resetOpenCodeRuntimeProviders() {
  generation += 1;
  scopes.clear();
}

/**
 * The boundary. Everything the `/provider` payload claims is checked here, so
 * the rest of this module and its callers work with settled values:
 * a credential we may use, provider and model endpoints, and whether the
 * provider is the anonymous zen case.
 *
 * The credential deliberately prefers `options.apiKey` over the `key` field:
 * for a plugin provider the former is what its auth loader produced and what
 * OpenCode itself sends, while `key` only carries env/auth.json values this
 * server can already read from disk.
 */
function parseProviderListing(payload) {
  const providers = new Map();
  const connected = new Set();
  if (!payload || typeof payload !== 'object') return { providers, connected };

  const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
  const record = (value) => (value && typeof value === 'object' ? value : {});
  const endpoint = (value) => text(value)?.replace(/\/+$/, '') ?? null;

  for (const raw of Array.isArray(payload.all) ? payload.all : []) {
    const provider = record(raw);
    const id = text(provider.id);
    if (!id) continue;
    const options = record(provider.options);
    const models = new Map();
    for (const [modelID, rawModel] of Object.entries(record(provider.models))) {
      const model = record(rawModel);
      const api = record(model.api);
      const modelURL = endpoint(api.url);
      const modelNpm = text(api.npm);
      models.set(modelID, { api: { url: modelURL, npm: modelNpm } });
    }
    const firstModel = models.values().next().value;
    const declaredKey = text(options.apiKey);
    providers.set(id, {
      id,
      source: text(provider.source),
      apiKey: declaredKey === ZEN_ANONYMOUS_API_KEY ? null : (declaredKey ?? text(provider.key)),
      baseURL: endpoint(options.baseURL) ?? firstModel?.api?.url ?? null,
      models,
      // True only for the zen-without-login case: a provider that is present
      // and usable through OpenCode, but that we must not call ourselves.
      anonymousZen: declaredKey === ZEN_ANONYMOUS_API_KEY,
    });
  }

  // Providers OpenCode considers usable right now. A provider can be present
  // in `all` (it is in the catalog) without any credential behind it.
  for (const raw of Array.isArray(payload.connected) ? payload.connected : []) {
    const id = text(raw);
    if (id) connected.add(id);
  }

  return { providers, connected };
}

const fetchSnapshot = async (activeConnection, directory) => {
  const url = new URL(activeConnection.buildOpenCodeUrl('/provider', ''));
  if (directory) url.searchParams.set('directory', directory);
  const response = await fetch(url.toString(), {
    headers: { Accept: 'application/json', ...activeConnection.getOpenCodeAuthHeaders() },
    signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`OpenCode provider listing failed with ${response.status}`);
  }
  return parseProviderListing(await response.json());
};

/**
 * The current runtime provider snapshot, or `null` when OpenCode cannot be
 * reached.
 *
 * `null` means "unknown", never "no providers": callers must fall back to
 * their file-based resolution rather than treat an unreachable OpenCode as an
 * empty provider list.
 */
export async function getRuntimeProviderSnapshot(directory) {
  const activeConnection = connection;
  if (!activeConnection) return null;

  const key = directoryKey(directory);
  const scope = getScope(key);
  if (scope.snapshot && Date.now() - scope.snapshotAt < SNAPSHOT_TTL_MS) return scope.snapshot;
  if (!scope.inflight) {
    const requestGeneration = generation;
    const isCurrent = () => (
      connection === activeConnection
      && generation === requestGeneration
      && scopes.get(key) === scope
    );
    const request = fetchSnapshot(activeConnection, key)
      .then((nextSnapshot) => {
        if (!isCurrent()) return null;
        scope.snapshot = nextSnapshot;
        scope.snapshotAt = Date.now();
        return nextSnapshot;
      }, () => {
        // Keep serving the previous snapshot for this directory when there is
        // one. A reset makes the old scope unauthoritative, so it returns null.
        return isCurrent() ? scope.snapshot : null;
      })
      .finally(() => {
        // A request from before reset must not clear the replacement request.
        if (scope.inflight === request) scope.inflight = null;
      });
    scope.inflight = request;
  }
  return scope.inflight;
}

/**
 * Runtime credential and endpoint for one provider, or `null` when OpenCode
 * knows nothing about it.
 */
export async function getRuntimeProvider(providerID, directory) {
  const current = await getRuntimeProviderSnapshot(directory);
  return current?.providers.get(providerID) ?? null;
}

/**
 * A runtime provider is directly callable only when OpenCode marks it
 * connected and reports both parts of the transport. Return a fresh object so
 * one generation can retain one authoritative key/URL pair.
 */
export function getRuntimeProviderTransportFromSnapshot(snapshot, providerID) {
  if (!snapshot?.connected?.has(providerID)) return null;
  const provider = snapshot.providers?.get(providerID);
  if (!provider?.apiKey || !provider.baseURL) return null;
  return Object.freeze({
    providerID,
    apiKey: provider.apiKey,
    baseURL: provider.baseURL,
  });
}

export async function getRuntimeProviderTransport(providerID, directory) {
  const current = await getRuntimeProviderSnapshot(directory);
  return getRuntimeProviderTransportFromSnapshot(current, providerID);
}
