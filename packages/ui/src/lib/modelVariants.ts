import { parseModelIdentifier } from '@/lib/modelIdentifier';
import { codexVariantSettings } from '@/lib/native-agents/codex-speed';
import { NATIVE_PROVIDER_CODEX } from '@/lib/native-agents/ids';
import type { Model } from '@/lib/opencode/model';

// external: https://github.com/anomalyco/opencode/tree/v2.3.0/packages/client Model variants are id/settings arrays; Object.keys yields indices instead of variant IDs.
export type ModelVariantSource =
  | ReadonlyArray<{ readonly id: string }>
  | Readonly<Record<string, { readonly id?: string } | null>>
  | null
  | undefined;

export const listModelVariantIds = (variants: ModelVariantSource): string[] => {
  if (!variants) return [];
  if (Array.isArray(variants)) {
    return variants.map((variant) => variant.id).filter((id) => id.length > 0);
  }
  return Object.keys(variants);
};

export const nextThinkingVariant = (variants: readonly string[], current: string | null | undefined): string | null => {
  if (current === null || current === undefined) return variants[0] ?? null;
  const index = variants.indexOf(current);
  return index >= 0 ? variants[index + 1] ?? null : null;
};

export const modelVariantNames = (model: { readonly variants?: ModelVariantSource } | undefined): string[] =>
  listModelVariantIds(model?.variants);

/** A configured effort belongs to its model, including confirmed native aliases. */
export const configuredVariantForModel = ({ defaultModel, defaultVariant, providerId, modelId, model }: {
  defaultModel: string | undefined;
  defaultVariant: string | undefined;
  providerId: string;
  modelId: string;
  model: Pick<Model, 'id' | 'modelID' | 'nativeAliases'> | undefined;
}): string | undefined => {
  if (!defaultModel) return defaultVariant;
  const configured = parseModelIdentifier(defaultModel);
  if (!configured || configured.providerId !== providerId) return undefined;
  return configured.modelId === modelId || (model && (
    configured.modelId === model.id || configured.modelId === model.modelID
    || model.nativeAliases?.some((alias) => alias.id === configured.modelId)
  )) ? defaultVariant : undefined;
};

/**
 * The inherited thinking level when nothing names one: max when supported,
 * otherwise the highest listed level. A Codex speed suffix never outranks
 * the same effort on the standard tier.
 */
export const preferredModelVariant = (variantIds: readonly string[], providerId?: string): string | undefined => {
  if (variantIds.includes('max')) return 'max';
  if (variantIds.includes('max-fast')) return 'max-fast';
  if (variantIds.includes('max-ultrafast')) return 'max-ultrafast';
  let highest: string | undefined;
  for (const id of variantIds) {
    if (id === 'default' && providerId === NATIVE_PROVIDER_CODEX) continue;
    const { effort, suffix } = codexVariantSettings(id);
    if (suffix && (variantIds.includes(effort ?? 'default') || (!effort && providerId === NATIVE_PROVIDER_CODEX))) continue;
    highest = id;
  }
  return highest;
};
