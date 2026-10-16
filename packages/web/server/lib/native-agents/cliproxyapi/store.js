import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { NativeAgentError } from '../errors.js';
import { DEFAULT_CLIPROXYAPI_BASE_URL } from './client.js';

/** A proxy may carry credentials; it may not carry a path, query or fragment. */
export const upstreamProxySchema = z.string().url().max(2048).refine((value) => {
  const url = new URL(value);
  return ['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol)
    && (url.pathname === '' || url.pathname === '/') && !url.search && !url.hash;
}, 'Use a proxy URL without a path, query or fragment');

const documentSchema = z.object({
  version: z.literal(2),
  enabled: z.boolean(),
  port: z.number().int().min(1).max(65535),
  authDir: z.string().min(1),
  upstreamProxy: z.string().min(1).nullable(),
  managementKey: z.string().min(1),
  /** Exactly the keys written to the gateway's `access.api-keys`. */
  clientKeys: z.array(z.string().min(1)),
  installedVersion: z.string().min(1).nullable(),
});

const legacySchema = z.object({
  version: z.literal(1),
  baseURL: z.string().min(1),
  managementKey: z.string().min(1),
  managedClientKey: z.string().min(1).nullish(),
});

const defaultPort = Number(new URL(DEFAULT_CLIPROXYAPI_BASE_URL).port);
const readFailure = () => new NativeAgentError(
  'Could not read the CLIProxyAPI settings',
  { status: 500, code: 'CLIPROXYAPI_STORE_READ_FAILED' },
);

const isLoopback = (baseURL) => {
  try {
    const { hostname } = new URL(baseURL);
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname);
  } catch {
    return false;
  }
};

/** Upstream keeps its credentials here by default, and a fresh store reuses them. */
const hasCredentials = async (directory) => {
  try {
    const entries = await fs.readdir(directory);
    return entries.some((entry) => entry.endsWith('.json'));
  } catch {
    return false;
  }
};

/**
 * The managed gateway's only source of truth. The YAML the process reads is a
 * derived artifact: written from this document before every spawn, never read
 * back. v1 documents can only describe a gateway on this machine; one that
 * points elsewhere is dropped, and its connection keeps working as a plain
 * custom connection.
 */
export const createCliproxyapiStore = ({ dataDir, now = Date.now, homedir = os.homedir() }) => {
  const directory = path.join(dataDir, 'native-agents');
  const file = path.join(directory, 'cliproxyapi.json');
  let writes = Promise.resolve();

  const defaults = async () => {
    const upstream = path.join(homedir, '.cli-proxy-api');
    const authDir = await hasCredentials(upstream)
      ? upstream
      : path.join(directory, 'cliproxyapi', 'auth-dir');
    return {
      version: 2,
      enabled: false,
      port: defaultPort,
      authDir,
      upstreamProxy: null,
      managementKey: randomBytes(32).toString('hex'),
      clientKeys: [],
      installedVersion: null,
    };
  };

  const migrate = async (parsed) => {
    const legacy = legacySchema.safeParse(parsed);
    if (!legacy.success) return null;
    if (!isLoopback(legacy.data.baseURL)) return null;
    const port = Number(new URL(legacy.data.baseURL).port);
    return {
      ...await defaults(),
      port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : defaultPort,
      managementKey: legacy.data.managementKey,
      clientKeys: legacy.data.managedClientKey ? [legacy.data.managedClientKey] : [],
    };
  };

  const read = async () => {
    let raw;
    try {
      raw = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return defaults();
      throw readFailure();
    }
    const current = documentSchema.safeParse(raw);
    if (current.success) return current.data;
    const migrated = await migrate(raw);
    if (migrated !== null) return migrated;
    throw readFailure();
  };

  /** Serialized read-modify-write; the management key never leaves this store. */
  const update = (change) => {
    const next = writes.then(async () => {
      const document = documentSchema.parse(await change(await read()));
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
      await fs.writeFile(temporary, JSON.stringify({ ...document, updatedAt: now() }), { mode: 0o600 });
      await fs.rename(temporary, file);
      return document;
    });
    writes = next.then(() => {}, () => {});
    return next;
  };

  return { file, read, update };
};
