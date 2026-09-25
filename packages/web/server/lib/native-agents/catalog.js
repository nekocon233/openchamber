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

// Older CLIs without model metadata retain the legacy working-window estimate.
const CODEX_CONTEXT_WINDOW = 272_000;
const CODEX_OUTPUT_LIMIT = 128_000;

// The service tier Codex calls Fast. On a model that offers it, each effort
// has a `<effort>-fast` variant that runs the turn on this tier.
export const CODEX_FAST_SERVICE_TIER = 'priority';
// What Codex takes for its standard tier when a thread leaves Fast.
export const CODEX_STANDARD_SERVICE_TIER = 'default';
const CODEX_FAST_VARIANT_SUFFIX = '-fast';

export const claudeModels = () => CLAUDE_MODELS.map((model) => ({
  ...model,
  efforts: CLAUDE_EFFORTS,
  defaultEffort: null,
  fast: false,
  input: { image: true, pdf: true },
}));

const codexModelSchema = z.object({
  id: z.string(),
  model: z.string().optional(),
  displayName: z.string().catch(''),
  hidden: z.boolean().catch(false),
  defaultReasoningEffort: z.string().nullish(),
  supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() }).passthrough()).catch([]),
  serviceTiers: z.array(z.object({ id: z.string() }).passthrough()).catch([]),
  inputModalities: z.array(z.string()).catch(['text']),
}).passthrough();

const codexModelListSchema = z.object({ data: z.array(z.unknown()) }).passthrough();

/**
 * @param {unknown} response result of the app-server `model/list` request
 * @param {Map<string, number>} [contextWindows] effective windows reported by the CLI's model metadata and configuration
 */
export const codexModels = (response, contextWindows = new Map()) => {
  const models = [];
  for (const raw of codexModelListSchema.parse(response).data) {
    const model = codexModelSchema.safeParse(raw);
    if (!model.success || model.data.hidden) continue;
    models.push({
      id: model.data.id,
      name: model.data.displayName || model.data.id,
      contextWindow: contextWindows.get(model.data.model ?? model.data.id) ?? CODEX_CONTEXT_WINDOW,
      outputLimit: CODEX_OUTPUT_LIMIT,
      efforts: model.data.supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
      defaultEffort: model.data.defaultReasoningEffort ?? null,
      fast: model.data.serviceTiers.some((tier) => tier.id === CODEX_FAST_SERVICE_TIER),
      input: { image: model.data.inputModalities.includes('image'), pdf: false },
    });
  }
  return models;
};

/**
 * The effort and tier a Codex variant asks for: an effort, or `<effort>-fast`
 * for that effort on the Fast tier. Without a variant the thread keeps its own
 * effort.
 * @param {string | undefined} variant
 * @returns {{ effort: string | null, fast: boolean }}
 */
export const codexVariantSettings = (variant) => {
  if (variant === undefined) return { effort: null, fast: false };
  if (!variant.endsWith(CODEX_FAST_VARIANT_SUFFIX)) return { effort: variant, fast: false };
  return { effort: variant.slice(0, -CODEX_FAST_VARIANT_SUFFIX.length) || null, fast: true };
};
