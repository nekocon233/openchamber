import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'jsonc-parser';
import type { ParseError } from 'jsonc-parser';
import { z } from 'zod';
import { NativeAgentError } from '../errors.js';

const fileError = z.object({ code: z.string() });

const customModelSchema = z.object({
  modelName: z.string(),
  label: z.string().optional(),
}).passthrough();

const settings = z.object({
  modelProvider: z.string().optional(),
  model: z.string().optional(),
  customModelsConfig: z.object({
    customModels: z.record(z.string(), customModelSchema).default({}),
  }).optional(),
}).passthrough();

export type AgyCustomModelConfig = z.infer<typeof customModelSchema>;

export interface AgyContextSettingsData {
  customModelsConfig: {
    customModels: Record<string, AgyCustomModelConfig>;
  };
}

export interface AgyContextSettingsOptions {
  home?: string | null | undefined;
  modelId?: string | null | undefined;
  tempRoot?: string | undefined;
}

export interface PreparedAgyContextSettings {
  file: string;
  data: AgyContextSettingsData;
  cleanup: () => Promise<void>;
}

export const prepareAgyContextSettings = async ({
  home = null,
  modelId,
  tempRoot = os.tmpdir(),
}: AgyContextSettingsOptions): Promise<PreparedAgyContextSettings | null> => {
  let directory: string | null = null;
  try {
    const source = path.join(home ?? path.join(os.homedir(), '.gemini', 'antigravity-cli'), 'settings.json');
    let text: string;
    try {
      text = await fs.readFile(source, 'utf8');
    } catch (error) {
      if (fileError.safeParse(error).data?.code === 'ENOENT') return null;
      throw error;
    }
    const errors: ParseError[] = [];
    const document: unknown = parse(text.trim() ? text : '{}', errors, { allowTrailingComma: true });
    if (errors.length) throw new Error('Invalid CLI settings');
    const current = settings.parse(document);
    if (current.modelProvider !== 'gemini') return null;
    const models = current.customModelsConfig?.customModels ?? {};
    const selected = new Set<string>();
    for (const name of [modelId, current.model]) {
      if (!name) continue;
      if (Object.hasOwn(models, name)) selected.add(name);
      else {
        for (const [id, model] of Object.entries(models)) {
          if (model.label === name) selected.add(id);
        }
      }
    }
    if (selected.size === 0) return null;
    const configured: Record<string, AgyCustomModelConfig> = Object.fromEntries(
      Object.entries(models).map(([id, model]) => [
        id,
        selected.has(id) ? { ...model, maxTokens: 1_000_000 } : model,
      ]),
    );
    const data: AgyContextSettingsData = { customModelsConfig: { customModels: configured } };
    const createdDirectory = await fs.mkdtemp(path.join(tempRoot, 'openchamber-agy-context-'));
    directory = createdDirectory;
    const file = path.join(createdDirectory, 'settings.json');
    await fs.writeFile(file, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
    return { file, data, cleanup: () => fs.rm(createdDirectory, { recursive: true, force: true }) };
  } catch {
    if (directory) await fs.rm(directory, { recursive: true, force: true });
    throw new NativeAgentError('Could not prepare the Antigravity context budget. Check the CLI settings and retry.', {
      status: 503,
      code: 'NATIVE_ANTIGRAVITY_CONTEXT_SETUP_FAILED',
    });
  }
};
