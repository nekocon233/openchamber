import { findCatalogModel, type Model, type Provider } from '@/lib/opencode/model';
import type { ModelRef } from '@/lib/settings/parsers';
import { listModelVariantIds } from '@/lib/modelVariants';

type ProviderWithModelList = Provider & { models: Model[] };

export const resolveModelRefs = <P extends ProviderWithModelList>(
  refs: readonly ModelRef[],
  providers: readonly P[],
  hiddenModels: readonly ModelRef[],
): Array<ModelRef & { provider: P; model: Model }> => refs.flatMap(({ providerID, modelID, variant }) => {
  const provider = providers.find((p) => p.id === providerID);
  const model = provider ? findCatalogModel(provider.models, modelID) : undefined;
  if (!provider || !model) return [];
  if (hiddenModels.some((item) => item.providerID === providerID && item.modelID === modelID)) return [];
  const resolved: ModelRef & { provider: P; model: Model } = { provider, model, providerID, modelID };
  if (variant === null || (variant !== undefined && listModelVariantIds(model.variants).includes(variant))) {
    resolved.variant = variant;
  }
  return [resolved];
});

export const getNextFavoriteModel = (
  favorites: readonly ModelRef[],
  providers: readonly ProviderWithModelList[],
  hiddenModels: readonly ModelRef[],
  current: ModelRef,
  delta: number,
): ModelRef | null => {
  const available = resolveModelRefs(favorites, providers, hiddenModels);
  if (available.length === 0) return null;
  const index = available.findIndex((item) => (
    item.providerID === current.providerID && item.modelID === current.modelID
  ));
  const { providerID, modelID, variant } = available[(index + delta + available.length) % available.length];
  const next: ModelRef = { providerID, modelID };
  if (variant !== undefined) next.variant = variant;
  return next;
};
