import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexHomeFrom, readCodexModelMetadata, parseGatewayModelMetadata } from './models.js';

const directories = [];
const fixture = async (document = null) => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-'));
  directories.push(codexHome);
  if (document !== null) await fs.writeFile(path.join(codexHome, 'models_cache.json'), document);
  return codexHome;
};
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });

const cache = (models) => JSON.stringify({ client_version: '0.163.0', etag: 'x', fetched_at: '2026-10-16T09:00:00Z', identity: {}, models });

describe('Codex model metadata for gateway imports', () => {
  it('exposes documented gateway effort aliases for Antigravity Claude budget models', () => {
    const definition = { id: 'claude-opus-5-5-high', context_length: 1000000, max_completion_tokens: 128000, thinking: { min: 1024, max: 64000 } };
    expect(parseGatewayModelMetadata({ models: [definition] }, 'antigravity').get(definition.id).efforts)
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(parseGatewayModelMetadata({ models: [definition] }, 'claude').get(definition.id).efforts).toEqual([]);
    expect(parseGatewayModelMetadata({ models: [definition] }).get(definition.id).efforts).toEqual([]);
    expect(parseGatewayModelMetadata({ models: [{ ...definition, id: 'gemini-budget-model' }] }, 'antigravity').get('gemini-budget-model').efforts).toEqual([]);
  });

  it('keeps explicit effort declarations ahead of gateway budget aliases', () => {
    const definition = { id: 'claude-explicit', context_length: 200000, max_completion_tokens: 128000, thinking: { min: 1024, max: 64000, levels: ['medium', 'high'] } };
    expect(parseGatewayModelMetadata({ models: [definition] }, 'antigravity').get(definition.id).efforts).toEqual(['medium', 'high']);
  });

  it('does not advertise aliases without a usable thinking budget', () => {
    for (const thinking of [undefined, {}, { min: 0, max: 0 }, { min: 64000, max: 1024 }, { min: 128000, max: 128000 }]) {
      const definition = { id: 'claude-budget', context_length: 200000, max_completion_tokens: 128000, thinking };
      if (thinking === undefined) delete definition.thinking;
      expect(parseGatewayModelMetadata({ models: [definition] }, 'antigravity').get(definition.id).efforts).toEqual([]);
    }
  });

  it('uses declared gateway limits and refuses incomplete model definitions', () => {
    const metadata = parseGatewayModelMetadata({ models: [
      { id: 'claude-complete', context_length: 200000, max_completion_tokens: 64000, thinking: { levels: ['high', 'low', 'unsupported'] } },
      { id: 'claude-missing', context_length: 200000 },
      { id: 'claude-invalid', context_length: -1, max_completion_tokens: 64000 },
    ] });
    expect([...metadata.keys()]).toEqual(['claude-complete']);
    expect(metadata.get('claude-complete')).toMatchObject({ contextWindow: 200000, outputLimit: 64000, efforts: ['low', 'high'], image: false });
  });
  it('reads the fields a connection row needs', async () => {
    const codexHome = await fixture(cache([{
      slug: 'gpt-6.1-sol',
      display_name: 'GPT-6.1-Sol',
      context_window: 500000,
      max_context_window: 872000,
      effective_context_window_percent: 95,
      input_modalities: ['text', 'image'],
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'max' }, { effort: 'ultra' }],
      unsupported_field: true,
    }]));
    expect(await readCodexModelMetadata({ codexHome })).toEqual(new Map([['gpt-6.1-sol', {
      name: 'GPT-6.1-Sol',
      contextWindow: 872000,
      outputLimit: 128000,
      image: true,
      efforts: ['low', 'max'],
    }]]));
  });

  it('falls back to the plain window and the slug when the cache is thinner', async () => {
    const codexHome = await fixture(cache([{ slug: 'gpt-x', context_window: 200000 }]));
    expect((await readCodexModelMetadata({ codexHome })).get('gpt-x')).toEqual({
      name: 'gpt-x', contextWindow: 200000, outputLimit: 128000, image: false, efforts: [],
    });
  });

  it('treats a machine that never ran the Codex CLI as nothing to import', async () => {
    const codexHome = await fixture();
    expect(await readCodexModelMetadata({ codexHome })).toEqual(new Map());
  });

  it('refuses a corrupt cache instead of importing nothing quietly', async () => {
    const broken = await fixture('{ not json');
    await expect(readCodexModelMetadata({ codexHome: broken })).rejects.toThrow();
    const wrongDocument = await fixture(JSON.stringify({ models: 'nope' }));
    await expect(readCodexModelMetadata({ codexHome: wrongDocument })).rejects.toThrow();
  });

  it('resolves the Codex home from the environment', () => {
    expect(codexHomeFrom({ CODEX_HOME: '/custom/codex', HOME: '/home/x' })).toBe('/custom/codex');
    expect(codexHomeFrom({ HOME: '/home/x' })).toBe('/home/x/.codex');
  });
});
