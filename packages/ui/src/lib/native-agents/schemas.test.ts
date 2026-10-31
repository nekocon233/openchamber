import { describe, expect, test } from 'bun:test';

import { nativeCapabilitiesSchema, nativeCatalogSchema, nativeSessionListSchema } from './schemas';

const capabilities = () => ({
  supported: true as const,
  backends: {
    claude: { cli: true },
    codex: { cli: true },
  },
  registry: { reset: false },
});

describe('Antigravity native boundary schemas', () => {
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
