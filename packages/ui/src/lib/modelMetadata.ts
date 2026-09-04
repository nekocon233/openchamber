import type { ModelMetadata } from '@/types';

type LiveModelModalities = {
  text?: boolean;
  audio?: boolean;
  image?: boolean;
  video?: boolean;
  pdf?: boolean;
};

type LiveProviderModel = {
  id: string;
  name?: string;
  capabilities?: {
    toolcall?: boolean;
    reasoning?: boolean;
    temperature?: boolean;
    attachment?: boolean;
    input?: LiveModelModalities;
    output?: LiveModelModalities;
  };
  cost?: {
    input?: number;
    output?: number;
    cache?: { read?: number; write?: number };
  };
  limit?: { context?: number; output?: number };
  release_date?: string;
};

const finiteNumber = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isFinite(value) ? value : undefined;

const getModalities = (value: LiveModelModalities | undefined): string[] => {
  const modalities: string[] = [];
  if (value?.text) modalities.push('text');
  if (value?.audio) modalities.push('audio');
  if (value?.image) modalities.push('image');
  if (value?.video) modalities.push('video');
  if (value?.pdf) modalities.push('pdf');
  return modalities;
};

const deriveLiveModelMetadata = (providerId: string, model: LiveProviderModel): ModelMetadata => {
  const capabilities = model.capabilities;
  const cost = model.cost;
  const inputModalities = getModalities(capabilities?.input);
  const outputModalities = getModalities(capabilities?.output);

  return {
    id: model.id,
    providerId,
    name: model.name,
    tool_call: capabilities?.toolcall,
    reasoning: capabilities?.reasoning,
    temperature: capabilities?.temperature,
    attachment: capabilities?.attachment,
    modalities: capabilities ? { input: inputModalities, output: outputModalities } : undefined,
    cost: cost ? {
      input: finiteNumber(cost.input),
      output: finiteNumber(cost.output),
      cache_read: finiteNumber(cost.cache?.read),
      cache_write: finiteNumber(cost.cache?.write),
    } : undefined,
    limit: model.limit ? {
      context: finiteNumber(model.limit.context),
      output: finiteNumber(model.limit.output),
    } : undefined,
    release_date: model.release_date,
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
    name: liveMetadata.name ?? metadata.name,
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
