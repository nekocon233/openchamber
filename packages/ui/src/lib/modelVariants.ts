import { parseModelIdentifier } from '@/lib/modelIdentifier';
import type { Model } from '@/lib/opencode/model';

/**
 * Variant ("thinking level") ids of a catalog model.
 *
 * OpenCode 2 lists a model's variants as `{ id, settings }[]`; v1 keyed them
 * by id. `Object.keys` on the array yields `"0", "1", "2"`, which is how a
 * session's `low` stopped matching and the picker fell back to "Default".
 * Every place that needs the ids goes through here.
 */
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

/** Names of the thinking levels a model exposes, empty when it has none. */
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
 * otherwise the highest listed level. A `<level>-fast` id is the same effort
 * on Codex's Fast tier and never outranks its plain twin.
 */
export const preferredModelVariant = (variantIds: readonly string[]): string | undefined => {
  if (variantIds.includes('max')) return 'max';
  if (variantIds.includes('max-fast')) return 'max-fast';
  const fastSuffix = '-fast';
  let highest: string | undefined;
  for (const id of variantIds) {
    if (id.endsWith(fastSuffix) && variantIds.includes(id.slice(0, -fastSuffix.length))) continue;
    highest = id;
  }
  return highest;
};
