import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { prepareAgyContextSettings } from './context-settings.js';

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const setup = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-context-test-'));
  roots.push(root);
  const file = path.join(root, 'settings.json');
  return { root, file };
};

it('overrides only selected and default custom budgets in a private session file', async () => {
  const { root, file } = await setup();
  const original = JSON.stringify({ modelProvider: 'gemini', model: 'default-model',
    customModelsConfig: { customModels: {
      'default-model': { modelName: 'provider/default', apiProvider: 'API_PROVIDER_GOOGLE_GEMINI' },
      selected: { modelName: 'provider/selected', maxTokens: 128000, modelFeatures: { supportsThinking: true } },
      other: { modelName: 'provider/other', maxTokens: 32000 },
    } }, permissions: { deny: ['write_file(*)'] } });
  await fs.writeFile(file, original);
  const prepared = await prepareAgyContextSettings({ home: root, modelId: 'selected', tempRoot: root });
  const result = JSON.parse(await fs.readFile(prepared.file, 'utf8'));
  expect(Object.keys(result)).toEqual(['customModelsConfig']);
  expect(result.customModelsConfig.customModels).toEqual({
    'default-model': { modelName: 'provider/default', apiProvider: 'API_PROVIDER_GOOGLE_GEMINI', maxTokens: 1000000 },
    selected: { modelName: 'provider/selected', maxTokens: 1000000, modelFeatures: { supportsThinking: true } },
    other: { modelName: 'provider/other', maxTokens: 32000 },
  });
  expect(await fs.readFile(file, 'utf8')).toBe(original);
  if (process.platform !== 'win32') {
    expect((await fs.stat(prepared.file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(prepared.file))).mode & 0o777).toBe(0o700);
  }
  await prepared.cleanup();
  await expect(fs.stat(prepared.file)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rebuilds the budget after an external model sync removes maxTokens', async () => {
  const { root, file } = await setup();
  const save = (model) => fs.writeFile(file, JSON.stringify({
    modelProvider: 'gemini', model: 'selected', customModelsConfig: { customModels: { selected: model } },
  }));
  await save({ modelName: 'same-route', maxTokens: 1000000 });
  const first = await prepareAgyContextSettings({ home: root, modelId: 'selected', tempRoot: root });
  await first.cleanup();
  await save({ modelName: 'same-route' });
  const before = await fs.readFile(file, 'utf8');
  const next = await prepareAgyContextSettings({ home: root, modelId: 'selected', tempRoot: root });
  expect(JSON.parse(await fs.readFile(next.file, 'utf8')).customModelsConfig.customModels.selected)
    .toEqual({ modelName: 'same-route', maxTokens: 1000000 });
  expect(await fs.readFile(file, 'utf8')).toBe(before);
});

it('keeps missing settings, native login and unconfigured built-in models unchanged', async () => {
  const { root, file } = await setup();
  expect(await prepareAgyContextSettings({ home: root, modelId: 'builtin', tempRoot: root })).toBeNull();
  for (const contents of [{ modelProvider: '' }, { modelProvider: 'gemini', customModelsConfig: { customModels: {} } }]) {
    await fs.writeFile(file, JSON.stringify(contents));
    expect(await prepareAgyContextSettings({ home: root, modelId: 'builtin', tempRoot: root })).toBeNull();
  }
});

it('resolves custom model labels while preferring an exact model key', async () => {
  const { root, file } = await setup();
  await fs.writeFile(file, JSON.stringify({ modelProvider: 'gemini', model: 'Default label',
    customModelsConfig: { customModels: {
      first: { modelName: 'provider/first', label: 'Default label' },
      selected: { modelName: 'provider/selected' },
      collision: { modelName: 'provider/other', label: 'selected', maxTokens: 32000 },
    } } }));
  const context = await prepareAgyContextSettings({ home: root, modelId: 'selected', tempRoot: root });
  const models = JSON.parse(await fs.readFile(context.file, 'utf8')).customModelsConfig.customModels;
  expect(models.first.maxTokens).toBe(1000000);
  expect(models.selected.maxTokens).toBe(1000000);
  expect(models.collision.maxTokens).toBe(32000);
});

it('refuses unreadable or invalid settings without exposing their contents', async () => {
  const { root, file } = await setup();
  await fs.writeFile(file, '{"modelProvider":"gemini","privateValue":"not-for-errors"');
  await expect(prepareAgyContextSettings({ home: root, modelId: 'selected', tempRoot: root }))
    .rejects.toMatchObject({ code: 'NATIVE_ANTIGRAVITY_CONTEXT_SETUP_FAILED' });
  await fs.rm(file);
  await fs.mkdir(file);
  await expect(prepareAgyContextSettings({ home: root, modelId: 'selected', tempRoot: root }))
    .rejects.toMatchObject({ code: 'NATIVE_ANTIGRAVITY_CONTEXT_SETUP_FAILED' });
});
