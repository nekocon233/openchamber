import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexProviderArguments, codexProviderEnvKey, codexProviderId, createCodexConnections } from './connections.js';

const directories = [];
const fixture = async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-connections-test-'));
  directories.push(dataDir);
  return { dataDir, store: createCodexConnections({ dataDir }) };
};
const input = (name = 'Gateway') => ({
  name, baseURL: 'https://gateway.example.com/v1', apiKey: 'test-only-key',
  models: [{ id: randomUUID(), name: 'Sol', modelID: 'gpt-6-sol', contextWindow: 272000, outputLimit: 128000, input: { image: false, pdf: false }, efforts: ['low', 'high'] }],
});
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });

describe('Codex connections', () => {
  it('round-trips connections without exposing keys and preserves omitted keys', async () => {
    const { dataDir, store } = await fixture();
    expect(await store.list()).toEqual([]);
    const draft = input();
    const saved = await store.save(null, draft);
    expect(saved).toMatchObject({ name: 'Gateway', hasKey: true, revision: 1, kind: 'openai-responses' });
    expect(saved).not.toHaveProperty('apiKey');
    expect(await createCodexConnections({ dataDir }).list()).toEqual([saved]);
    const { apiKey, ...update } = draft;
    expect(apiKey).toBe('test-only-key');
    const edited = await store.save(saved.id, { ...update, name: 'Updated' });
    expect(edited.revision).toBe(2);
    const model = (await store.catalog()).find((entry) => entry.name === 'Updated / Sol');
    const launch = await store.resolve(model.id);
    expect(launch).toMatchObject({ model: 'gpt-6-sol', providerId: codexProviderId({ id: saved.id }) });
    expect(JSON.stringify(await store.list())).not.toContain('test-only-key');
    if (process.platform !== 'win32') expect((await fs.stat(path.join(dataDir, 'native-agents', 'codex-connections.json'))).mode & 0o777).toBe(0o600);
  });

  it('keeps model identity separate for different connections and serializes writes', async () => {
    const { store } = await fixture();
    const draft = input();
    const saved = await Promise.all([store.save(null, draft), store.save(null, { ...draft, name: 'Second', apiKey: 'another-test-key' })]);
    const models = (await store.catalog()).filter((entry) => entry.id.startsWith('codex-connection:'));
    expect(new Set(models.map((model) => model.id)).size).toBe(2);
    await store.remove(saved[0].id);
    await expect(store.resolve(models[0].id)).rejects.toMatchObject({ code: 'NATIVE_CONNECTION_UNAVAILABLE' });
    expect((await store.resolve(models[1].id)).model).toBe('gpt-6-sol');
  });

  it('does not overwrite malformed storage or treat it as empty', async () => {
    const { dataDir, store } = await fixture();
    await store.save(null, input());
    const file = path.join(dataDir, 'native-agents', 'codex-connections.json');
    await fs.writeFile(file, 'invalid');
    await expect(store.list()).rejects.toMatchObject({ code: 'NATIVE_CONNECTION_READ_FAILED' });
    await expect(store.save(null, input())).rejects.toMatchObject({ code: 'NATIVE_CONNECTION_READ_FAILED' });
    expect(await fs.readFile(file, 'utf8')).toBe('invalid');
  });

  it('preserves saved data after a failed write and can retry', async () => {
    const { dataDir, store } = await fixture();
    const saved = await store.save(null, input());
    const directory = path.join(dataDir, 'native-agents');
    await fs.rename(directory, `${directory}.backup`);
    await fs.writeFile(directory, 'not a directory');
    await expect(store.save(saved.id, input('Changed'))).rejects.toBeDefined();
    await fs.rm(directory);
    await fs.rename(`${directory}.backup`, directory);
    expect((await store.list())[0].name).toBe('Gateway');
    expect((await store.save(saved.id, input('Changed'))).name).toBe('Changed');
  });

  it('declares every connection as a provider override and keeps its key out of the arguments', async () => {
    const { store } = await fixture();
    const saved = await store.save(null, { ...input('Quote " and \\ backslash') });
    const { arguments: args, environment } = await store.launch();
    const providerId = codexProviderId({ id: saved.id });
    const envKey = codexProviderEnvKey({ id: saved.id });
    expect(args).toEqual([
      '-c', `model_providers.${providerId}.name="Quote \\" and \\\\ backslash"`,
      '-c', `model_providers.${providerId}.base_url="https://gateway.example.com/v1"`,
      '-c', `model_providers.${providerId}.env_key="${envKey}"`,
      '-c', `model_providers.${providerId}.wire_api="responses"`,
      '-c', `model_providers.${providerId}.requires_openai_auth=false`,
    ]);
    expect(environment).toEqual({ [envKey]: 'test-only-key' });
    expect(args.join(' ')).not.toContain('test-only-key');
    // The env name must survive `buildCliChildEnv`, which strips `OPENCHAMBER_*`.
    expect(envKey.startsWith('OPENCHAMBER_')).toBe(false);
    expect(providerId).toMatch(/^codexconn-[0-9a-f-]{36}$/);
    // No connections means no overrides at all: the child starts exactly as before.
    await store.remove(saved.id);
    expect(await store.launch()).toEqual({ arguments: [], environment: {} });
  });

  it('resolves a default model to the CLI login and rejects missing credentials, duplicate identities and credential-bearing URLs', async () => {
    const { store } = await fixture();
    expect(await store.resolve('gpt-6-astra')).toEqual({ key: 'default', model: 'gpt-6-astra', providerId: null });
    const draft = input();
    await expect(store.save(null, { ...draft, apiKey: undefined })).rejects.toMatchObject({ code: 'NATIVE_CONNECTION_KEY_REQUIRED' });
    expect(() => store.save(null, { ...draft, models: [draft.models[0], draft.models[0]] })).toThrow();
    expect(() => store.save(null, { ...draft, baseURL: 'https://user:password@example.com' })).toThrow();
    expect(() => store.save(null, { ...draft, baseURL: 'https://gateway.example.com/v1?key=secret' })).toThrow();
    expect(await store.list()).toEqual([]);
  });

  it('escapes a provider name that would otherwise break the TOML value', () => {
    const args = codexProviderArguments([{ id: 'x', name: 'line\nbreak "quoted"', baseURL: 'https://a.example/v1' }]);
    expect(args[1]).toBe('model_providers.codexconn-x.name="line\\nbreak \\"quoted\\""');
  });
});
