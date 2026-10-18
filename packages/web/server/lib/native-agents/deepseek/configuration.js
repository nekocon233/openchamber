import { z } from 'zod';

import { NativeAgentError } from '../errors.js';

const endpoint = z.string().trim().url().max(2048).refine((value) => {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
}, 'Use an HTTP(S) endpoint without credentials, query or fragment');
const modelId = z.string().trim().min(1).max(200);
export const deepseekConfigurationWrite = z.object({
  revision: z.number().int().nonnegative(),
  baseURL: endpoint.nullable(),
  modelIDs: z.array(modelId).min(1).max(100).refine((ids) => new Set(ids).size === ids.length),
  apiKey: z.string().trim().min(1).max(8192).optional(),
}).strict();

const namespace = z.object({ ns: z.string(), revision: z.number().int().nonnegative(), value: z.json() });
const description = z.object({ writable: z.boolean(), namespaces: z.array(namespace) });
const values = z.object({
  apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).default('DEEPSEEK_API_KEY'),
  baseURL: endpoint.optional(),
  // Keep provider metadata for retained models when editing the catalog.
  models: z.array(z.object({ id: modelId }).catchall(z.json())),
});
const credential = z.object({ configured: z.boolean(), writable: z.boolean() });
const credentials = z.record(z.string(), credential);
const error = (message, code, status) => new NativeAgentError(message, { code, status });
const project = (view, writable, key) => {
  const config = values.parse(view.value);
  return {
    revision: view.revision, writable, baseURL: config.baseURL ?? null,
    modelIDs: config.models.map(({ id }) => id),
    credential: key,
  };
};

/** DSH owns persistence and secret resolution, including read-only environment credentials. */
export const createDeepseekConfiguration = ({ transport }) => {
  let writes = Promise.resolve();
  const read = async () => {
    const described = await transport.request('settings/describe', {}, description);
    const view = described.namespaces.find((item) => item.ns === 'llm-deepseek');
    if (!view) throw error('This dsh profile does not expose DeepSeek API settings', 'NATIVE_DEEPSEEK_SETTINGS_UNAVAILABLE', 503);
    const config = values.parse(view.value);
    const keys = await transport.request('credentials/describe', { refs: [config.apiKeyEnv] }, credentials);
    const key = keys[config.apiKeyEnv];
    if (!key) throw error('Could not read the DeepSeek credential status', 'NATIVE_DEEPSEEK_SETTINGS_UNAVAILABLE', 502);
    return { view, config, key, writable: described.writable };
  };
  return {
    async read() {
      await writes;
      const { view, writable, key } = await read();
      return project(view, writable, key);
    },
    save(input) {
      const body = deepseekConfigurationWrite.parse(input);
      const operation = writes.then(async () => {
        const { view, config, writable, key } = await read();
        if (!writable || (body.apiKey && !key.writable)) {
          throw error('The dsh configuration or credential source is read-only', 'NATIVE_DEEPSEEK_SETTINGS_READ_ONLY', 403);
        }
        if (body.revision !== view.revision) {
          throw error('DeepSeek settings changed. Reload them before saving.', 'NATIVE_DEEPSEEK_SETTINGS_CONFLICT', 409);
        }
        if (!key.configured && !body.apiKey) {
          throw error('An API key is required', 'NATIVE_DEEPSEEK_KEY_REQUIRED', 400);
        }
        const models = body.modelIDs.map((id) => ({ ...config.models.find((item) => item.id === id), id }));
        const ops = [
          body.baseURL === null ? { op: 'unset', path: ['baseURL'] } : { op: 'set', path: ['baseURL'], value: body.baseURL },
          { op: 'set', path: ['models'], value: models },
        ];
        const saved = await transport.request('settings/mutate', { ns: 'llm-deepseek', ops, expectedRevision: body.revision }, namespace);
        if (body.apiKey) {
          try {
            await transport.request('credentials/set', { ref: config.apiKeyEnv, value: body.apiKey }, z.void());
          } catch {
            // The settings write is already durable. Return its revision so the
            // same form can retry the credential without overwriting newer edits.
            return { status: 'credential-error', configuration: project(saved, writable, key) };
          }
        }
        return { status: 'saved', configuration: project(saved, writable, { ...key, configured: key.configured || Boolean(body.apiKey) }) };
      });
      writes = operation.then(() => {}, () => {});
      return operation;
    },
  };
};
