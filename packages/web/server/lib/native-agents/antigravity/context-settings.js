import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'jsonc-parser';
import { z } from 'zod';
import { NativeAgentError } from '../errors.js';

const settings = z.object({
  modelProvider: z.string().optional(),
  model: z.string().optional(),
  customModelsConfig: z.object({
    customModels: z.record(z.string(), z.object({ modelName: z.string(), label: z.string().optional() }).passthrough()).default({}),
  }).optional(),
}).passthrough();

/** Process-local context budgets survive an external rewrite of saved models. */
export const prepareAgyContextSettings = async ({ home = null, modelId, tempRoot = os.tmpdir() }) => {
  let directory = null;
  try {
    const source = path.join(home ?? path.join(os.homedir(), '.gemini', 'antigravity-cli'), 'settings.json');
    let text;
    try { text = await fs.readFile(source, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const errors = [];
    const document = parse(text.trim() ? text : '{}', errors, { allowTrailingComma: true });
    if (errors.length) throw new Error('Invalid CLI settings');
    const current = settings.parse(document);
    if (current.modelProvider !== 'gemini') return null;
    const models = current.customModelsConfig?.customModels ?? {};
    const selected = new Set();
    for (const name of [modelId, current.model]) {
      if (!name) continue;
      if (Object.hasOwn(models, name)) selected.add(name);
      else for (const [id, model] of Object.entries(models)) {
        if (model.label === name) selected.add(id);
      }
    }
    if (selected.size === 0) return null;
    const configured = Object.fromEntries(Object.entries(models).map(([id, model]) => [
      id, selected.has(id) ? { ...model, maxTokens: 1_000_000 } : model,
    ]));
    const data = { customModelsConfig: { customModels: configured } };
    directory = await fs.mkdtemp(path.join(tempRoot, 'openchamber-agy-context-'));
    const file = path.join(directory, 'settings.json');
    await fs.writeFile(file, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
    return { file, data, cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
  } catch {
    if (directory) await fs.rm(directory, { recursive: true, force: true });
    throw new NativeAgentError('Could not prepare the Antigravity context budget. Check the CLI settings and retry.', {
      status: 503, code: 'NATIVE_ANTIGRAVITY_CONTEXT_SETUP_FAILED',
    });
  }
};
