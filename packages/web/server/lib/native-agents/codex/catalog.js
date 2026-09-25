import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import { codexModels } from '../catalog.js';

const configResponse = z.object({
  config: z.object({
    model_context_window: z.number().int().positive().nullish(),
    model_catalog_json: z.string().nullish(),
  }),
});
const modelCatalog = z.object({ models: z.array(z.unknown()) });
const modelMetadata = z.object({
  slug: z.string(),
  context_window: z.number().int().positive(),
  max_context_window: z.number().int().positive().nullish(),
  effective_context_window_percent: z.number().int().min(1).max(100).default(100),
});
const missingFile = z.object({ code: z.literal('ENOENT') });

// model/list owns visible models and capabilities but omits context limits.
// Read the same metadata the CLI uses, after model/list has refreshed it.
export const createCodexCatalog = ({ request, buildEnv = () => process.env }) => async () => {
  const [listed, configured] = await Promise.all([
    request('model/list', {}),
    request('config/read', { includeLayers: false }),
  ]);
  const config = configResponse.parse(configured).config;
  const env = buildEnv();
  const codexHome = env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex');
  const metadataPath = config.model_catalog_json ?? path.join(codexHome, 'models_cache.json');
  let raw;
  try {
    raw = await fs.readFile(metadataPath, 'utf8');
  } catch (error) {
    // A CLI without this cache can still list models. Other read failures
    // must not silently replace the known limits with fallback values.
    if (!config.model_catalog_json && missingFile.safeParse(error).success) return codexModels(listed);
    throw error;
  }
  const contextWindows = new Map();
  for (const entry of modelCatalog.parse(JSON.parse(raw)).models) {
    const parsed = modelMetadata.safeParse(entry);
    if (!parsed.success) continue;
    const model = parsed.data;
    const requested = config.model_context_window ?? model.context_window;
    const maximum = model.max_context_window ?? model.context_window;
    const effective = Math.floor(Math.min(requested, maximum) * model.effective_context_window_percent / 100);
    contextWindows.set(model.slug, effective);
  }
  return codexModels(listed, contextWindows);
};
