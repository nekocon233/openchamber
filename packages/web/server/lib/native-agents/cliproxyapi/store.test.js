import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCliproxyapiStore } from './store.js';

const directories = [];
const fixture = async ({ homedir = null } = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cliproxyapi-store-'));
  directories.push(root);
  const dataDir = path.join(root, 'data');
  const home = homedir ?? path.join(root, 'home');
  await fs.mkdir(home, { recursive: true });
  return { dataDir, home, store: createCliproxyapiStore({ dataDir, homedir: home }) };
};
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });

const write = async (dataDir, document) => {
  const file = path.join(dataDir, 'native-agents', 'cliproxyapi.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(document));
  return file;
};

describe('CLIProxyAPI store', () => {
  it('answers with defaults without writing anything', async () => {
    const { dataDir, store } = await fixture();
    const document = await store.read();
    expect(document).toMatchObject({ version: 2, enabled: false, port: 8317, upstreamProxy: null, clientKeys: [], installedVersion: null });
    expect(document.managementKey).toMatch(/^[a-f0-9]{64}$/);
    expect(document.authDir).toBe(path.join(dataDir, 'native-agents', 'cliproxyapi', 'auth-dir'));
    await expect(fs.stat(store.file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('adopts an existing CLIProxyAPI auth directory so a login carries over', async () => {
    const { home, store } = await fixture();
    await fs.mkdir(path.join(home, '.cli-proxy-api'), { recursive: true });
    await fs.writeFile(path.join(home, '.cli-proxy-api', 'codex-account@example.com-pro.json'), '{}');
    expect((await store.read()).authDir).toBe(path.join(home, '.cli-proxy-api'));
  });

  it('writes owner-only, atomically, and serializes concurrent updates', async () => {
    const { store } = await fixture();
    const [first, second] = await Promise.all([
      store.update((current) => ({ ...current, clientKeys: ['one'] })),
      store.update((current) => ({ ...current, enabled: true })),
    ]);
    expect(first.clientKeys).toEqual(['one']);
    expect(second.enabled).toBe(true);
    const stored = JSON.parse(await fs.readFile(store.file, 'utf8'));
    expect(stored).toMatchObject({ version: 2, enabled: true, clientKeys: ['one'] });
    if (process.platform !== 'win32') {
      expect((await fs.stat(store.file)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(path.dirname(store.file))).mode & 0o777).toBe(0o700);
    }
    const entries = await fs.readdir(path.dirname(store.file));
    expect(entries.filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
  });

  it('migrates a loopback v1 document and keeps its management key and client key', async () => {
    const { dataDir, store } = await fixture();
    await write(dataDir, { version: 1, baseURL: 'http://127.0.0.1:8320', managementKey: 'management-key', managedClientKey: 'client-key' });
    expect(await store.read()).toMatchObject({
      version: 2, port: 8320, managementKey: 'management-key', clientKeys: ['client-key'], enabled: false,
    });
  });

  it('drops a v1 document that points at another machine and refuses nonsense', async () => {
    const { dataDir, store } = await fixture();
    await write(dataDir, { version: 1, baseURL: 'https://gateway.example.com', managementKey: 'k', managedClientKey: null });
    await expect(store.read()).rejects.toMatchObject({ code: 'CLIPROXYAPI_STORE_READ_FAILED' });
    await write(dataDir, { version: 2, port: 'nope' });
    await expect(store.read()).rejects.toMatchObject({ code: 'CLIPROXYAPI_STORE_READ_FAILED' });
  });
});
