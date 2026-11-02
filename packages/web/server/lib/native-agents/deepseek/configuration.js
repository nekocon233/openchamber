import { z } from 'zod';

const modelId = z.string().trim().min(1).max(200);
const namespace = z.object({ ns: z.string(), value: z.json() }).passthrough();
const description = z.object({ namespaces: z.array(namespace) });
const settingsModel = z.object({
  id: modelId,
  contextWindow: z.number().int().positive().max(10_000_000).optional(),
  // DSH calls the output cap `maxTokens`; accept both spellings.
  outputLimit: z.number().int().positive().max(1_000_000).optional(),
  maxTokens: z.number().int().positive().max(1_000_000).optional(),
});
const values = z.object({
  models: z.array(z.object({ id: modelId }).catchall(z.json())),
});

/**
 * Context windows the DeepSeek provider configured for its models, from the
 * `llm-deepseek` settings namespace. The DSH session model catalog carries no
 * window, so this is where OpenChamber learns it; profiles that omit a field
 * leave it null and the UI falls back to its default estimate.
 * @param {unknown} described result of `settings/describe`
 * @returns {Map<string, { contextWindow: number | null, outputLimit: number | null }>}
 */
export const modelLimitsFromSettings = (described) => {
  const limits = new Map();
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

/** DSH owns its provider configuration; this reader only enriches catalog model windows. */
export const createDeepseekConfiguration = ({ transport }) => ({
  async modelLimits() {
    return modelLimitsFromSettings(await transport.request('settings/describe', {}, description));
  },
});
