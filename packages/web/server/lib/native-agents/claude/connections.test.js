import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createClaudeConnections, prepareClaudeConnection } from './connections.js';

const directories = [];
const fixture = async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-connections-test-'));
  directories.push(dataDir);
  return { dataDir, store: createClaudeConnections({ dataDir }) };
};
const input = (name = 'Kimi') => ({
  name, baseURL: 'https://api.kimi.ai/coding/', auth: 'api-key', apiKey: 'test-only-key',
  models: [{ id: randomUUID(), name: 'Kimi', modelID: 'kimi-for-coding', contextWindow: 262144, outputLimit: 32000, input: { image: false, pdf: false }, efforts: ['low', 'high'] }],
});
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });

describe('Claude connections', () => {
  it('round-trips connections without exposing keys and preserves omitted keys', async () => {
    const { dataDir, store } = await fixture();
    expect(await store.list()).toEqual([]);
    const draft = input();
    const saved = await store.save(null, draft);
    expect(saved).toMatchObject({ name: 'Kimi', hasKey: true, revision: 1 });
    expect(saved).not.toHaveProperty('apiKey');
    expect(await createClaudeConnections({ dataDir }).list()).toEqual([saved]);
    const { apiKey, ...update } = draft;
    expect(apiKey).toBe('test-only-key');
    const edited = await store.save(saved.id, { ...update, name: 'Updated' });
    expect(edited.revision).toBe(2);
    const model = (await store.catalog()).find((entry) => entry.name === 'Updated / Kimi');
    const launch = await store.resolve(model.id);
    expect(launch.env.ANTHROPIC_API_KEY).toBe('test-only-key');
    expect(launch.model).toBe('kimi-for-coding');
    expect(JSON.stringify(await store.list())).not.toContain('test-only-key');
    if (process.platform !== 'win32') expect((await fs.stat(path.join(dataDir, 'native-agents', 'claude-connections.json'))).mode & 0o777).toBe(0o600);
  });

  it('keeps model identity separate for different connections and serializes writes', async () => {
    const { store } = await fixture();
    const draft = input();
    const saved = await Promise.all([store.save(null, draft), store.save(null, { ...draft, name: 'Second', apiKey: 'another-test-key' })]);
    const models = (await store.catalog()).filter((entry) => entry.id.startsWith('connection:'));
    expect(new Set(models.map((model) => model.id)).size).toBe(2);
    expect((await store.resolve(models[0].id)).env.ANTHROPIC_API_KEY).toBe('test-only-key');
    expect((await store.resolve(models[1].id)).env.ANTHROPIC_API_KEY).toBe('another-test-key');
    await store.remove(saved[0].id);
    await expect(store.resolve(models[0].id)).rejects.toMatchObject({ code: 'NATIVE_CONNECTION_UNAVAILABLE' });
    expect((await store.resolve(models[1].id)).model).toBe('kimi-for-coding');
  });

  it('does not overwrite malformed storage or treat it as empty', async () => {
    const { dataDir, store } = await fixture();
    await store.save(null, input());
    const file = path.join(dataDir, 'native-agents', 'claude-connections.json');
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
    expect((await store.list())[0].name).toBe('Kimi');
    expect((await store.save(saved.id, input('Changed'))).name).toBe('Changed');
  });

  it('clears competing authentication, maps auxiliary models, and removes private launch settings', async () => {
    const { store } = await fixture();
    await store.save(null, { ...input(), auth: 'bearer' });
    const model = (await store.catalog()).find((entry) => entry.id.startsWith('connection:'));
    const launch = await store.resolve(model.id);
    const ambient = { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'ambient-test-key', CLAUDE_CODE_USE_BEDROCK: '1' };
    const prepared = await prepareClaudeConnection(launch, ambient);
    expect(prepared.env).toMatchObject({ ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: 'test-only-key', CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_SUBAGENT_MODEL: 'kimi-for-coding', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'kimi-for-coding' });
    expect(ambient.ANTHROPIC_API_KEY).toBe('ambient-test-key');
    expect(JSON.parse(await fs.readFile(prepared.settings, 'utf8')).env).toEqual(launch.env);
    if (process.platform !== 'win32') expect((await fs.stat(prepared.settings)).mode & 0o777).toBe(0o600);
    await prepared.dispose();
    await expect(fs.stat(prepared.settings)).rejects.toMatchObject({ code: 'ENOENT' });
    const original = await prepareClaudeConnection(await store.resolve('opus'), ambient);
    expect(original.env).toBe(ambient);
    expect(original.settings).toBeUndefined();
  });

  it('rejects missing credentials, duplicate model identities and credential-bearing URLs', async () => {
    const { store } = await fixture();
    const draft = input();
    await expect(store.save(null, { ...draft, apiKey: undefined })).rejects.toMatchObject({ code: 'NATIVE_CONNECTION_KEY_REQUIRED' });
    expect(() => store.save(null, { ...draft, models: [draft.models[0], draft.models[0]] })).toThrow();
    expect(() => store.save(null, { ...draft, baseURL: 'https://user:password@example.com' })).toThrow();
    expect(await store.list()).toEqual([]);
  });
});
