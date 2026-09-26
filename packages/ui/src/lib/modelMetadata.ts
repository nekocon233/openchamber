import type { Model } from '@/lib/opencode/model';
import type { ModelMetadata } from '@/types';

type LiveProviderModel = Pick<Model, 'id'> & Partial<Pick<Model,
  'modelID' | 'name' | 'capabilities' | 'cost' | 'limit' | 'time' | 'variants' | 'compatibility'
>>;

const finiteNumber = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isFinite(value) ? value : undefined;

const deriveLiveModelMetadata = (providerId: string, model: LiveProviderModel): ModelMetadata => {
  const capabilities = model.capabilities;
  const cost = model.cost?.find((entry) => !entry.tier) ?? model.cost?.[0];
  const reasoning = Boolean(model.variants?.length || model.compatibility?.reasoningField || model.compatibility?.requireReasoning);
  const released = finiteNumber(model.time?.released);
  return {
    id: model.modelID ?? model.id,
    providerId,
    name: model.name,
    tool_call: capabilities?.tools,
    reasoning: reasoning ? true : undefined,
    attachment: capabilities ? capabilities.input.includes('image') || capabilities.input.includes('pdf') : undefined,
    modalities: capabilities ? { input: capabilities.input, output: capabilities.output } : undefined,
    cost: cost ? {
      input: finiteNumber(cost.input),
      output: finiteNumber(cost.output),
      cache_read: finiteNumber(cost.cache.read),
      cache_write: finiteNumber(cost.cache.write),
    } : undefined,
    limit: model.limit ? {
      context: model.limit.context > 0 ? finiteNumber(model.limit.context) : undefined,
      output: model.limit.output > 0 ? finiteNumber(model.limit.output) : undefined,
    } : undefined,
    release_date: released && released > 0 ? new Date(released).toISOString().slice(0, 10) : undefined,
  };
};

export const mergeModelMetadataWithLiveModel = (
  providerId: string,
  model: LiveProviderModel,
  metadata?: ModelMetadata,
): ModelMetadata => {
  const liveMetadata = deriveLiveModelMetadata(providerId, model);
  if (!metadata) return liveMetadata;

  let modalities: ModelMetadata['modalities'];
  if (liveMetadata.modalities || metadata.modalities) {
    modalities = {
      input: liveMetadata.modalities?.input ?? metadata.modalities?.input,
      output: liveMetadata.modalities?.output ?? metadata.modalities?.output,
    };
  }

  let cost: ModelMetadata['cost'];
  if (liveMetadata.cost || metadata.cost) {
    cost = {
      input: liveMetadata.cost?.input ?? metadata.cost?.input,
      output: liveMetadata.cost?.output ?? metadata.cost?.output,
      cache_read: liveMetadata.cost?.cache_read ?? metadata.cost?.cache_read,
      cache_write: liveMetadata.cost?.cache_write ?? metadata.cost?.cache_write,
    };
  }

  let limit: ModelMetadata['limit'];
  if (liveMetadata.limit || metadata.limit) {
    limit = {
      context: liveMetadata.limit?.context ?? metadata.limit?.context,
      output: liveMetadata.limit?.output ?? metadata.limit?.output,
    };
  }

  return {
    ...metadata,
    id: liveMetadata.id,
    providerId,
    name: liveMetadata.name && liveMetadata.name !== liveMetadata.id ? liveMetadata.name : metadata.name ?? liveMetadata.name,
    tool_call: liveMetadata.tool_call ?? metadata.tool_call,
    reasoning: liveMetadata.reasoning ?? metadata.reasoning,
    temperature: liveMetadata.temperature ?? metadata.temperature,
    attachment: liveMetadata.attachment ?? metadata.attachment,
    modalities,
    cost,
    limit,
    release_date: liveMetadata.release_date || metadata.release_date,
  };
};
