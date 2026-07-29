import { afterEach, describe, expect, test } from 'bun:test';

import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { getCurrentAppRouteState } from './useRouter';

const originalSessionState = {
  currentSessionId: useSessionUIStore.getState().currentSessionId,
  currentSessionDirectory: useSessionUIStore.getState().currentSessionDirectory,
};

const originalUIState = {
  activeMainTab: useUIStore.getState().activeMainTab,
  isSettingsDialogOpen: useUIStore.getState().isSettingsDialogOpen,
  settingsPage: useUIStore.getState().settingsPage,
  pendingDiffFile: useUIStore.getState().pendingDiffFile,
};

afterEach(() => {
  useSessionUIStore.setState(originalSessionState);
  useUIStore.setState(originalUIState);
});

describe('getCurrentAppRouteState', () => {
  test('includes the current session directory for cold-start routing', () => {
    useSessionUIStore.setState({
      currentSessionId: 'ses_history',
      currentSessionDirectory: '/workspace/project',
    });

    const route = getCurrentAppRouteState();
    expect({
      sessionId: route.sessionId,
      sessionDirectory: route.sessionDirectory,
    }).toEqual({
      sessionId: 'ses_history',
      sessionDirectory: '/workspace/project',
    });
  });
});
