import { z } from 'zod';
import type { JsonObject, JsonValue } from '../../shared/json-values.js';

const modelId = z.string().trim().min(1).max(200);
const namespace = z.object({ ns: z.string(), value: z.json() });
const description = z.object({ namespaces: z.array(namespace) });
const settingsModel = z.object({
  id: modelId,
  contextWindow: z.number().int().positive().max(10_000_000).optional(),
  outputLimit: z.number().int().positive().max(1_000_000).optional(),
  maxTokens: z.number().int().positive().max(1_000_000).optional(),
});
const values = z.object({
  models: z.array(z.object({ id: modelId }).catchall(z.json())),
});

export type DeepseekModelLimit = {
  contextWindow: number | null;
  outputLimit: number | null;
};

export interface DeepseekConfigurationTransport {
  request: <Output>(endpoint: string, args: JsonObject, schema: z.ZodType<Output>) => Promise<Output>;
}

export interface DeepseekConfiguration {
  modelLimits: () => Promise<Map<string, DeepseekModelLimit>>;
}

export const modelLimitsFromSettings = (described?: JsonValue): Map<string, DeepseekModelLimit> => {
  const limits = new Map<string, DeepseekModelLimit>();
  const parsedDescription = description.safeParse(described);
  if (!parsedDescription.success) return limits;
  const view = parsedDescription.data.namespaces.find((item) => item.ns === 'llm-deepseek');
  if (!view) return limits;
  const config = values.safeParse(view.value);
  if (!config.success) return limits;
  for (const raw of config.data.models) {
    const model = settingsModel.safeParse(raw);
    if (!model.success) continue;
    limits.set(model.data.id, {
      contextWindow: model.data.contextWindow ?? null,
      outputLimit: model.data.outputLimit ?? model.data.maxTokens ?? null,
    });
  }
  return limits;
};

export const createDeepseekConfiguration = ({ transport }: { transport: DeepseekConfigurationTransport }): DeepseekConfiguration => ({
  async modelLimits() {
    return modelLimitsFromSettings(await transport.request('settings/describe', {}, description));
  },
});
