import { describe, expect, it } from 'vitest';

import { NativeAgentError } from '../errors.js';
import { createDeepseekSetup } from './setup.js';

describe('one-click DeepSeek setup', () => {
  it('shares one install job and reports ready', async () => {
    let complete;
    const installing = new Promise((resolve) => { complete = resolve; });
    let installs = 0;
    const setup = createDeepseekSetup({
      enterpriseMode: () => false,
      installation: { prepare: () => { installs += 1; return installing; }, shutdown: async () => {} },
    });
    expect(setup.start()).toEqual({ state: 'installing' });
    expect(setup.start()).toEqual({ state: 'installing' });
    expect(installs).toBe(1);
    complete();
    await expect.poll(() => setup.status().state).toBe('ready');
    expect(setup.status()).toEqual({ state: 'ready' });
    await setup.shutdown();
  });

  it('reports only a stable error code and lets a later click retry', async () => {
    let calls = 0;
    const setup = createDeepseekSetup({
      enterpriseMode: () => false,
      installation: {
        prepare: async () => {
          if (calls++ === 0) throw new NativeAgentError('fixture credential must never be returned', { code: 'NATIVE_DEEPSEEK_NPM_MISSING', status: 503 });
        },
        shutdown: async () => {},
      },
    });
    setup.start();
    await expect.poll(() => setup.status().state).toBe('error');
    expect(setup.status()).toEqual({ state: 'error', code: 'NATIVE_DEEPSEEK_NPM_MISSING' });
    setup.start();
    await expect.poll(() => setup.status().state).toBe('ready');
    await setup.shutdown();
  });

  it('refuses enterprise mode and cancels an existing install when policy changes', async () => {
    let blocked = true;
    let aborted = false;
    const setup = createDeepseekSetup({
      enterpriseMode: () => blocked,
      installation: {
        prepare: ({ signal }) => new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
        }),
        shutdown: async () => {},
      },
    });
    expect(() => setup.start()).toThrow();
    expect(() => setup.status()).toThrow();
    blocked = false;
    setup.start();
    blocked = true;
    expect(() => setup.status()).toThrow();
    await expect.poll(() => aborted).toBe(true);
    blocked = false;
    await expect.poll(() => setup.status().state).toBe('error');
    await setup.shutdown();
  });
});
