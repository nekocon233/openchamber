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

export const cliproxyapiProxySchema = z.object({ upstreamProxy: upstreamProxySchema.nullable() });
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
  now,
}) => {
  const store = createCliproxyapiStore({ dataDir });
  const gateway = createCliproxyapiGateway({ store, binaryManager, dataDir, buildEnv, spawnProcess, terminateProcess, fetchImpl, now });
  const baseURLOf = (document) => `http://127.0.0.1:${document.port}`;
  const clientFor = (document) => createCliproxyapiClient({
    baseURL: baseURLOf(document),
    managementKey: document.managementKey,
    fetchImpl,
  });
  let restarting = false;

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

  return {
    store,
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

    async beginLogin() {
      const document = await store.read();
      if (!await clientFor(document).reachable().catch(() => false)) throw notRunning();
      return clientFor(document).beginLogin();
    },
    async loginStatus(state) {
      return clientFor(await store.read()).loginStatus(state);
    },
    async cancelLogin(state) {
      return { cancelled: await clientFor(await store.read()).cancelLogin(state) };
    },
    async removeAccount(name) {
      const gatewayClient = clientFor(await store.read());
      const accounts = await gatewayClient.accounts();
      // The name arrives from a client; only a credential the gateway lists may go.
      if (!accounts.some((entry) => entry.name === name)) {
        throw new NativeAgentError('That account is not one this gateway reports', { status: 404, code: 'CLIPROXYAPI_ACCOUNT_UNKNOWN' });
      }
      await gatewayClient.removeAccount(name);
    },

    /** What the gateway serves, paired with the metadata this machine knows. */
    async listModels() {
      const document = await store.read();
      const served = await clientFor(document).models(document.clientKeys[0] ?? null);
      const metadata = await readModelMetadata();
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
      const parsed = cliproxyapiImportSchema.parse(input ?? {});
      const document = await store.read();
      const { models, unknown } = await this.listModels();
      if (models.length === 0) {
        throw new NativeAgentError('The gateway serves no model this computer knows about', { status: 409, code: 'CLIPROXYAPI_NO_MODELS' });
      }
      const existing = await connections.connectionFor(baseURLOf(document));
      const saved = await this.saveConnection({
        connectionId: parsed.connectionId ?? existing?.id ?? null,
        name: existing?.name ?? 'CLIProxyAPI',
        models: models.map((model) => ({
          id: randomUUID(),
          name: model.name,
          modelID: model.id,
          contextWindow: model.contextWindow,
          outputLimit: model.outputLimit,
          input: { image: model.image, pdf: false },
          efforts: model.efforts,
        })),
      });
      return { connection: saved, imported: models.length, skipped: unknown.length };
    },

    /** Creates or updates the Claude Code connection that points at this gateway. */
    async saveConnection(input) {
      const parsed = cliproxyapiConnectionSchema.parse(input);
      const document = await ensureClientKey();
      const baseURL = baseURLOf(document);
      // A connection that already points here is updated, so a second twin with
      // the same name and endpoint cannot appear in the model picker.
      const connectionId = parsed.connectionId ?? (await connections.connectionFor(baseURL))?.id ?? null;
      return connections.save(connectionId, connectionWriteSchema.parse({
        kind: 'anthropic',
        name: parsed.name,
        baseURL,
        auth: 'api-key',
        apiKey: document.clientKeys[0],
        models: parsed.models,
      }));
    },
  };
};
