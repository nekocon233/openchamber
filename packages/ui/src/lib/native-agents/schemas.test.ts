import { describe, expect, test } from 'bun:test';

import { nativeCapabilitiesSchema, nativeCatalogSchema, nativeMessageSchema, nativeSessionListSchema } from './schemas';
import { nativeMemoryStatusSchema } from './memory-schemas';

test('accepts AGY managed handoffs while terminal enrollment stays Claude and Codex only', () => {
  const progress = { backend: 'antigravity', sessionId: 'source', projectId: 'project', summary: 'Completed', status: 'completed', observedAt: 1, revision: 1 };
  expect(nativeMemoryStatusSchema.parse({ enabled: true, canManage: true, backends: [], progress: [progress], sources: [] }).progress[0]).toEqual(progress);
  expect(nativeMemoryStatusSchema.safeParse({ enabled: true, canManage: true, backends: [{ status: 'ok', backend: 'antigravity', installed: true,
    ready: true, reviewRequired: false, lastSeen: 1 }], progress: [], sources: [] }).success).toBe(false);
});

test('native assistant metadata preserves measured, unknown and older-server telemetry', () => {
  const info = { id: 'reply', sessionID: 'ncx_01a0d2a6-b55b-7162-a837-c62053537e00', role: 'assistant',
    time: { created: 1000, completed: 5000 }, parentID: 'user', providerID: 'codex-native', modelID: 'test',
    mode: 'build', agent: 'build', path: { cwd: '/work', root: '/work' } };
  for (const value of [0, 100, null, 'invalid']) {
    const metadata = { openchamber: { telemetry: { toolWaitDurationMs: value } } };
    expect(nativeMessageSchema.parse({ ...info, metadata })).toMatchObject({ metadata });
  }
  expect(nativeMessageSchema.parse(info)).not.toHaveProperty('metadata');
});

const capabilities = () => ({
  supported: true as const,
  backends: {
    claude: { cli: true },
    codex: { cli: true },
  },
  registry: { reset: false },
});

describe('Antigravity native boundary schemas', () => {
  test('preserves the optional Antigravity checklist capability', () => {
    const base = capabilities();
    const antigravity = { cli: true, tasks: { checklist: true, background: true, output: true, stop: false } };
    expect(nativeCapabilitiesSchema.parse({ ...base, backends: { ...base.backends, antigravity } }).backends.antigravity?.tasks?.checklist).toBe(true);
  });
  test('preserves the optional DeepSeek checklist capability across host versions', () => {
    const deepseek = { cli: true, blockedByEnterprise: false, actions: { revert: true, delete: true, fork: true } };
    const base = capabilities();
    expect(nativeCapabilitiesSchema.parse({ ...base, backends: { ...base.backends, deepseek } }).backends.deepseek?.tasks).toBeUndefined();
    expect(nativeCapabilitiesSchema.parse({ ...base, backends: { ...base.backends, deepseek: { ...deepseek, tasks: { checklist: true } } } }).backends.deepseek?.tasks).toEqual({ checklist: true });
  });

  test('accepts an optional Antigravity capability without opening unsupported actions', () => {
    const parsed = nativeCapabilitiesSchema.parse({
      ...capabilities(),
      backends: {
        ...capabilities().backends,
        antigravity: {
          cli: true,
          actions: { revert: true, delete: true, fork: true },
          tasks: { background: true, output: true, stop: false, plan: true, todos: true },
        },
      },
    });
    expect(parsed.backends.antigravity).toEqual({ cli: true, tasks: { background: true, output: true, stop: false } });
    expect(nativeCapabilitiesSchema.parse(capabilities()).backends.antigravity).toBeUndefined();
  });

  test('accepts Antigravity catalog partitions and preserves authentication diagnostics', () => {
    const parsed = nativeCatalogSchema.parse({
      backends: {
        claude: { status: 'ok', models: [] },
        codex: { status: 'ok', models: [] },
        antigravity: {
          status: 'ok',
          models: [{
            id: 'gemini-3-pro', name: 'Gemini 3 Pro', contextWindow: null, outputLimit: null,
            efforts: [], defaultEffort: null, fast: false, input: { image: false, pdf: false },
            aliases: [{ id: 'gemini-3-pro-low', variant: 'low' }],
          }],
        },
      },
    });
    expect(parsed.backends.antigravity).toMatchObject({ status: 'ok', models: [
      { aliases: [{ id: 'gemini-3-pro-low', variant: 'low' }] },
    ] });
    const unauthenticated = nativeCatalogSchema.parse({
      backends: {
        claude: { status: 'ok', models: [] },
        codex: { status: 'ok', models: [] },
        antigravity: { status: 'error', message: 'Sign in required', reason: 'unauthenticated' },
      },
    });
    expect(unauthenticated.backends.antigravity).toMatchObject({ status: 'error', reason: 'unauthenticated' });
    expect(nativeCatalogSchema.parse({
      backends: { claude: { status: 'ok', models: [] }, codex: { status: 'ok', models: [] } },
    }).backends.antigravity).toBeUndefined();
  });

  test('accepts nag sessions while allowing an older server to omit the partition', () => {
    const antigravity = {
      id: 'nag_f1033b7a-88c5-4b77-bbec-6d63ec3a1188',
      projectID: '', directory: '/work', title: 'Antigravity',
      time: { created: 1, updated: 1 },
    };
    const parsed = nativeSessionListSchema.parse({
      backends: {
        claude: { status: 'ok', sessions: [] },
        codex: { status: 'ok', sessions: [] },
        antigravity: { status: 'ok', sessions: [antigravity] },
      },
    });
    expect(parsed.backends.antigravity).toMatchObject({ status: 'ok' });
    expect(nativeSessionListSchema.parse({
      backends: { claude: { status: 'ok', sessions: [] }, codex: { status: 'ok', sessions: [] } },
    }).backends.antigravity).toBeUndefined();
  });
});
