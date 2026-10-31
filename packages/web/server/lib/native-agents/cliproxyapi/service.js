import fs from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { NativeAgentError } from '../errors.js';
import { connectionModelSchema, connectionWriteSchema } from '../claude/connections.js';
import { createCliproxyapiBinaryManager } from './binary-manager.js';
import { createCliproxyapiClient } from './client.js';
import { createCliproxyapiGateway } from './gateway.js';
import { createCliproxyapiStore, upstreamProxySchema } from './store.js';
import { readCodexModelMetadata } from './models.js';
import { isEnterpriseMode } from '../../enterprise-mode.js';
import { antigravityModelVersion, followAntigravityModels } from './family-following.js';
import { CLAUDE_ROUTE_MODELS, claudeFamilyVersion } from './claude-family-route.js';
import { createClaudeFamilyRouting } from './claude-family-routing.js';

export const cliproxyapiLoginInputSchema = z.object({ provider: z.enum(['codex', 'antigravity', 'claude']).default('codex') });
export const cliproxyapiFamilyInputSchema = z.object({ enabled: z.boolean() }).strict();
const FAMILY_DISCOVERY_TIMEOUT_MS = 2_000;

const requireProviderEntry = () => {
  if (isEnterpriseMode()) throw new NativeAgentError('Provider connections are managed by your organization', { status: 403, code: 'enterprise_mode' });
};

export const cliproxyapiProxySchema = z.object({ upstreamProxy: upstreamProxySchema.nullable() });
export const cliproxyapiCallbackSchema = z.object({ url: z.string().trim().min(1).max(8192) });
export const cliproxyapiConnectionSchema = z.object({
  connectionId: z.string().uuid().nullable().default(null),
  name: z.string().trim().min(1).max(120),
  models: z.array(connectionModelSchema).min(1).max(50),
});
export const cliproxyapiImportSchema = z.object({
  connectionId: z.string().uuid().nullable().default(null),
}).default({ connectionId: null });

const notRunning = () => new NativeAgentError(
  'Start the CLIProxyAPI gateway on the server computer first',
  { status: 409, code: 'CLIPROXYAPI_NOT_INSTALLED' },
);

const callbackInvalid = (message) => new NativeAgentError(message, {
  status: 400, code: 'CLIPROXYAPI_LOGIN_CALLBACK_INVALID',
});
const callbackMismatch = () => new NativeAgentError(
  'The pasted address belongs to a different sign-in attempt',
  { status: 400, code: 'CLIPROXYAPI_LOGIN_CALLBACK_MISMATCH' },
);

/**
 * The authorization code inside the browser's callback address. The address is
 * read for its query and never fetched: a browser running on another computer
 * cannot reach the gateway's loopback listener, so the code travels to the
 * gateway through its management API instead.
 */
const readCallbackCode = (url, state) => {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw callbackInvalid('The pasted text is not a callback address');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw callbackInvalid('The pasted text is not a callback address');
  }
  if (parsed.searchParams.get('state') !== state) throw callbackMismatch();
  const denial = parsed.searchParams.get('error') ?? parsed.searchParams.get('error_description');
  if (denial !== null && denial !== '') throw callbackInvalid(`The sign-in was denied: ${denial}`);
  const code = parsed.searchParams.get('code');
  if (code === null || code === '') throw callbackInvalid('The pasted address carries no authorization code');
  return code;
};

const keyHints = (keys) => keys.map((key) => ({ hint: key.slice(-4), length: key.length }));

/**
 * The managed gateway: one store, one supervised process, and the flows the
 * provider section drives. OpenChamber generates the management key, so no
 * route ever carries one.
 */
export const createCliproxyapiService = ({
  dataDir,
  connections,
  fetchImpl = fetch,
  binaryManager = createCliproxyapiBinaryManager({ dataDir }),
  readModelMetadata = readCodexModelMetadata,
  buildEnv = () => ({}),
  spawnProcess,
  terminateProcess,
  now = Date.now,
  onModelsUpdated = () => {},
}) => {
  const store = createCliproxyapiStore({ dataDir });
  const gateway = createCliproxyapiGateway({ store, binaryManager, dataDir, buildEnv, spawnProcess, terminateProcess, fetchImpl, now });
  const baseURLOf = (document) => `http://127.0.0.1:${document.port}`;
  const clientFor = (document, signal = null) => createCliproxyapiClient({
    baseURL: baseURLOf(document),
    managementKey: document.managementKey,
    fetchImpl,
    signal,
  });
  const familyRouting = createClaudeFamilyRouting({ store, connections, clientFor, onModelsUpdated });
  let restarting = false;
  const loginAttempts = new Map();
  const requireAttempt = (state) => {
    const attempt = loginAttempts.get(state);
    if (!attempt || attempt.expiresAt <= now()) {
      loginAttempts.delete(state);
      throw new NativeAgentError('This sign-in attempt expired. Start sign-in again.', { status: 409, code: 'CLIPROXYAPI_LOGIN_CALLBACK_REJECTED' });
    }
    return attempt;
  };

  /** Cheap enough for a status poll: a stat, never a subprocess. */
  const installInfo = async () => {
    let paths;
    try {
      paths = binaryManager.getPaths();
    } catch (error) {
      return { supported: false, prepared: false, target: null, version: binaryManager.version, path: null, error: error.message };
    }
    const prepared = await fs.stat(paths.binaryPath).then((stats) => stats.isFile()).catch(() => false);
    return {
      supported: true,
      prepared,
      target: paths.target,
      version: binaryManager.version,
      path: prepared ? paths.binaryPath : null,
      error: null,
    };
  };

  /** The running gateway must serve exactly the keys the store holds. */
  const syncClientKeys = async (document) => {
    const gatewayClient = clientFor(document);
    const served = await gatewayClient.accounts().then(() => gatewayClient.clientKeys()).catch(() => null);
    if (served === null || served.join('\n') === document.clientKeys.join('\n')) return;
    await gatewayClient.setClientKeys(document.clientKeys);
  };

  const ensureClientKey = async () => {
    const document = await store.read();
    if (document.clientKeys.length > 0) return document;
    // Carry over the key of a connection that already points at this gateway.
    const adopted = await connections.credentialKeyFor(`http://127.0.0.1:${document.port}`);
    return store.update((current) => ({
      ...current,
      clientKeys: [adopted ?? randomBytes(32).toString('hex')],
    }));
  };

  // Imports, saves and account removals share this queue. A late import must
  // not restore models pruned by logout or recreate the first connection twice.
  let connectionWrites = Promise.resolve();
  const withConnectionWrite = (work) => {
    const next = connectionWrites.then(work, work);
    connectionWrites = next.catch(() => undefined);
    return next;
  };
  const writeConnection = async (input) => {
    requireProviderEntry();
    const parsed = cliproxyapiConnectionSchema.parse(input);
    const document = await ensureClientKey();
    const baseURL = baseURLOf(document);
    const connectionId = parsed.connectionId ?? (await connections.connectionFor(baseURL))?.id ?? null;
    return connections.save(connectionId, connectionWriteSchema.parse({
      kind: 'anthropic', name: parsed.name, baseURL, auth: 'api-key',
      apiKey: document.clientKeys[0], models: parsed.models,
    }));
  };

  const providerMetadata = async (document, served, signal = null, channel = 'antigravity') => {
    const metadata = new Map();
    const availableIds = new Set();
    if (!served.some((id) => id.startsWith('claude-'))) return { metadata, availableIds, accounts: [] };
    const gatewayClient = clientFor(document, signal);
    const accounts = (await gatewayClient.accounts()).filter((account) => account.provider === channel && !account.disabled);
    if (accounts.length === 0) return { metadata, availableIds, accounts };
    const [definitions, accountModels] = await Promise.all([
      gatewayClient.modelMetadata(channel),
      Promise.all(accounts.map((account) => gatewayClient.accountModelIds(account.name))),
    ]);
    const servedIds = new Set(served);
    for (const id of accountModels.flat()) if (servedIds.has(id)) availableIds.add(id);
    for (const [id, model] of definitions) {
      if (id.startsWith('claude-') && availableIds.has(id)) metadata.set(id, model);
    }
    return { metadata, availableIds, accounts };
  };

  // Share only overlapping checks. There is no background poll or freshness
  // cache: each later catalog load or followed-model send checks the gateway.
  let followingRefresh = null;
  const refreshBindings = async () => {
      if (isEnterpriseMode()) return false;
      const saved = await connections.list();
      const document = await store.read();
      if (!document.claudeRoutes && !saved.some((connection) => connection.models.some((model) => model.followFamily))) return false;
      if (!document.enabled) return false;
      const previous = saved.find((connection) => connection.baseURL === baseURLOf(document));
      if (!previous || (!document.claudeRoutes && !previous.models.some((model) => model.followFamily))) return false;
      let discovered;
      let primary = new Map();
      let accounts = [];
      try {
        const signal = AbortSignal.timeout(FAMILY_DISCOVERY_TIMEOUT_MS);
        const served = await clientFor(document, signal).models(document.clientKeys[0] ?? null);
        if (document.claudeRoutes) {
          const results = await Promise.allSettled([
            providerMetadata(document, served, signal), providerMetadata(document, served, signal, 'claude'),
          ]);
          discovered = { metadata: new Map(), availableIds: new Set(), accounts: [] };
          if (results[0].status === 'fulfilled') discovered = results[0].value;
          if (results[1].status === 'fulfilled') primary = results[1].value.metadata;
          accounts = results.flatMap((result) => result.status === 'fulfilled' ? result.value.accounts : []);
          for (const result of results) if (result.status === 'rejected') console.warn(
            '[native-agents] Could not refresh one Claude source; keeping its saved binding',
            result.reason instanceof NativeAgentError ? result.reason.code : 'discovery-failed',
          );
          if (results.every((result) => result.status === 'rejected')) return false;
        } else {
          discovered = await providerMetadata(document, served, signal);
          signal.throwIfAborted();
        }
      } catch (error) {
        console.warn('[native-agents] Could not check gateway model updates; keeping saved bindings',
          error instanceof NativeAgentError ? error.code : 'discovery-failed');
        return false;
      }
      const available = [...discovered.metadata].map(([id, model]) => ({ id, ...model }));
      const models = followAntigravityModels(previous.models, available);
      if (document.claudeRoutes && await familyRouting.refresh(document, previous, models, primary, discovered.metadata, accounts)) return true;
      if (models === previous.models) return false;
      requireProviderEntry();
      const changed = await connections.refreshModelBindings(previous.id, previous.revision, models);
      if (changed) onModelsUpdated();
      return changed;
  };
  const refreshFollowedModels = () => {
    if (followingRefresh) return followingRefresh;
    followingRefresh = withConnectionWrite(refreshBindings).finally(() => { followingRefresh = null; });
    return followingRefresh;
  };

  const resolveConnection = async (modelID, effort = null) => {
    let launch = await connections.resolve(modelID, effort);
    const legacyFamily = ['opus', 'sonnet'].find((family) => modelID === family || modelID === `${family}[1m]`);
    if (!legacyFamily && !launch.descriptor?.followFamily && !Object.values(CLAUDE_ROUTE_MODELS).includes(launch.model)) return launch;
    let document = await store.read();
    const managed = launch.env?.ANTHROPIC_BASE_URL === baseURLOf(document);
    const configured = legacyFamily && document.claudeRoutes?.[legacyFamily];
    if ((document.claudeRoutes && !isEnterpriseMode() && (configured || managed)) || (managed && launch.descriptor?.followFamily)) {
      await refreshFollowedModels();
      document = await store.read();
    }
    const route = legacyFamily ? document.claudeRoutes?.[legacyFamily] : null;
    if (route && !isEnterpriseMode()) {
      const connection = (await connections.list()).find((entry) => entry.id === document.claudeRoutes.connectionId && entry.baseURL === baseURLOf(document));
      if (connection?.models.some((model) => model.id === route.modelId && model.modelID === CLAUDE_ROUTE_MODELS[legacyFamily])) {
        modelID = `connection:${connection.id}:${route.modelId}`;
      } else if (route.claude && route.antigravity) {
        throw new NativeAgentError('The managed Claude model connection is unavailable. Check its connection settings.', { status: 404, code: 'NATIVE_CONNECTION_UNAVAILABLE' });
      }
    }
    launch = await connections.resolve(modelID, effort);
    if (Object.values(CLAUDE_ROUTE_MODELS).includes(launch.model)) requireProviderEntry();
    return launch;
  };

  const setFamilyRoute = async (family, input) => {
    const { enabled } = cliproxyapiFamilyInputSchema.parse(input);
    await withConnectionWrite(async () => {
      const previous = await store.read();
      await familyRouting.request(family, enabled);
      try {
        await refreshBindings();
      } catch (error) {
        if (enabled && !previous.claudeRoutes?.[family] && !(error instanceof NativeAgentError && error.code === 'CLIPROXYAPI_OPUS_ROLLBACK_FAILED')) {
          await store.update((current) => {
            if (!current.claudeRoutes) return current;
            const remaining = { ...current.claudeRoutes, [family]: null };
            return { ...current, claudeRoutes: remaining.opus || remaining.sonnet ? remaining : null };
          });
        }
        throw error;
      }
    });
  };

  return {
    store,
    refreshFollowedModels,
    resolveConnection,
    async catalog() {
      await refreshFollowedModels();
      const models = await connections.catalog();
      const document = await store.read();
      if (isEnterpriseMode()) return models.filter((model) => !Object.values(CLAUDE_ROUTE_MODELS).includes(model.modelID));
      const routes = document.claudeRoutes;
      if (!routes || !(await connections.list()).some((connection) => connection.id === routes.connectionId && connection.baseURL === baseURLOf(document))) return models;
      const selected = new Map();
      for (const family of ['opus', 'sonnet']) {
        const route = routes[family];
        if (!route) continue;
        const id = `connection:${routes.connectionId}:${route.modelId}`;
        if (models.some((model) => model.id === id && model.modelID === CLAUDE_ROUTE_MODELS[family])) selected.set(family, id);
      }
      return models.filter((model) => !selected.has(model.id)).map((model) => {
        const family = [...selected].find(([, id]) => id === model.id)?.[0];
        return family ? { ...model, aliases: [{ id: family }, { id: `${family}[1m]` }] } : model;
      });
    },
    async setOpusRoute(input) {
      await setFamilyRoute('opus', input);
      return this.status();
    },
    async setSonnetRoute(input) {
      await setFamilyRoute('sonnet', input);
      return this.status();
    },
    async resume() {
      return gateway.resume();
    },
    async start() {
      await ensureClientKey();
      await gateway.start();
      await syncClientKeys(await store.read());
      return this.status();
    },
    async stop() {
      await gateway.stop();
      return this.status();
    },
    /**
     * Terminal stop for a host shutdown: the process goes, the switch stays
     * on, so the next boot resumes it instead of pretending a person stopped it.
     */
    async shutdown() {
      loginAttempts.clear();
      await gateway.stop({ persist: false });
    },
    async setUpstreamProxy(input) {
      const parsed = cliproxyapiProxySchema.parse(input);
      await store.update((current) => ({ ...current, upstreamProxy: parsed.upstreamProxy }));
      // The gateway reads its config at startup only.
      if (gateway.isRunning()) {
        restarting = true;
        try {
          await gateway.restart();
        } finally {
          restarting = false;
        }
      }
      return this.status();
    },
    async status() {
      const document = await store.read();
      const routes = document.claudeRoutes;
      const routedConnection = routes ? (await connections.list()).find((connection) => connection.id === routes.connectionId && connection.baseURL === baseURLOf(document)) : null;
      const familyStatus = (family) => {
        const route = routes?.[family];
        return { enabled: Boolean(route), ready: Boolean(route?.claude && route.antigravity
          && routedConnection?.models.some((model) => model.id === route.modelId && model.modelID === CLAUDE_ROUTE_MODELS[family])) };
      };
      const baseURL = `http://127.0.0.1:${document.port}`;
      const owned = gateway.status();
      const state = {
        configured: true,
        enabled: document.enabled,
        running: owned.running,
        ready: false,
        baseURL,
        port: document.port,
        authDir: document.authDir,
        upstreamProxy: document.upstreamProxy,
        installedVersion: document.installedVersion,
        runningVersion: owned.version,
        install: await installInfo(),
        managementEnabled: false,
        keyRejected: false,
        accounts: [],
        loginProviders: ['codex', 'antigravity', 'claude'],
        opusFailover: familyStatus('opus'),
        sonnetFailover: familyStatus('sonnet'),
        clientKeys: keyHints(document.clientKeys),
        lastError: owned.lastError,
        restarting,
        connection: await connections.connectionFor(baseURL).catch(() => null),
      };
      const gatewayClient = clientFor(document);
      if (!await gatewayClient.reachable().catch(() => false)) return state;
      try {
        const [accounts, keys] = await Promise.all([gatewayClient.accounts(), gatewayClient.clientKeys()]);
        return { ...state, ready: true, managementEnabled: true, accounts, clientKeys: keys.map((key) => ({ hint: key.slice(-4), length: key.length })) };
      } catch (error) {
        if (error?.code === 'CLIPROXYAPI_MANAGEMENT_DISABLED') return { ...state, ready: true };
        if (error?.code === 'CLIPROXYAPI_KEY_REJECTED') return { ...state, ready: true, managementEnabled: true, keyRejected: true };
        throw error;
      }
    },

    async beginLogin(input = {}) {
      requireProviderEntry();
      const { provider } = cliproxyapiLoginInputSchema.parse(input);
      for (const [state, attempt] of loginAttempts) if (attempt.expiresAt <= now()) loginAttempts.delete(state);
      if (loginAttempts.size >= 32) throw new NativeAgentError('Cancel an existing sign-in before starting another', { status: 409, code: 'CLIPROXYAPI_LOGIN_BUSY' });
      const document = await store.read();
      if (!await clientFor(document).reachable().catch(() => false)) throw notRunning();
      const started = await clientFor(document).beginLogin(provider);
      loginAttempts.set(started.state, { provider, expiresAt: now() + 10 * 60_000 });
      return started;
    },
    async loginStatus(state) {
      requireAttempt(state);
      return clientFor(await store.read()).loginStatus(state);
    },
    async cancelLogin(state) {
      requireAttempt(state);
      const cancelled = await clientFor(await store.read()).cancelLogin(state);
      if (cancelled) loginAttempts.delete(state);
      return { cancelled };
    },
    /** Hands a pasted browser callback to the running gateway; no reachability pre-check, so a stopped gateway reads as unreachable rather than uninstalled. */
    async submitLoginCallback(state, input) {
      const { url } = cliproxyapiCallbackSchema.parse(input);
      const code = readCallbackCode(url, state);
      requireProviderEntry();
      const { provider } = requireAttempt(state);
      await clientFor(await store.read()).submitLoginCallback(state, code, provider);
      return { accepted: true };
    },
    removeAccount(name) {
      return withConnectionWrite(async () => {
        const document = await store.read();
        const gatewayClient = clientFor(document);
        const accounts = await gatewayClient.accounts();
        // The name arrives from a client; only a credential the gateway lists may go.
        if (!accounts.some((entry) => entry.name === name)) {
          throw new NativeAgentError('That account is not one this gateway reports', { status: 404, code: 'CLIPROXYAPI_ACCOUNT_UNKNOWN' });
        }
        await gatewayClient.removeAccount(name);
        const baseURL = baseURLOf(document);
        if (!await connections.connectionFor(baseURL)) return;
        // The remaining accounts may still serve the same models. Never infer
        // availability from model-name prefixes, and never treat a failed read
        // as an empty catalog. Removal remains allowed under enterprise policy.
        const served = await gatewayClient.models(document.clientKeys[0] ?? null);
        const previous = (await connections.list()).find((connection) => connection.baseURL === baseURL);
        const families = new Set();
        if (previous?.models.some((model) => model.followFamily)) {
          const { availableIds } = await providerMetadata(document, served);
          for (const id of availableIds) {
            const version = antigravityModelVersion(id);
            if (version) families.add(version.family);
          }
        }
        await connections.retainModels(baseURL, served, [...families]);
        if (document.claudeRoutes && !(await connections.list()).some((connection) => connection.id === document.claudeRoutes.connectionId)) {
          await familyRouting.clear();
        }
      });
    },

    /** What the gateway serves, paired with the metadata this machine knows. */
    async listModels() {
      const document = await store.read();
      const gatewayClient = clientFor(document);
      const [served, metadata] = await Promise.all([
        gatewayClient.models(document.clientKeys[0] ?? null), readModelMetadata(),
      ]);
      const antigravity = await providerMetadata(document, served);
      for (const [id, model] of antigravity.metadata) metadata.set(id, model);
      const models = [];
      const unknown = [];
      for (const id of served) {
        const known = metadata.get(id);
        if (known === undefined) unknown.push(id);
        else models.push({ id, ...known });
      }
      return { models, unknown };
    },

    /**
     * Writes every model this machine knows about into the gateway's connection,
     * replacing whatever it listed before and updating the existing connection
     * rather than adding a twin.
     */
    async importModels(input) {
      return withConnectionWrite(async () => {
        requireProviderEntry();
        const parsed = cliproxyapiImportSchema.parse(input ?? {});
        const document = await store.read();
        const { models, unknown } = await this.listModels();
        if (models.length === 0) {
          throw new NativeAgentError('The gateway serves no model this computer knows about', { status: 409, code: 'CLIPROXYAPI_NO_MODELS' });
        }
        const existing = await connections.connectionFor(baseURLOf(document));
        const connectionId = parsed.connectionId ?? existing?.id ?? null;
        const previous = connectionId === null ? null : (await connections.list()).find((connection) => connection.id === connectionId);
        const previousModels = new Map((previous?.models ?? []).filter((model) => !model.followFamily).map((model) => [model.modelID, model]));
        const unified = document.claudeRoutes && document.claudeRoutes.connectionId === previous?.id;
        const followed = followAntigravityModels(previous?.models ?? [], models).filter((model) => model.followFamily);
        const followedFamilies = new Set(followed.map((model) => model.followFamily));
        const importedModels = models.filter((model) => {
          const family = claudeFamilyVersion(model.id)?.family;
          return (!unified || !family || !document.claudeRoutes[family] || previousModels.has(model.id))
            && (!followedFamilies.has(model.followFamily) || previousModels.has(model.id));
        }).map((model) => ({
          id: previousModels.get(model.id)?.id ?? randomUUID(),
          name: model.name, modelID: model.id,
          contextWindow: model.contextWindow, outputLimit: model.outputLimit,
          input: { image: model.image, pdf: model.pdf ?? false }, efforts: model.efforts,
        }));
        // Keep explicitly configured, still-served rows whose metadata was not
        // discovered, including GPT models when the local Codex cache is absent.
        const unknownIds = new Set(unknown);
        const retained = (previous?.models ?? []).filter((model) => !model.followFamily && unknownIds.has(model.modelID));
        const saved = await writeConnection({
          connectionId,
          name: existing?.name ?? 'CLIProxyAPI',
          models: [...followed, ...importedModels, ...retained],
        });
        await refreshBindings();
        const knownIds = new Set(models.map((model) => model.id));
        const updated = (await connections.list()).find((connection) => connection.id === saved.id);
        return { connection: updated ?? saved, imported: importedModels.length + followed.filter((model) => knownIds.has(model.modelID)).length, skipped: unknown.length };
      });
    },

    /** Creates or updates the Claude Code connection that points at this gateway. */
    saveConnection(input) {
      return withConnectionWrite(() => writeConnection(input));
    },
  };
};
