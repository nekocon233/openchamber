import { beforeEach, describe, expect, test } from 'bun:test';

import { useUIStore } from './useUIStore';

describe('useUIStore mobile workspace tabs', () => {
  beforeEach(() => {
    useUIStore.setState({ mobileWorkspaceTabOrder: [], mobileWorkspaceHiddenTabs: [] });
  });

  test('hides and shows tabs, but never the last one shown', () => {
    const { setMobileWorkspaceTabVisible } = useUIStore.getState();
    for (const tab of ['changes', 'files', 'terminal'] as const) setMobileWorkspaceTabVisible(tab, false);
    expect(useUIStore.getState().mobileWorkspaceHiddenTabs).toEqual(['changes', 'files', 'terminal']);

    setMobileWorkspaceTabVisible('notes', false);
    expect(useUIStore.getState().mobileWorkspaceHiddenTabs).toEqual(['changes', 'files', 'terminal']);

    setMobileWorkspaceTabVisible('files', true);
    expect(useUIStore.getState().mobileWorkspaceHiddenTabs).toEqual(['changes', 'terminal']);
  });

  test('stores a full order of known tabs', () => {
    useUIStore.getState().setMobileWorkspaceTabOrder(['notes', 'unknown', 'notes', 'mcp', 'files']);
    expect(useUIStore.getState().mobileWorkspaceTabOrder).toEqual(['changes', 'terminal', 'notes', 'files']);
  });

  test('can customize the fallback when Work Status was the only visible tab', () => {
    const hidden = ['changes', 'files', 'terminal', 'notes', 'plugin:offline'];
    useUIStore.setState({ mobileWorkspaceTabOrder: ['status'], mobileWorkspaceHiddenTabs: hidden });
    const { setMobileWorkspaceTabVisible } = useUIStore.getState();
    setMobileWorkspaceTabVisible('files', true);
    expect(useUIStore.getState().mobileWorkspaceHiddenTabs).toEqual(hidden);
    setMobileWorkspaceTabVisible('files', false);
    expect(useUIStore.getState().mobileWorkspaceHiddenTabs).toEqual(['plugin:offline', 'files']);
  });

  test('counts the extension tabs shown, and keeps a saved extension tab across a reorder without it', () => {
    const { setMobileWorkspaceTabVisible, setMobileWorkspaceTabOrder } = useUIStore.getState();
    for (const tab of ['changes', 'files', 'terminal'] as const) setMobileWorkspaceTabVisible(tab, false, ['plugin:tasks']);
    setMobileWorkspaceTabVisible('notes', false, ['plugin:tasks']);
    expect(useUIStore.getState().mobileWorkspaceHiddenTabs).toEqual(['changes', 'files', 'terminal', 'notes']);

    setMobileWorkspaceTabOrder(['changes', 'plugin:tasks', 'files', 'terminal', 'notes']);
    // The extension keeps its place after Git when another server omits it.
    setMobileWorkspaceTabOrder(['notes', 'changes', 'files', 'terminal']);
    expect(useUIStore.getState().mobileWorkspaceTabOrder).toEqual(['notes', 'changes', 'plugin:tasks', 'files', 'terminal']);
  });
});
