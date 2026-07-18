import { beforeEach, describe, expect, test } from 'bun:test';
import type { Event } from '@opencode-ai/sdk/v2/client';

import {
  applyGlobalSessionStatusEvent,
  applyGlobalSessionStatusSnapshot,
  getGlobalSessionStatusRevision,
  resetGlobalSessionStatuses,
  setGlobalSessionStatus,
  useGlobalSessionStatusStore,
} from './global-session-status';

const statusEvent = (sessionID: string, type: 'busy' | 'retry' | 'idle'): Event => ({
  id: `evt-${sessionID}-${type}`,
  type: 'session.status',
  properties: { sessionID, status: { type } },
} as Event);

describe('global session status', () => {
  beforeEach(() => resetGlobalSessionStatuses());

  test('seeds running state from events and clears it with an authoritative empty snapshot', () => {
    applyGlobalSessionStatusEvent('/project', statusEvent('ses-1', 'busy'));
    expect(useGlobalSessionStatusStore.getState().statusById.get('ses-1')?.status).toBe('busy');
    expect(useGlobalSessionStatusStore.getState().resolvedStatusById.get('ses-1')).toBe('busy');

    applyGlobalSessionStatusSnapshot('/project', {}, ['ses-1']);
    expect(useGlobalSessionStatusStore.getState().statusById.has('ses-1')).toBe(false);
    expect(useGlobalSessionStatusStore.getState().resolvedStatusById.get('ses-1')).toBe('idle');
  });

  test('clears running state when a session is archived', () => {
    applyGlobalSessionStatusEvent('/project', statusEvent('ses-1', 'retry'));
    applyGlobalSessionStatusEvent('/project', {
      id: 'evt-archive',
      type: 'session.updated',
      properties: {
        sessionID: 'ses-1',
        info: { id: 'ses-1', time: { created: 1, updated: 2, archived: 3 } },
      },
    } as Event);

    expect(useGlobalSessionStatusStore.getState().statusById.has('ses-1')).toBe(false);
  });

  test('does not let a delayed empty snapshot erase a newer busy event', () => {
    const baselineRevision = getGlobalSessionStatusRevision();
    applyGlobalSessionStatusEvent('/project', statusEvent('ses-1', 'busy'));

    applyGlobalSessionStatusSnapshot('/project', {}, ['ses-1'], baselineRevision);

    expect(useGlobalSessionStatusStore.getState().statusById.get('ses-1')?.status).toBe('busy');
  });

  test('does not let a delayed busy snapshot resurrect a newer idle event', () => {
    applyGlobalSessionStatusEvent('/project', statusEvent('ses-1', 'busy'));
    const baselineRevision = getGlobalSessionStatusRevision();
    applyGlobalSessionStatusEvent('/project', statusEvent('ses-1', 'idle'));

    applyGlobalSessionStatusSnapshot('/project', { 'ses-1': { type: 'busy' } }, ['ses-1'], baselineRevision);

    expect(useGlobalSessionStatusStore.getState().statusById.has('ses-1')).toBe(false);
    expect(useGlobalSessionStatusStore.getState().resolvedStatusById.get('ses-1')).toBe('idle');
  });

  test('does not let a snapshot from a previous runtime repopulate reset state', () => {
    const baselineRevision = getGlobalSessionStatusRevision();
    resetGlobalSessionStatuses();

    applyGlobalSessionStatusSnapshot(
      '/project',
      { 'ses-old-runtime': { type: 'busy' } },
      ['ses-old-runtime'],
      baselineRevision,
    );

    expect(useGlobalSessionStatusStore.getState().statusById.has('ses-old-runtime')).toBe(false);
  });

  test('applies monotonic active snapshots without clearing known or explicit idle sessions', () => {
    applyGlobalSessionStatusEvent('/project', statusEvent('ses-existing', 'busy'));
    applyGlobalSessionStatusEvent('/project', statusEvent('ses-idle', 'busy'));

    applyGlobalSessionStatusSnapshot(
      '/project',
      {
        'ses-new': { type: 'retry' },
        'ses-idle': { type: 'idle' },
      },
      ['ses-existing', 'ses-idle', 'ses-new'],
      getGlobalSessionStatusRevision(),
      'monotonic',
    );

    const state = useGlobalSessionStatusStore.getState();
    expect(state.statusById.get('ses-existing')?.status).toBe('busy');
    expect(state.statusById.get('ses-idle')?.status).toBe('busy');
    expect(state.statusById.get('ses-new')?.status).toBe('retry');
    expect(state.resolvedStatusById.get('ses-new')).toBe('retry');
  });

  test('protects optimistic busy state from an overtaking idle snapshot for a bounded grace period', () => {
    const originalNow = Date.now;
    try {
      Date.now = () => 1_000;
      setGlobalSessionStatus('ses-optimistic', '/project', 'busy', { optimistic: true });
      const baselineRevision = getGlobalSessionStatusRevision();

      applyGlobalSessionStatusSnapshot('/project', {}, ['ses-optimistic'], baselineRevision);
      expect(useGlobalSessionStatusStore.getState().statusById.get('ses-optimistic')?.status).toBe('busy');

      Date.now = () => 11_001;
      applyGlobalSessionStatusSnapshot('/project', {}, ['ses-optimistic'], baselineRevision);
      expect(useGlobalSessionStatusStore.getState().statusById.has('ses-optimistic')).toBe(false);
      expect(useGlobalSessionStatusStore.getState().resolvedStatusById.get('ses-optimistic')).toBe('idle');
    } finally {
      Date.now = originalNow;
    }
  });

  test('bounds inactive status and revision history', () => {
    for (let index = 0; index < 2_100; index += 1) {
      setGlobalSessionStatus(`ses-${index}`, '/project', 'idle');
    }

    const state = useGlobalSessionStatusStore.getState();
    expect(state.resolvedStatusById.size <= 2_000).toBe(true);
    expect(state.revisionById.size <= 2_000).toBe(true);
    expect(state.revisionFloor).toBeGreaterThan(0);
  });
});
