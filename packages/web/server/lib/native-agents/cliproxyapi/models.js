import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { CODEX_OUTPUT_LIMIT } from '../catalog.js';

// The Codex CLI keeps this cache fresh from the account the gateway serves, and
// it is the only place with real context windows, modalities and effort levels
// for those models. `codex/catalog.js` reads the same file for the Codex model
// picker; this reader keeps the wider field set a Claude Code connection row
// needs, so neither has to bend its shape toward the other.
const documentSchema = z.object({ models: z.array(z.unknown()) });
const metadataSchema = z.object({
  slug: z.string().min(1),
  display_name: z.string().nullish(),
  context_window: z.number().int().positive().nullish(),
  max_context_window: z.number().int().positive().nullish(),
  input_modalities: z.array(z.string()).default([]),
  supported_reasoning_levels: z.array(z.object({ effort: z.string() }).passthrough()).default([]),
});

/** The efforts a Claude Code connection can offer, in the order the editor lists them. */
const CONNECTION_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export const codexHomeFrom = (env = process.env) => {
  const configured = env.CODEX_HOME?.trim() ?? '';
  if (configured !== '') return configured;
  return path.join(env.HOME?.trim() || os.homedir(), '.codex');
};

/**
 * Model slug to what a connection row needs. A missing cache is not an error,
 * because a machine that never ran the Codex CLI simply has nothing to import;
 * a corrupt one is, because falling back would silently drop the real limits.
 *
 * @returns {Promise<Map<string, { name: string, contextWindow: number, outputLimit: number, image: boolean, efforts: string[] }>>}
 */
export const readCodexModelMetadata = async ({ codexHome = codexHomeFrom(), readFile = fs.readFile } = {}) => {
  let raw;
  try {
    raw = await readFile(path.join(codexHome, 'models_cache.json'), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return new Map();
    throw error;
  }
  const entries = new Map();
  for (const candidate of documentSchema.parse(JSON.parse(raw)).models) {
    const parsed = metadataSchema.safeParse(candidate);
    if (!parsed.success) continue;
    const metadata = parsed.data;
    // The maximum is what a session can actually address; the plain window is
    // the smaller default the CLI reserves.
    const contextWindow = metadata.max_context_window ?? metadata.context_window;
    if (contextWindow == null) continue;
    const efforts = metadata.supported_reasoning_levels
      .map((level) => level.effort)
      .filter((effort) => CONNECTION_EFFORTS.includes(effort));
    entries.set(metadata.slug, {
      name: metadata.display_name?.trim() || metadata.slug,
      contextWindow,
      outputLimit: CODEX_OUTPUT_LIMIT,
      image: metadata.input_modalities.includes('image'),
      efforts: [...new Set(efforts)].sort((left, right) => CONNECTION_EFFORTS.indexOf(left) - CONNECTION_EFFORTS.indexOf(right)),
    });
  }
  return entries;
};
