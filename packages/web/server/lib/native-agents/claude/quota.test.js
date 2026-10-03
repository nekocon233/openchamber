import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createClaudeConnections } from './connections.js';
import { fetchKimiQuota, isKimiCodingEndpoint } from '../../quota/providers/kimi.js';

const directories = [];
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });
const input = (name, apiKey) => ({ name, apiKey, auth: 'api-key', baseURL: 'https://api.kimi.ai/coding/', models: [
  { id: randomUUID(), name: 'Kimi', modelID: 'kimi-for-coding', contextWindow: 262144, outputLimit: 32000, efforts: [], input: { image: false, pdf: false } },
] });

describe('Claude connection quota credentials', () => {
  it('queries each connection with its own current key and endpoint', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-native-kimi-quota-')); directories.push(dataDir);
    const calls = [];
    const store = createClaudeConnections({ dataDir, fetchKimiUsage: async (options) => {
      calls.push(options);
      return { providerId: 'kimi-for-coding', providerName: 'Kimi', ok: true, configured: true, usage: null, fetchedAt: 1 };
    } });
    const first = await store.save(null, input('First', 'first-test-key'));
    const second = await store.save(null, input('Second', 'second-test-key'));
    expect(first.quotaProviderId).toBe(`kimi-claude:${first.id}`);
    expect((await store.quota(first.quotaProviderId)).providerName).toBe('First / Claude Code');
    expect((await store.quota(second.quotaProviderId)).providerId).toBe(second.quotaProviderId);
    expect(calls.map((call) => call.apiKey)).toEqual(['first-test-key', 'second-test-key']);
    expect(calls[0].baseURL).toBe('https://api.kimi.ai/coding/');
    await store.save(first.id, { ...input('First', 'replacement-test-key') });
    await store.quota(first.quotaProviderId);
    expect(calls[2].apiKey).toBe('replacement-test-key');
    await store.remove(first.id);
    expect(await store.quota(first.quotaProviderId)).toMatchObject({ configured: false, ok: false });
    expect(calls).toHaveLength(3);
    const unrelated = await store.save(null, { ...input('Proxy', 'proxy-test-key'), baseURL: 'https://proxy.example.test/coding/' });
    expect(unrelated.quotaProviderId).toBeNull();
    expect(await store.quota(`kimi-claude:${unrelated.id}`)).toMatchObject({ configured: false });
    expect(calls).toHaveLength(3);
  });

  it('pins quota requests to the configured official Kimi origin without redirects', async () => {
    const requests = [];
    const result = await fetchKimiQuota({ apiKey: 'native-test-key', baseURL: 'https://api.kimi.ai/coding/', fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return Response.json({ usage: { limit: 100, used: 25 }, limits: [] });
    } });
    expect(result.ok).toBe(true);
    expect(result.usage.windows.weekly.usedPercent).toBe(25);
    expect(requests[0].url).toBe('https://api.kimi.ai/coding/v1/usages');
    expect(requests[0].options.headers.Authorization).toBe('Bearer native-test-key');
    expect(requests[0].options.redirect).toBe('error');
    for (const url of ['https://api.kimi.ai.evil.test/coding/', 'http://api.kimi.ai/coding/', 'https://api.kimi.ai/other/', 'https://user@api.kimi.ai/coding/']) expect(isKimiCodingEndpoint(url)).toBe(false);
  });
});
