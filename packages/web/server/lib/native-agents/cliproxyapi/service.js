import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { NativeAgentError } from '../errors.js';
import { connectionModelSchema, connectionWriteSchema, endpointURLSchema } from '../claude/connections.js';
import { DEFAULT_CLIPROXYAPI_BASE_URL, LOGIN_WINDOW_MS, createCliproxyapiClient } from './client.js';

const documentSchema = z.object({
  version: z.literal(1),
  baseURL: z.string().min(1),
  managementKey: z.string().min(1),
  /** The client key this server added to the gateway, kept so it can take it back. */
  managedClientKey: z.string().min(1).nullish(),
});

export const cliproxyapiKeySchema = z.object({
  baseURL: endpointURLSchema,
  managementKey: z.string().trim().min(1).max(4096),
});

const clientKeySchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('existing'), index: z.number().int().nonnegative() }),
  z.object({ source: z.literal('added') }),
  z.object({ source: z.literal('typed'), value: z.string().trim().min(1).max(8192) }),
]);
export const cliproxyapiConnectionSchema = z.object({
  connectionId: z.string().uuid().nullable().default(null),
  name: z.string().trim().min(1).max(120),
  models: z.array(connectionModelSchema).min(1).max(50),
  clientKey: clientKeySchema,
});

const notConfigured = () => new NativeAgentError(
  'Connect the local CLIProxyAPI gateway on the server computer first',
  { status: 409, code: 'CLIPROXYAPI_NOT_CONFIGURED' },
);

export const createCliproxyapiService = ({ dataDir, connections, fetchImpl = fetch }) => {
  const directory = path.join(dataDir, 'native-agents');
  const file = path.join(directory, 'cliproxyapi.json');
  let writes = Promise.resolve();

  const read = async () => {
    try {
      const parsed = documentSchema.safeParse(JSON.parse(await fs.readFile(file, 'utf8')));
      if (!parsed.success) throw new NativeAgentError('Could not read the CLIProxyAPI settings', { status: 500, code: 'CLIPROXYAPI_STORE_READ_FAILED' });
      return parsed.data;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (error instanceof NativeAgentError) throw error;
      throw new NativeAgentError('Could not read the CLIProxyAPI settings', { status: 500, code: 'CLIPROXYAPI_STORE_READ_FAILED' });
    }
  };

  /** Serialized read-modify-write; the gateway secret never leaves this module. */
  const mutate = (change) => {
    const next = writes.then(async () => {
      const document = change(await read());
      if (document === null) {
        await fs.rm(file, { force: true });
        return null;
      }
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(document), { mode: 0o600 });
      await fs.rename(temporary, file);
      return document;
    });
    writes = next.then(() => {}, () => {});
    return next;
  };

  const gatewayClient = (stored) => createCliproxyapiClient({ baseURL: stored.baseURL, managementKey: stored.managementKey, fetchImpl });

  const configured = async () => {
    const stored = await read();
    if (!stored) throw notConfigured();
    return stored;
  };

  const resolveClientKey = async (gateway, stored, choice) => {
    if (choice.source === 'typed') return choice.value;
    const keys = await gateway.clientKeys();
    if (choice.source === 'existing') {
      const key = keys[choice.index];
      if (key === undefined) throw new NativeAgentError('That gateway key is no longer listed', { status: 404, code: 'CLIPROXYAPI_CLIENT_KEY_UNKNOWN' });
      return key;
    }
    const key = randomBytes(32).toString('hex');
    await gateway.setClientKeys([...keys, key]);
    await mutate((current) => ({ ...current, managedClientKey: key }));
    return key;
  };

  return {
    /** Everything the settings section renders; the management key stays out. */
    async status() {
      const stored = await read();
      await writes;
      const baseURL = stored?.baseURL ?? DEFAULT_CLIPROXYAPI_BASE_URL;
      // With nothing stored the same probe still separates a gateway whose
      // management API is off (404) from one that is merely waiting for a key
      // (401), so the section can name the right problem before anything is saved.
      const gateway = createCliproxyapiClient({ baseURL, managementKey: stored?.managementKey ?? '', fetchImpl });
      const state = { configured: stored !== null, baseURL, reachable: true, managementEnabled: false, keyRejected: false, accounts: [], clientKeys: [] };
      if (!await gateway.reachable()) return { ...state, reachable: false };
      try {
        const [accounts, keys] = await Promise.all([gateway.accounts(), gateway.clientKeys()]);
        return {
          ...state,
          managementEnabled: true,
          accounts,
          clientKeys: keys.map((key) => ({ hint: key.slice(-4), length: key.length })),
        };
      } catch (error) {
        if (error?.code === 'CLIPROXYAPI_MANAGEMENT_DISABLED') return state;
        // A stored key that stopped working is the only rejected key worth naming.
        if (error?.code === 'CLIPROXYAPI_KEY_REJECTED') return { ...state, managementEnabled: true, keyRejected: stored !== null };
        throw error;
      }
    },

    /** A rejected candidate never replaces a working stored key. */
    async saveKey(input) {
      const parsed = cliproxyapiKeySchema.parse(input);
      await createCliproxyapiClient({ ...parsed, fetchImpl }).accounts();
      const stored = await read();
      // A key belonging to another gateway cannot be taken back from this one.
      const managedClientKey = stored?.baseURL === parsed.baseURL ? stored.managedClientKey ?? null : null;
      await mutate(() => ({ version: 1, baseURL: parsed.baseURL, managementKey: parsed.managementKey, managedClientKey }));
      return { baseURL: parsed.baseURL, managedClientKey: managedClientKey !== null };
    },

    /** Forgets the stored secrets, taking back a key this server added. */
    async forgetKey() {
      const stored = await read();
      if (stored === null) return { forgotten: false, clientKeyRemoved: false };
      let clientKeyRemoved = false;
      if (stored.managedClientKey !== null && stored.managedClientKey !== undefined) {
        // The gateway needs the management key for this, so a failure keeps the
        // store and the caller can retry the removal.
        const gateway = gatewayClient(stored);
        const keys = await gateway.clientKeys();
        if (keys.includes(stored.managedClientKey)) {
          await gateway.setClientKeys(keys.filter((key) => key !== stored.managedClientKey));
          clientKeyRemoved = true;
        }
      }
      await mutate(() => null);
      return { forgotten: true, clientKeyRemoved };
    },

    async beginLogin() {
      const attempt = await gatewayClient(await configured()).beginLogin();
      return { ...attempt, expiresAt: Date.now() + LOGIN_WINDOW_MS };
    },

    async loginStatus(state) {
      return gatewayClient(await configured()).loginStatus(state);
    },

    async cancelLogin(state) {
      return { cancelled: await gatewayClient(await configured()).cancelLogin(state) };
    },

    async removeAccount(name) {
      const gateway = gatewayClient(await configured());
      const accounts = await gateway.accounts();
      // The name arrives from a client; only a credential the gateway lists may go.
      if (!accounts.some((entry) => entry.name === name)) {
        throw new NativeAgentError('That account is not one this gateway reports', { status: 404, code: 'CLIPROXYAPI_ACCOUNT_UNKNOWN' });
      }
      await gateway.removeAccount(name);
    },

    /** Creates or updates the Claude Code connection that points at this gateway. */
    async saveConnection(input) {
      const parsed = cliproxyapiConnectionSchema.parse(input);
      const stored = await configured();
      const apiKey = await resolveClientKey(gatewayClient(stored), stored, parsed.clientKey);
      return connections.save(parsed.connectionId, connectionWriteSchema.parse({
        kind: 'anthropic',
        name: parsed.name,
        baseURL: stored.baseURL,
        auth: 'api-key',
        apiKey,
        models: parsed.models,
      }));
    },
  };
};
