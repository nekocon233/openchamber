import { z } from 'zod';
import type { JsonValue } from '../shared/json-values.js';

export type NativeModelInputCapabilities = {
  image: boolean;
  pdf: boolean;
};

export type NativeCatalogModel = {
  id: string;
  name: string;
  contextWindow: number;
  outputLimit: number;
  efforts: string[];
  defaultEffort: string | null;
  fast: boolean;
  input: NativeModelInputCapabilities;
  serviceTiers?: string[];
  defaultEffortVariants?: string[];
};

export type NativeCodexCatalogModel = NativeCatalogModel & {
  serviceTiers: string[];
  defaultEffortVariants: string[];
};

export type CodexVariantSettings = {
  effort: string | null;
  serviceTier: string;
};

export interface VariantCapableModel {
  efforts: ReadonlyArray<string>;
  defaultEffortVariants?: ReadonlyArray<string> | undefined;
  serviceTiers?: ReadonlyArray<string> | undefined;
}

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const CLAUDE_1M_CONTEXT_WINDOW = 1_000_000;

const CLAUDE_MODELS = [
  { id: 'opus', name: 'Opus', contextWindow: CLAUDE_1M_CONTEXT_WINDOW, outputLimit: 128_000 },
  { id: 'sonnet', name: 'Sonnet', contextWindow: CLAUDE_1M_CONTEXT_WINDOW, outputLimit: 64_000 },
  { id: 'fable', name: 'Fable', contextWindow: CLAUDE_1M_CONTEXT_WINDOW, outputLimit: 128_000 },
  { id: 'haiku', name: 'Haiku', contextWindow: 200_000, outputLimit: 64_000 },
] as const;

const CODEX_CONTEXT_WINDOW = 272_000;
const CODEX_OUTPUT_LIMIT = 128_000;

export const CODEX_STANDARD_SERVICE_TIER = 'default';
const CODEX_SPEED_TIERS = [
  { suffix: '-fast', tier: 'priority' },
  { suffix: '-ultrafast', tier: 'ultrafast' },
] as const;

export const claudeModels = (): NativeCatalogModel[] => CLAUDE_MODELS.map((model) => ({
  ...model,
  efforts: CLAUDE_EFFORTS,
  defaultEffort: null,
  fast: false,
  input: { image: true, pdf: true },
}));

export const claudeLaunchModel = (id: string): string => {
  const model = CLAUDE_MODELS.find((entry) => entry.id === id);
  return model?.contextWindow === CLAUDE_1M_CONTEXT_WINDOW ? `${id}[1m]` : id;
};

const CLAUDE_API_MODEL_FAMILY = /^claude-(opus|sonnet|fable|haiku)(?:-|$)/;

export const claudeModelContextWindow = (id: string | null | undefined): number => {
  if (!id) return 0;
  const alias = id.endsWith('[1m]') ? id.slice(0, -'[1m]'.length) : id;
  const direct = CLAUDE_MODELS.find((entry) => entry.id === alias);
  if (direct) return direct.contextWindow;
  const family = CLAUDE_API_MODEL_FAMILY.exec(alias)?.[1];
  return CLAUDE_MODELS.find((entry) => entry.id === family)?.contextWindow ?? 0;
};

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

export const codexModels = (
  response: JsonValue | undefined,
  contextWindows: ReadonlyMap<string, number> = new Map(),
): NativeCodexCatalogModel[] => {
  const models: NativeCodexCatalogModel[] = [];
  for (const raw of codexModelListSchema.parse(response).data) {
    const model = codexModelSchema.safeParse(raw);
    if (!model.success || model.data.hidden) continue;
    const serviceTiers = model.data.serviceTiers.map((tier) => tier.id);
    models.push({
      id: model.data.id,
      name: model.data.displayName || model.data.id,
      contextWindow: contextWindows.get(model.data.model ?? model.data.id) ?? CODEX_CONTEXT_WINDOW,
      outputLimit: CODEX_OUTPUT_LIMIT,
      efforts: model.data.supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
      defaultEffort: model.data.defaultReasoningEffort ?? null,
      serviceTiers,
      defaultEffortVariants: ['default', ...CODEX_SPEED_TIERS.filter(({ tier }) => serviceTiers.includes(tier)).map(({ suffix }) => `default${suffix}`)],
      fast: serviceTiers.includes('priority'),
      input: { image: model.data.inputModalities.includes('image'), pdf: false },
    });
  }
  return models;
};

export const codexVariantSettings = (variant?: string | null): CodexVariantSettings => {
  const speed = variant ? CODEX_SPEED_TIERS.find(({ suffix }) => variant.endsWith(suffix)) : undefined;
  if (speed && variant) {
    const effort = variant.slice(0, -speed.suffix.length);
    return { effort: effort === 'default' ? null : effort || null, serviceTier: speed.tier };
  }
  return { effort: variant === 'default' ? null : variant ?? null, serviceTier: CODEX_STANDARD_SERVICE_TIER };
};

export const nativeModelSupportsVariant = (model: VariantCapableModel, variant: string): boolean => {
  if (model.efforts.includes(variant) || model.defaultEffortVariants?.includes(variant)) return true;
  const { effort, serviceTier } = codexVariantSettings(variant);
  return effort !== null && model.efforts.includes(effort) && model.serviceTiers?.includes(serviceTier) === true;
};
