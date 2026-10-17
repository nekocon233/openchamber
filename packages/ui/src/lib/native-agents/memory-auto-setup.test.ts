import { describe, expect, test } from 'bun:test';

import type { NativeMemoryStatus } from './memory-schemas';
import { NativeAgentsRequestError } from './errors';
import { autoConnectNativeMemory } from './memory-auto-setup';

const backend = (overrides: Partial<Extract<NativeMemoryStatus['backends'][number], { status: 'ok' }>> = {}) => ({
  status: 'ok' as const,
  backend: 'claude' as const,
  installed: false,
  ready: false,
  reviewRequired: false,
  lastSeen: null,
  ...overrides,
});

const status = (backends: NativeMemoryStatus['backends'], canManage = true): NativeMemoryStatus => ({
  enabled: true,
  canManage,
  backends,
  progress: [],
  sources: [],
});

describe('autoConnectNativeMemory', () => {
  test('skips installed backends instead of resetting their ready proof', async () => {
    const calls: string[] = [];
    const result = await autoConnectNativeMemory({
      memoryStatus: async () => status([
        backend({ installed: true, ready: true, lastSeen: 10 }),
        backend({ backend: 'codex', installed: true, ready: false }),
      ]),
      connectMemory: async (backend) => {
        calls.push(backend);
        return { backend, installed: true, ready: false, reviewRequired: false, lastSeen: null };
      },
    });

    expect(result).toEqual({ kind: 'ready', reviewRequired: false });
    expect(calls).toEqual([]);
  });

  test('connects only missing backends', async () => {
    const calls: string[] = [];
    const result = await autoConnectNativeMemory({
      memoryStatus: async () => status([
        backend({ installed: true, ready: true, lastSeen: 10 }),
        backend({ backend: 'codex' }),
      ]),
      connectMemory: async (backend) => {
        calls.push(backend);
        return { backend, installed: true, ready: false, reviewRequired: backend === 'codex', lastSeen: null };
      },
    });

    expect(result).toEqual({ kind: 'ready', reviewRequired: true });
    expect(calls).toEqual(['codex']);
  });

  test('continues after one backend fails and reports the partial failure', async () => {
    const calls: string[] = [];
    const result = await autoConnectNativeMemory({
      memoryStatus: async () => status([backend(), backend({ backend: 'codex' })]),
      connectMemory: async (backend) => {
        calls.push(backend);
        if (backend === 'claude') throw new Error('claude config is malformed');
        return { backend, installed: true, ready: false, reviewRequired: true, lastSeen: null };
      },
    });

    expect(result).toEqual({ kind: 'failed', reviewRequired: true });
    expect(calls).toEqual(['claude', 'codex']);
  });

  test('does not try to connect from a client that cannot manage the server', async () => {
    let called = false;
    const result = await autoConnectNativeMemory({
      memoryStatus: async () => status([backend()], false),
      connectMemory: async () => {
        called = true;
        throw new Error('unexpected connect');
      },
    });

    expect(result).toEqual({ kind: 'remote', reviewRequired: false });
    expect(called).toBe(false);
  });

  test('treats a local-management rejection during connect as remote', async () => {
    const result = await autoConnectNativeMemory({
      memoryStatus: async () => status([backend()]),
      connectMemory: async () => {
        throw new NativeAgentsRequestError('Connect terminal CLIs on the server computer', 403, 'NATIVE_MEMORY_LOCAL_REQUIRED');
      },
    });

    expect(result).toEqual({ kind: 'remote', reviewRequired: false });
  });

  test('reports a review already required by an installed backend without reconnecting it', async () => {
    let called = false;
    const result = await autoConnectNativeMemory({
      memoryStatus: async () => status([backend({ backend: 'codex', installed: true, reviewRequired: true })]),
      connectMemory: async () => {
        called = true;
        throw new Error('unexpected connect');
      },
    });

    expect(result).toEqual({ kind: 'ready', reviewRequired: true });
    expect(called).toBe(false);
  });

  test('marks an unavailable backend failed while still connecting the other one', async () => {
    const calls: string[] = [];
    const result = await autoConnectNativeMemory({
      memoryStatus: async () => status([
        { status: 'unavailable', backend: 'claude' },
        backend({ backend: 'codex' }),
      ]),
      connectMemory: async (backend) => {
        calls.push(backend);
        return { backend, installed: true, ready: false, reviewRequired: false, lastSeen: null };
      },
    });

    expect(result).toEqual({ kind: 'failed', reviewRequired: false });
    expect(calls).toEqual(['codex']);
  });

  test('fails closed when the status read fails', async () => {
    let called = false;
    const result = await autoConnectNativeMemory({
      memoryStatus: async () => { throw new Error('status unavailable'); },
      connectMemory: async () => {
        called = true;
        throw new Error('unexpected connect');
      },
    });

    expect(result).toEqual({ kind: 'failed', reviewRequired: false });
    expect(called).toBe(false);
  });
});
