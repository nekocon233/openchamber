// Codex CLI custom connections: named OpenAI-compatible providers that
// OpenChamber injects into the `codex app-server` process it owns. The user's
// `~/.codex/config.toml` and the terminal's own Codex are never touched, so a
// connection exists only inside OpenChamber sessions.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { NativeAgentError } from '../errors.js';

// The reasoning efforts Codex advertises today; each model lists the subset it
// accepts. An empty list means the model runs at its own default.
const effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const connectionModelSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  modelID: z.string().trim().min(1).max(200),
  contextWindow: z.number().int().min(1024).max(10_000_000),
  outputLimit: z.number().int().min(1).max(1_000_000),
  input: z.object({ image: z.boolean(), pdf: z.boolean() }),
  efforts: z.array(effort).max(6),
});
const baseURL = z.string().url().max(2048).refine((value) => {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
}, 'Use an HTTP(S) endpoint without credentials, query or fragment');
export const codexConnectionWriteSchema = z.object({
  kind: z.literal('openai-responses').default('openai-responses'),
  name: z.string().trim().min(1).max(120),
  baseURL,
  apiKey: z.string().trim().min(1).max(8192).optional(),
  models: z.array(connectionModelSchema).min(1).max(50).refine((models) => new Set(models.map((model) => model.id)).size === models.length),
});
const storedConnectionSchema = codexConnectionWriteSchema.extend({
  id: z.string().uuid(),
  revision: z.number().int().positive(),
  apiKey: z.string().min(1),
});
const documentSchema = z.object({ version: z.literal(1), connections: z.array(storedConnectionSchema) });
const fileErrorSchema = z.object({ code: z.string() });
const unavailable = () => new NativeAgentError('The Codex connection or model is unavailable. Select a connection in Settings.', {
  status: 404, code: 'NATIVE_CONNECTION_UNAVAILABLE',
});

const CONNECTION_MODEL_PREFIX = 'codex-connection:';

/**
 * The provider id Codex sees. It becomes a TOML bare key, so it may only use
 * `A-Za-z0-9_-`; a UUID's hyphens qualify.
 * @param {{ id: string }} connection
 */
export const codexProviderId = (connection) => `codexconn-${connection.id}`;

/**
 * The environment variable carrying one connection's key. `buildCliChildEnv`
 * strips `OPENCHAMBER_*` from the child, so the name must not use that prefix.
 * @param {{ id: string }} connection
 */
export const codexProviderEnvKey = (connection) => `CODEX_CONN_${connection.id.replaceAll('-', '_')}`;

/** A TOML basic string; `-c` parses the value part as TOML. */
const tomlString = (value) => {
  const escaped = value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t');
  return `"${escaped}"`;
};

/**
 * The `-c` overrides declaring every connection as a Codex model provider.
 * The key travels in the child environment, never here, because command-line
 * arguments are visible to other processes.
 * @param {ReadonlyArray<{ id: string, name: string, baseURL: string }>} connections
 */
export const codexProviderArguments = (connections) => connections.flatMap((connection) => {
  const prefix = `model_providers.${codexProviderId(connection)}`;
  return [
    '-c', `${prefix}.name=${tomlString(connection.name)}`,
    '-c', `${prefix}.base_url=${tomlString(connection.baseURL)}`,
    '-c', `${prefix}.env_key=${tomlString(codexProviderEnvKey(connection))}`,
    // Chat Completions was removed upstream; `responses` is the only wire API.
    '-c', `${prefix}.wire_api="responses"`,
    // The connection's own key authenticates; the ChatGPT login must not.
    '-c', `${prefix}.requires_openai_auth=false`,
  ];
});

/**
 * @param {ReadonlyArray<{ id: string, apiKey: string }>} connections
 * @returns {Record<string, string>}
 */
const codexProviderEnvironment = (connections) => Object.fromEntries(
  connections.map((connection) => [codexProviderEnvKey(connection), connection.apiKey]),
);

/**
 * The connection models as catalog entries. The id keeps the connection and
 * model identity separate from the upstream model name, so renaming either
 * does not break recorded history.
 * @param {{ id: string, name: string, models: ReadonlyArray<object> }} connection
 */
const codexConnectionModels = (connection) => connection.models.map((model) => ({
  ...model,
  id: `${CONNECTION_MODEL_PREFIX}${connection.id}:${model.id}`,
  name: `${connection.name} / ${model.name}`,
  defaultEffort: null,
  fast: false,
}));

const publicConnection = ({ apiKey, ...connection }) => ({ ...connection, hasKey: Boolean(apiKey) });

/** Credentials belong to this server, never to the UI preference mirror. */
export const createCodexConnections = ({ dataDir }) => {
  const directory = path.join(dataDir, 'native-agents');
  const file = path.join(directory, 'codex-connections.json');
  let writes = Promise.resolve();
  const read = async () => {
    try {
      return documentSchema.parse(JSON.parse(await fs.readFile(file, 'utf8'))).connections;
    } catch (error) {
      if (fileErrorSchema.safeParse(error).data?.code === 'ENOENT') return [];
      throw new NativeAgentError('Could not read Codex connections', { status: 500, code: 'NATIVE_CONNECTION_READ_FAILED' });
    }
  };
  const mutate = (change) => {
    const next = writes.then(async () => {
      const connections = await read();
      const result = change(connections);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify({ version: 1, connections }), { mode: 0o600, flag: 'wx' });
        await fs.rename(temporary, file);
      } finally {
        await fs.rm(temporary, { force: true });
      }
      return result;
    });
    writes = next.then(() => {}, () => {});
    return next;
  };
  return {
    async list() {
      await writes;
      return (await read()).map(publicConnection);
    },
    save(id, input) {
      const body = codexConnectionWriteSchema.parse(input);
      return mutate((connections) => {
        const index = id === null ? -1 : connections.findIndex((entry) => entry.id === id);
        if (id !== null && index === -1) throw unavailable();
        const previous = connections[index];
        const apiKey = body.apiKey ?? previous?.apiKey;
        if (!apiKey) throw new NativeAgentError('An API key is required', { status: 400, code: 'NATIVE_CONNECTION_KEY_REQUIRED' });
        const connection = { ...body, apiKey, id: previous?.id ?? randomUUID(), revision: (previous?.revision ?? 0) + 1 };
        if (index === -1) connections.push(connection);
        else connections[index] = connection;
        return publicConnection(connection);
      });
    },
    remove(id) {
      return mutate((connections) => {
        const index = connections.findIndex((entry) => entry.id === id);
        if (index === -1) throw unavailable();
        connections.splice(index, 1);
        return { deleted: true };
      });
    },
    async catalog() {
      await writes;
      return (await read()).flatMap(codexConnectionModels);
    },
    /** The `-c` overrides and environment the app-server starts with. */
    async launch() {
      await writes;
      const connections = await read();
      return { arguments: codexProviderArguments(connections), environment: codexProviderEnvironment(connections) };
    },
    /**
     * @param {string} modelID a catalog model id
     * @returns {Promise<{ key: string, model: string, providerId: string | null }>}
     */
    async resolve(modelID) {
      if (!modelID.startsWith(CONNECTION_MODEL_PREFIX)) return { key: 'default', model: modelID, providerId: null };
      await writes;
      for (const connection of await read()) {
        const index = codexConnectionModels(connection).findIndex((model) => model.id === modelID);
        if (index === -1) continue;
        const model = connection.models[index];
        return { key: `${connection.id}:${connection.revision}:${model.id}`, model: model.modelID, providerId: codexProviderId(connection) };
      }
      throw unavailable();
    },
  };
};
