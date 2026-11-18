import type { Model, Provider } from '@/lib/opencode/model';

import { CODEX_SPEED_TIERS } from './codex-speed';
import { nativeProviderIdOf, type NativeBackend } from './ids';
import type { NativeModelDescriptor } from './schemas';

export type NativeProvider = Provider & { models: Model[] };

// Product names, not UI copy: they read the same in every language.
const PROVIDER_NAMES = {
  claude: 'Claude Code CLI',
  codex: 'Codex CLI',
  deepseek: 'DeepSeek Harness',
  antigravity: 'Antigravity CLI',
} satisfies Record<NativeBackend, string>;

// The picker groups plain efforts first, then one group per supported speed.
const variantsOf = (model: NativeModelDescriptor): NonNullable<Model['variants']> => {
  const variants: Model['variants'] = [];
  for (const effort of model.efforts) variants.push({ id: effort, settings: { reasoningEffort: effort } });
  const tiers = model.serviceTiers ?? (model.fast ? ['priority'] : []);
  for (const { suffix, serviceTier } of CODEX_SPEED_TIERS) {
    if (!tiers.includes(serviceTier)) continue;
    for (const effort of model.efforts) {
      variants.push({ id: effort + suffix, settings: { reasoningEffort: effort, serviceTier, ...(serviceTier === 'priority' && { fast: true }) } });
    }
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
  limit: { context: model.contextWindow ?? 0, output: model.outputLimit ?? 0 },
  status: 'active',
  enabled: true,
  headers: {},
  time: { released: 0 },
  variants: variantsOf(model),
  nativeAliases: model.aliases,
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
