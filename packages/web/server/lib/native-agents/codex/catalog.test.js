import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';

import { createCodexCatalog } from './catalog.js';

const models = [
  { id: 'astra', model: 'gpt-6-astra' },
  { id: 'gpt-5.6-luna' },
  { id: 'gpt-5.5' },
  { id: 'hidden', hidden: true },
];
const metadata = [
  { slug: 'gpt-6-astra', context_window: 272_000, max_context_window: 872_000, effective_context_window_percent: 95 },
  { slug: 'gpt-5.6-luna', context_window: 272_000, max_context_window: 872_000, effective_context_window_percent: 95 },
  { slug: 'gpt-5.5', context_window: 272_000, max_context_window: 272_000, effective_context_window_percent: 95 },
];

const fixture = async ({ config = {}, entries = metadata, homeEnv = false } = {}) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-catalog-'));
  onTestFinished(() => fs.rm(home, { recursive: true, force: true }));
  const codexHome = path.join(home, '.codex');
  await fs.mkdir(codexHome);
  const cache = path.join(codexHome, 'models_cache.json');
  await fs.writeFile(cache, JSON.stringify({ models: entries }));
  const request = async (method) => {
    if (method === 'model/list') return { data: models };
    if (method === 'config/read') return { config };
    throw new Error('Unexpected request: ' + method);
  };
  const buildEnv = () => homeEnv ? { HOME: home } : { CODEX_HOME: codexHome };
  return { cache, home, config, request, buildEnv, catalog: createCodexCatalog({ request, buildEnv }) };
};

const windows = (catalog) => catalog.map(({ id, contextWindow }) => ({ id, contextWindow }));

describe('Codex context windows', () => {
  it('caps configured windows per model and includes the CLI reserve', async () => {
    const { catalog } = await fixture({ config: { model_context_window: 872_000 } });
    expect(windows(await catalog())).toEqual([
      { id: 'astra', contextWindow: 828_400 },
      { id: 'gpt-5.6-luna', contextWindow: 828_400 },
      { id: 'gpt-5.5', contextWindow: 258_400 },
    ]);
  });

  it.each([
    [{}, 258_400],
    [{ model_context_window: 100_000 }, 95_000],
  ])('honors the configured or default working window', async (config, expected) => {
    const { catalog } = await fixture({ config, homeEnv: true });
    expect((await catalog()).map((model) => model.contextWindow)).toEqual([expected, expected, expected]);
  });

  it('reads a custom catalog instead of the default cache', async () => {
    const { catalog, config, home } = await fixture();
    config.model_catalog_json = path.join(home, 'custom-models.json');
    await fs.writeFile(config.model_catalog_json, JSON.stringify({
      models: [{ slug: 'gpt-6-astra', context_window: 500_000 }],
    }));
    expect((await catalog())[0].contextWindow).toBe(500_000);
  });

  it('reads metadata after model/list has refreshed it', async () => {
    const { cache, request, buildEnv } = await fixture();
    const catalog = createCodexCatalog({
      buildEnv,
      request: async (method, params) => {
        if (method === 'model/list') {
          await fs.writeFile(cache, JSON.stringify({ models: [{ slug: 'gpt-6-astra', context_window: 400_000 }] }));
        }
        return request(method, params);
      },
    });
    expect((await catalog())[0].contextWindow).toBe(400_000);
  });

  it('retains valid models when another metadata entry is malformed or missing', async () => {
    const { catalog } = await fixture({ entries: [metadata[0], { slug: 'gpt-5.6-luna', context_window: 'invalid' }] });
    expect(windows(await catalog())).toEqual([
      { id: 'astra', contextWindow: 258_400 },
      { id: 'gpt-5.6-luna', contextWindow: 272_000 },
      { id: 'gpt-5.5', contextWindow: 272_000 },
    ]);
  });

  it('keeps listing models for CLIs without the default cache', async () => {
    const { cache, catalog } = await fixture();
    await fs.unlink(cache);
    expect((await catalog()).map((model) => model.contextWindow)).toEqual([272_000, 272_000, 272_000]);
  });

  it('reports an unreadable custom catalog instead of returning fallback limits', async () => {
    const { config, home, catalog } = await fixture();
    config.model_catalog_json = path.join(home, 'missing.json');
    await expect(catalog()).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports corrupt cache data instead of returning an empty success', async () => {
    const { cache, catalog } = await fixture();
    await fs.writeFile(cache, 'invalid json');
    await expect(catalog()).rejects.toThrow();
  });

  it.each(['model/list', 'config/read'])('reports %s failures', async (failedMethod) => {
    const { buildEnv, request } = await fixture();
    const catalog = createCodexCatalog({
      buildEnv,
      request: async (method, params) => {
        if (method === failedMethod) throw new Error('CLI unavailable');
        return request(method, params);
      },
    });
    await expect(catalog()).rejects.toThrow('CLI unavailable');
  });
});
