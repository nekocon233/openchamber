import type { Model, Provider } from '@/lib/opencode/model';

import { nativeProviderIdOf, type NativeBackend } from './ids';
import type { NativeModelDescriptor } from './schemas';

export type NativeProvider = Provider & { models: Model[] };

// Product names, not UI copy: they read the same in every language.
const PROVIDER_NAMES = {
  claude: 'Claude Code CLI',
  codex: 'Codex CLI',
} satisfies Record<NativeBackend, string>;

// Effort levels are the picker's variants for these models. A model with
// Codex's Fast tier offers each effort again as `<effort>-fast`, which the
// server runs on that tier.
const variantsOf = (model: NativeModelDescriptor): NonNullable<Model['variants']> => {
  const variants: Model['variants'] = [];
  for (const effort of model.efforts) variants.push({ id: effort, settings: { reasoningEffort: effort } });
  if (model.fast) {
    for (const effort of model.efforts) variants.push({ id: `${effort}-fast`, settings: { reasoningEffort: effort, fast: true } });
  }
  return variants;
};

const buildNativeModel = (providerID: string, model: NativeModelDescriptor): Model => ({
  id: model.id,
  modelID: model.id,
  providerID,
  name: model.name,
  capabilities: {
    tools: true,
    input: ['text', ...(model.input.image ? ['image'] : []), ...(model.input.pdf ? ['pdf'] : [])],
    output: ['text'],
  },
  cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
  limit: { context: model.contextWindow, output: model.outputLimit },
  status: 'active',
  enabled: true,
  headers: {},
  time: { released: 0 },
  variants: variantsOf(model),
});

/** An OpenCode-shaped provider for a native CLI, so the model picker lists it like any other. */
export const buildNativeProvider = (backend: NativeBackend, models: NativeModelDescriptor[]): NativeProvider => {
  const id = nativeProviderIdOf(backend);
  return {
    id,
    name: PROVIDER_NAMES[backend],
    activation: 'enabled',
    package: '',
    models: models.map((model) => buildNativeModel(id, model)),
  };
};
