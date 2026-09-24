// Model catalogs of the native CLIs. The UI turns each model descriptor into
// an OpenCode provider model; effort levels become the picker's variants.

import { z } from 'zod';

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// Claude Code resolves these aliases to the newest model of each family.
const CLAUDE_MODELS = [
  { id: 'opus', name: 'Opus', contextWindow: 1_000_000, outputLimit: 128_000 },
  { id: 'sonnet', name: 'Sonnet', contextWindow: 1_000_000, outputLimit: 64_000 },
  { id: 'fable', name: 'Fable', contextWindow: 1_000_000, outputLimit: 128_000 },
  { id: 'haiku', name: 'Haiku', contextWindow: 200_000, outputLimit: 64_000 },
];

// Codex budgets against its own working window, not the model's full limit.
const CODEX_CONTEXT_WINDOW = 272_000;
const CODEX_OUTPUT_LIMIT = 128_000;

export const claudeModels = () => CLAUDE_MODELS.map((model) => ({
  ...model,
  efforts: CLAUDE_EFFORTS,
  defaultEffort: null,
  input: { image: true, pdf: true },
}));

const codexModelSchema = z.object({
  id: z.string(),
  displayName: z.string().catch(''),
  hidden: z.boolean().catch(false),
  defaultReasoningEffort: z.string().nullish(),
  supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() }).passthrough()).catch([]),
  inputModalities: z.array(z.string()).catch(['text']),
}).passthrough();

const codexModelListSchema = z.object({ data: z.array(z.unknown()) }).passthrough();

/** @param {unknown} response result of the app-server `model/list` request */
export const codexModels = (response) => {
  const models = [];
  for (const raw of codexModelListSchema.parse(response).data) {
    const model = codexModelSchema.safeParse(raw);
    if (!model.success || model.data.hidden) continue;
    models.push({
      id: model.data.id,
      name: model.data.displayName || model.data.id,
      contextWindow: CODEX_CONTEXT_WINDOW,
      outputLimit: CODEX_OUTPUT_LIMIT,
      efforts: model.data.supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
      defaultEffort: model.data.defaultReasoningEffort ?? null,
      input: { image: model.data.inputModalities.includes('image'), pdf: false },
    });
  }
  return models;
};
