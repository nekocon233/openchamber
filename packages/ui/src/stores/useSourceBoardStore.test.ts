import { describe, expect, test } from 'bun:test';

import { useSourceBoardStore } from './useSourceBoardStore';

// What localStorage may hold: the store's own shape, an older or broken one, or anything else.
type StoredValue = string | { choices: string | Record<string, Record<string, string | number>>; listWidth?: number | string };

const merge = (persisted: StoredValue, current: ReturnType<typeof useSourceBoardStore.getState>) => {
  const options = useSourceBoardStore.persist.getOptions();
  if (!options.merge) throw new Error('The board store reads its own persisted shape');
  return options.merge(persisted, current);
};

describe('source board choice', () => {
  test('captures the original link and failure behavior separately for each focus request', () => {
    const store = useSourceBoardStore.getState();
    store.focusRepositoryItem('p1', 'pull', 'https://github.com/org/repo/pull/1', 'manual');
    expect(useSourceBoardStore.getState().repositoryFocus).toEqual({ projectId: 'p1', kind: 'pull', query: 'https://github.com/org/repo/pull/1', failureBehavior: 'manual' });
    store.focusRepositoryItem('p2', 'issue', 'https://github.com/other/repo/issues/2');
    expect(useSourceBoardStore.getState().repositoryFocus).toMatchObject({ projectId: 'p2', failureBehavior: 'automatic' });
    store.focusLinearIssue('PROJ-3', 'https://linear.app/workspace/issue/PROJ-3', 'manual');
    expect(useSourceBoardStore.getState().linearFocus).toEqual({ identifier: 'PROJ-3', url: 'https://linear.app/workspace/issue/PROJ-3', failureBehavior: 'manual' });
    store.clearRepositoryFocus();
    store.clearLinearFocus();
    expect(useSourceBoardStore.getState().repositoryFocus).toBeNull();
    expect(useSourceBoardStore.getState().linearFocus).toBeNull();
  });

  test('remembers project, tab and team per runtime', () => {
    useSourceBoardStore.setState({ choices: {} });
    useSourceBoardStore.getState().update({ projectId: 'p1' });
    useSourceBoardStore.getState().update({ tab: 'linear', linearTeamId: 't1' });
    const choices = Object.values(useSourceBoardStore.getState().choices);
    expect(choices).toEqual([{ projectId: 'p1', tab: 'linear', linearTeamId: 't1' }]);
  });

  test('keeps the readable parts of stored data and drops the rest', () => {
    const current = useSourceBoardStore.getState();
    expect(merge({ choices: { local: { projectId: 'p1', tab: 'nonsense', linearTeamId: 5 } } }, current).choices)
      .toEqual({ local: { projectId: 'p1', tab: 'repository', linearTeamId: null } });
    expect(merge('garbage', current).choices).toEqual({});
    expect(merge({ choices: {}, listWidth: 360 }, current).listWidth).toBe(360);
    expect(merge({ choices: {}, listWidth: 'wide' }, current).listWidth).toBeNull();
    expect(merge({ choices: 'garbage' }, current).choices).toEqual({});
  });
});
