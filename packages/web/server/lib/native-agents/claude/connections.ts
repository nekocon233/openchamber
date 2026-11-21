import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { claudeLaunchModel, claudeModels } from '../catalog.js';
import type { NativeCatalogModel } from '../catalog.js';
import { NativeAgentError } from '../errors.js';
import type { JsonValue } from '../../shared/json-values.js';
import { fetchKimiQuota, isKimiCodingEndpoint } from '../../quota/providers/kimi.js';
import { buildResult } from '../../quota/utils/index.js';
import type { QuotaResult } from '../../quota/utils/contracts.js';

const effortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
const CLAUDE_CODE_EFFECTIVE_OUTPUT_LIMIT = 128_000;
const MIN_AUTO_COMPACT_WINDOW = 32_000;
const COMPACT_OUTPUT_LIMIT = 65_536;

const connectionModelSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  modelID: z.string().trim().min(1).max(200),
  contextWindow: z.number().int().min(1024).max(10_000_000),
  outputLimit: z.number().int().min(1).max(1_000_000),
  input: z.object({ image: z.boolean(), pdf: z.boolean() }),
  efforts: z.array(effortSchema).max(5),
});
const connectionModelsSchema = z.array(connectionModelSchema).min(1).max(50)
  .refine((models) => new Set(models.map((model) => model.id)).size === models.length);
const endpointURLSchema = z.string().url().max(2048).refine((value) => {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
}, 'Use an HTTP(S) endpoint without credentials, query or fragment');

export const connectionWriteSchema = z.object({
  kind: z.literal('anthropic').default('anthropic'),
  name: z.string().trim().min(1).max(120),
  baseURL: endpointURLSchema,
  auth: z.enum(['api-key', 'bearer']),
  apiKey: z.string().trim().min(1).max(8192).optional(),
  models: connectionModelsSchema,
});

const storedConnectionSchema = connectionWriteSchema.extend({
  id: z.string().uuid(),
  revision: z.number().int().positive(),
  apiKey: z.string().min(1),
});
const documentSchema = z.object({ version: z.literal(1), connections: z.array(storedConnectionSchema) });
const fileErrorSchema = z.object({ code: z.string() });

export type ClaudeConnectionModel = z.infer<typeof connectionModelSchema>;
export type ClaudeConnectionWriteInput = z.input<typeof connectionWriteSchema>;
export type StoredClaudeConnection = z.infer<typeof storedConnectionSchema>;
export type PublicClaudeConnection = Omit<StoredClaudeConnection, 'apiKey'> & {
  hasKey: boolean;
  quotaProviderId: string | null;
};

export type ClaudeConnectionCatalogModel = NativeCatalogModel & {
  modelID?: string;
};

export type AcquiredClaudeConnectionEnv = {
  env: Record<string, string>;
  dispose: () => void;
};

export type ClaudeConnectionLaunch = {
  key: string;
  model: string;
  env: Record<string, string> | null;
  descriptor?: ClaudeConnectionCatalogModel;
  acquire?: () => Promise<AcquiredClaudeConnectionEnv | null>;
};

export type PreparedClaudeConnection = {
  env: Record<string, string>;
  settings: string | undefined;
  dispose: () => Promise<void>;
};

export interface ClaudeConnectionsOptions {
  dataDir: string;
  fetchKimiUsage?: ((options: { apiKey: string; baseURL: string }) => Promise<QuotaResult<string | null, string | null>>) | undefined;
}

export interface ClaudeConnections {
  quota: (providerId: string) => Promise<QuotaResult<string, string>>;
  hasCredentials: () => Promise<boolean>;
  list: () => Promise<PublicClaudeConnection[]>;
  save: (id: string | null, input: JsonValue | ClaudeConnectionWriteInput) => Promise<PublicClaudeConnection>;
  remove: (id: string) => Promise<{ deleted: true }>;
  catalog: () => Promise<ClaudeConnectionCatalogModel[]>;
  resolve: (modelID: string, effort?: string | null) => Promise<ClaudeConnectionLaunch>;
}

const unavailable = (): NativeAgentError => new NativeAgentError('The Claude Code connection or model is unavailable. Select a connection in Settings.', {
  status: 404,
  code: 'NATIVE_CONNECTION_UNAVAILABLE',
});

const quotaProviderIdOf = (connection: Pick<StoredClaudeConnection, 'id' | 'baseURL'>): string | null => (
  isKimiCodingEndpoint(connection.baseURL) ? `kimi-claude:${connection.id}` : null
);

const publicConnection = ({ apiKey, ...connection }: StoredClaudeConnection): PublicClaudeConnection => ({
  ...connection,
  hasKey: Boolean(apiKey),
  quotaProviderId: quotaProviderIdOf(connection),
});

const catalogModels = (connection: StoredClaudeConnection): ClaudeConnectionCatalogModel[] => connection.models.map((model) => ({
  ...model,
  id: `connection:${connection.id}:${model.id}`,
  name: model.name,
  defaultEffort: null,
  fast: false,
}));

const claudeConnectionEnvironment = (connection: StoredClaudeConnection, model: ClaudeConnectionModel) => {
  const outputReserve = Math.min(model.outputLimit, CLAUDE_CODE_EFFECTIVE_OUTPUT_LIMIT);
  const autoCompactWindow = model.contextWindow
    ? Math.max(model.contextWindow - outputReserve, MIN_AUTO_COMPACT_WINDOW)
    : 0;
  return {
    ANTHROPIC_BASE_URL: connection.baseURL,
    ANTHROPIC_API_KEY: connection.auth === 'api-key' ? connection.apiKey : '',
    ANTHROPIC_AUTH_TOKEN: connection.auth === 'bearer' ? connection.apiKey : '',
    CLAUDE_CODE_OAUTH_TOKEN: '',
    CLAUDE_CODE_USE_BEDROCK: '0',
    CLAUDE_CODE_USE_VERTEX: '0',
    CLAUDE_CODE_USE_FOUNDRY: '0',
    ANTHROPIC_MODEL: model.modelID,
    ANTHROPIC_SMALL_FAST_MODEL: model.modelID,
    CLAUDE_CODE_SUBAGENT_MODEL: model.modelID,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model.modelID,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model.modelID,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model.modelID,
    ANTHROPIC_DEFAULT_FABLE_MODEL: model.modelID,
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: model.contextWindow ? String(model.contextWindow) : '',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: model.outputLimit ? String(model.outputLimit) : '',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: autoCompactWindow > 0 ? String(autoCompactWindow) : '',
    CLAUDE_CODE_EFFORT_LEVEL: '',
    ENABLE_TOOL_SEARCH: 'false',
  };
};

export function compactLaunchOverride(launch: ClaudeConnectionLaunch): ClaudeConnectionLaunch;
export function compactLaunchOverride(launch: ClaudeConnectionLaunch | null | undefined): ClaudeConnectionLaunch | null | undefined;
export function compactLaunchOverride(launch: ClaudeConnectionLaunch | null | undefined): ClaudeConnectionLaunch | null | undefined {
  if (!launch?.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS) return launch;
  const configured = Number(launch.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS);
  const outputLimit = Math.min(Number.isFinite(configured) && configured > 0 ? configured : COMPACT_OUTPUT_LIMIT, COMPACT_OUTPUT_LIMIT);
  if (launch.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS === String(outputLimit)) return launch;
  return {
    ...launch,
    key: `${launch.key}:compact`,
    env: { ...launch.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(outputLimit) },
  };
}

export const createClaudeConnections = ({ dataDir, fetchKimiUsage = fetchKimiQuota }: ClaudeConnectionsOptions): ClaudeConnections => {
  const directory = path.join(dataDir, 'native-agents');
  const file = path.join(directory, 'claude-connections.json');
  let writes: Promise<void> = Promise.resolve();

  const read = async (): Promise<StoredClaudeConnection[]> => {
    try {
      return documentSchema.parse(JSON.parse(await fs.readFile(file, 'utf8'))).connections;
    } catch (error) {
      if (fileErrorSchema.safeParse(error).data?.code === 'ENOENT') return [];
      throw new NativeAgentError('Could not read Claude Code connections', { status: 500, code: 'NATIVE_CONNECTION_READ_FAILED' });
    }
  };

  const mutate = <Result>(change: (connections: StoredClaudeConnection[]) => Result): Promise<Result> => {
    const next = writes.then(async () => {
      const connections = await read();
      const result = change(connections);
      if (result === false) return result;
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
    async quota(providerId) {
      await writes;
      const connection = (await read()).find((entry) => quotaProviderIdOf(entry) === providerId);
      if (!connection) return buildResult({ providerId, providerName: 'Kimi / Claude Code', ok: false, configured: false, error: 'Not configured' });
      const result = await fetchKimiUsage({ apiKey: connection.apiKey, baseURL: connection.baseURL });
      return { ...result, providerId, providerName: `${connection.name} / Claude Code` };
    },
    async hasCredentials() {
      return (await read()).length > 0;
    },
    async list() {
      await writes;
      return (await read()).map(publicConnection);
    },
    save(id, input) {
      const body = connectionWriteSchema.parse(input);
      return mutate((connections) => {
        const index = id === null ? -1 : connections.findIndex((entry) => entry.id === id);
        if (id !== null && index === -1) throw unavailable();
        const previous = index === -1 ? undefined : connections[index];
        const apiKey = body.apiKey ?? previous?.apiKey;
        if (!apiKey) throw new NativeAgentError('An API key is required', { status: 400, code: 'NATIVE_CONNECTION_KEY_REQUIRED' });
        const revision = (previous?.revision ?? 0) + 1;
        const connection: StoredClaudeConnection = { ...body, apiKey, id: previous?.id ?? randomUUID(), revision };
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
        return { deleted: true as const };
      });
    },
    async catalog() {
      await writes;
      return [...claudeModels(), ...(await read()).flatMap(catalogModels)];
    },
    async resolve(modelID, effort = null) {
      void effort;
      if (!modelID.startsWith('connection:')) return { key: 'default', model: claudeLaunchModel(modelID), env: null };
      await writes;
      const connections = await read();
      for (const connection of connections) {
        const descriptors = catalogModels(connection);
        const index = descriptors.findIndex((model) => model.id === modelID);
        if (index === -1) continue;
        const model = connection.models[index];
        const descriptor = descriptors[index];
        if (!model || !descriptor) continue;
        const env = claudeConnectionEnvironment(connection, model);
        const key = `${connection.id}:${connection.revision}:${model.id}:${model.modelID}:${model.contextWindow}:${model.outputLimit}`;
        return { key, model: model.modelID, env, descriptor };
      }
      throw unavailable();
    },
  };
};

export const prepareClaudeConnection = async (
  launch: ClaudeConnectionLaunch | null | undefined,
  baseEnv: Record<string, string>,
): Promise<PreparedClaudeConnection> => {
  const acquired = launch?.acquire ? await launch.acquire() : null;
  const env = acquired?.env ?? launch?.env;
  if (!launch || !env) return { env: baseEnv, settings: undefined, dispose: async () => {} };
  if (acquired) {
    env.ANTHROPIC_CUSTOM_HEADERS = '';
    env.NO_PROXY = [baseEnv.NO_PROXY, '127.0.0.1', 'localhost', '::1'].filter(Boolean).join(',');
    env.no_proxy = [baseEnv.no_proxy, '127.0.0.1', 'localhost', '::1'].filter(Boolean).join(',');
  }
  let directory: string;
  try {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-claude-'));
  } catch (error) {
    acquired?.dispose();
    throw error;
  }
  const settings = path.join(directory, 'settings.json');
  try {
    await fs.writeFile(settings, JSON.stringify({ env, apiKeyHelper: '', fallbackModel: [], modelOverrides: { [launch.model]: launch.model } }), { mode: 0o600, flag: 'wx' });
  } catch (error) {
    acquired?.dispose();
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    env: { ...baseEnv, ...env },
    settings,
    dispose: async () => {
      acquired?.dispose();
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
};

export const redactClaudeConnectionError = (message: string, launch?: ClaudeConnectionLaunch | null): string => {
  let redacted = message;
  for (const key of [launch?.env?.ANTHROPIC_API_KEY, launch?.env?.ANTHROPIC_AUTH_TOKEN]) {
    if (key) redacted = redacted.replaceAll(key, '[redacted]');
  }
  return redacted;
};
