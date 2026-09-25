import type { Model, Provider } from '@opencode-ai/sdk/v2/client';

import { nativeProviderIdOf, type NativeBackend } from './ids';
import type { NativeModelDescriptor } from './schemas';

// Product names, not UI copy: they read the same in every language.
const PROVIDER_NAMES = {
  claude: 'Claude Code CLI',
  codex: 'Codex CLI',
} satisfies Record<NativeBackend, string>;

// Effort levels are the picker's variants for these models. A model with
// Codex's Fast tier offers each effort again as `<effort>-fast`, which the
// server runs on that tier.
const variantsOf = (model: NativeModelDescriptor): NonNullable<Model['variants']> => {
  const variants: NonNullable<Model['variants']> = {};
  for (const effort of model.efforts) variants[effort] = { reasoningEffort: effort };
  if (model.fast) {
    for (const effort of model.efforts) variants[`${effort}-fast`] = { reasoningEffort: effort, fast: true };
  }
  return variants;
};

const buildNativeModel = (providerID: string, model: NativeModelDescriptor): Model => ({
  id: model.id,
  providerID,
  api: { id: model.id, url: '', npm: '' },
  name: model.name,
  capabilities: {
    temperature: false,
    reasoning: model.efforts.length > 0,
    attachment: model.input.image || model.input.pdf,
    toolcall: true,
    input: { text: true, audio: false, image: model.input.image, video: false, pdf: model.input.pdf },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: model.contextWindow, output: model.outputLimit },
  status: 'active',
  options: {},
  headers: {},
  release_date: '',
  variants: variantsOf(model),
});

/** An OpenCode-shaped provider for a native CLI, so the model picker lists it like any other. */
export const buildNativeProvider = (backend: NativeBackend, models: NativeModelDescriptor[]): Provider => {
  const id = nativeProviderIdOf(backend);
  return {
    id,
    name: PROVIDER_NAMES[backend],
    source: 'custom',
    env: [],
    options: {},
    models: Object.fromEntries(models.map((model) => [model.id, buildNativeModel(id, model)])),
  };
};
