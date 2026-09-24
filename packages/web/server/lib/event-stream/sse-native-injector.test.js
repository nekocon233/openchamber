import { describe, expect, it } from 'vitest';

import { createSseNativeEventInjector, formatGlobalSseFrame } from './sse-native-injector.js';

const createHarness = ({ atBoundary = true, maxPendingFrames = 4096, maxPendingBytes = 4 * 1024 * 1024 } = {}) => {
  const state = { atBoundary, listener: null, unsubscribed: false, written: [], overflows: 0 };
  const injector = createSseNativeEventInjector({
    subscribe: (listener) => {
      state.listener = listener;
      return () => {
        state.unsubscribed = true;
      };
    },
    isAtBoundary: () => state.atBoundary,
    write: (text) => state.written.push(text),
    onOverflow: () => {
      state.overflows += 1;
    },
    maxPendingFrames,
    maxPendingBytes,
  });
  return { state, injector };
};

const statusEvent = (sessionID) => ({
  directory: '/work/project',
  payload: { type: 'session.status', properties: { sessionID, status: { type: 'busy' } } },
});

describe('createSseNativeEventInjector', () => {
  it('frames events the way the OpenCode global stream does', () => {
    expect(formatGlobalSseFrame(statusEvent('ncl_a'))).toBe(
      'data: {"directory":"/work/project","payload":{"type":"session.status","properties":{"sessionID":"ncl_a","status":{"type":"busy"}}}}\n\n',
    );
  });

  it('writes an event at once when the stream is between blocks', () => {
    const { state } = createHarness();
    state.listener(statusEvent('ncl_a'));
    expect(state.written).toEqual([formatGlobalSseFrame(statusEvent('ncl_a'))]);
  });

  it('holds events while the upstream is mid-block and writes them in order at the next boundary', () => {
    const { state, injector } = createHarness({ atBoundary: false });
    state.listener(statusEvent('ncl_a'));
    state.listener(statusEvent('ncl_b'));
    injector.flush();
    expect(state.written).toEqual([]);

    state.atBoundary = true;
    injector.flush();
    expect(state.written).toEqual([
      formatGlobalSseFrame(statusEvent('ncl_a')) + formatGlobalSseFrame(statusEvent('ncl_b')),
    ]);
    injector.flush();
    expect(state.written).toHaveLength(1);
  });

  it('ends the stream once instead of dropping frames when pending frames exceed the bound', () => {
    const { state, injector } = createHarness({ atBoundary: false, maxPendingFrames: 2 });
    state.listener(statusEvent('ncl_a'));
    state.listener(statusEvent('ncl_b'));
    expect(state.overflows).toBe(0);
    state.listener(statusEvent('ncl_c'));
    expect(state.overflows).toBe(1);

    state.atBoundary = true;
    state.listener(statusEvent('ncl_d'));
    injector.flush();
    expect(state.written).toEqual([]);
    expect(state.overflows).toBe(1);
  });

  it('bounds pending bytes as well as frames', () => {
    const { state } = createHarness({ atBoundary: false, maxPendingBytes: 64 });
    state.listener(statusEvent('ncl_a'));
    expect(state.overflows).toBe(1);
  });

  it('unsubscribes when stopped', () => {
    const { state, injector } = createHarness();
    injector.stop();
    expect(state.unsubscribed).toBe(true);
  });
});
