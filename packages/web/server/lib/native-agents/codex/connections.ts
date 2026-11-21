import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import type { JsonValue } from '../../shared/json-values.js';
import { NativeAgentError } from '../errors.js';

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
  status: 404,
  code: 'NATIVE_CONNECTION_UNAVAILABLE',
});

const CONNECTION_MODEL_PREFIX = 'codex-connection:';

export type CodexConnectionModel = z.infer<typeof connectionModelSchema>;
export type CodexConnectionWrite = z.infer<typeof codexConnectionWriteSchema>;
export type StoredCodexConnection = z.infer<typeof storedConnectionSchema>;
export type PublicCodexConnection = Omit<StoredCodexConnection, 'apiKey'> & { hasKey: boolean };

export interface CodexConnectionCatalogModel extends CodexConnectionModel {
  defaultEffort: null;
  defaultEffortVariants: string[];
  fast: false;
}

export interface CodexConnectionOverrides {
  arguments: string[];
  environment: Record<string, string>;
}

export interface ResolvedCodexModel {
  key: string;
  model: string;
  providerId: string | null;
}

export const codexProviderId = (connection: { id: string }): string => `codexconn-${connection.id}`;

export const codexProviderEnvKey = (connection: { id: string }): string => `CODEX_CONN_${connection.id.replaceAll('-', '_')}`;

const tomlString = (value: string): string => {
  const escaped = value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t');
  return `"${escaped}"`;
};

export const codexProviderArguments = (
  connections: ReadonlyArray<{ id: string; name: string; baseURL: string }>,
): string[] => connections.flatMap((connection) => {
  const prefix = `model_providers.${codexProviderId(connection)}`;
  return [
    '-c', `${prefix}.name=${tomlString(connection.name)}`,
    '-c', `${prefix}.base_url=${tomlString(connection.baseURL)}`,
    '-c', `${prefix}.env_key=${tomlString(codexProviderEnvKey(connection))}`,
    '-c', `${prefix}.wire_api="responses"`,
    '-c', `${prefix}.requires_openai_auth=false`,
  ];
});

const codexProviderEnvironment = (
  connections: ReadonlyArray<{ id: string; apiKey: string }>,
): Record<string, string> => Object.fromEntries(
  connections.map((connection) => [codexProviderEnvKey(connection), connection.apiKey]),
);

const codexConnectionModels = (connection: StoredCodexConnection): CodexConnectionCatalogModel[] => connection.models.map((model) => ({
  ...model,
  id: `${CONNECTION_MODEL_PREFIX}${connection.id}:${model.id}`,
  name: `${connection.name} / ${model.name}`,
  defaultEffort: null,
  defaultEffortVariants: ['default'],
  fast: false,
}));

const publicConnection = ({ apiKey, ...connection }: StoredCodexConnection): PublicCodexConnection => ({
  ...connection,
  hasKey: Boolean(apiKey),
});

export const createCodexConnections = ({ dataDir }: { dataDir: string }) => {
  const directory = path.join(dataDir, 'native-agents');
  const file = path.join(directory, 'codex-connections.json');
  let writes = Promise.resolve();
  const read = async (): Promise<StoredCodexConnection[]> => {
    try {
      return documentSchema.parse(JSON.parse(await fs.readFile(file, 'utf8'))).connections;
    } catch (error) {
      if (fileErrorSchema.safeParse(error).data?.code === 'ENOENT') return [];
      throw new NativeAgentError('Could not read Codex connections', { status: 500, code: 'NATIVE_CONNECTION_READ_FAILED' });
    }
  };
  const mutate = <Result>(change: (connections: StoredCodexConnection[]) => Result): Promise<Result> => {
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
    writes = next.then(() => undefined, () => undefined);
    return next;
  };
  return {
    async list(): Promise<PublicCodexConnection[]> {
      await writes;
      return (await read()).map(publicConnection);
    },
    save(id: string | null, input: CodexConnectionWrite | JsonValue): Promise<PublicCodexConnection> {
      const body = codexConnectionWriteSchema.parse(input);
      return mutate((connections) => {
        const index = id === null ? -1 : connections.findIndex((entry) => entry.id === id);
        if (id !== null && index === -1) throw unavailable();
        const previous = index === -1 ? undefined : connections[index];
        const apiKey = body.apiKey ?? previous?.apiKey;
        if (!apiKey) throw new NativeAgentError('An API key is required', { status: 400, code: 'NATIVE_CONNECTION_KEY_REQUIRED' });
        const connection: StoredCodexConnection = {
          ...body,
          apiKey,
          id: previous?.id ?? randomUUID(),
          revision: (previous?.revision ?? 0) + 1,
        };
        if (index === -1) connections.push(connection);
        else connections[index] = connection;
        return publicConnection(connection);
      });
    },
    remove(id: string): Promise<{ deleted: true }> {
      return mutate((connections) => {
        const index = connections.findIndex((entry) => entry.id === id);
        if (index === -1) throw unavailable();
        connections.splice(index, 1);
        return { deleted: true as const };
      });
    },
    async catalog(): Promise<CodexConnectionCatalogModel[]> {
      await writes;
      return (await read()).flatMap(codexConnectionModels);
    },
    async launch(): Promise<CodexConnectionOverrides> {
      await writes;
      const connections = await read();
      return { arguments: codexProviderArguments(connections), environment: codexProviderEnvironment(connections) };
    },
    async resolve(modelID: string): Promise<ResolvedCodexModel> {
      if (!modelID.startsWith(CONNECTION_MODEL_PREFIX)) return { key: 'default', model: modelID, providerId: null };
      await writes;
      for (const connection of await read()) {
        const index = codexConnectionModels(connection).findIndex((model) => model.id === modelID);
        if (index === -1) continue;
        const model = connection.models[index];
        if (!model) continue;
        return { key: `${connection.id}:${connection.revision}:${model.id}`, model: model.modelID, providerId: codexProviderId(connection) };
      }
      throw unavailable();
    },
  };
};
