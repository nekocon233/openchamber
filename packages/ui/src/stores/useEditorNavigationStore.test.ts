import { beforeEach, describe, expect, test } from 'bun:test';
import { useEditorNavigationStore } from './useEditorNavigationStore';

describe('useEditorNavigationStore', () => {
  beforeEach(() => {
    useEditorNavigationStore.setState({ byDirectory: {} });
  });

  test('records jumps and steps backward and forward across files and lines', () => {
    const store = useEditorNavigationStore.getState();
    const stopA = { path: '/repo/a.ts', line: 10, column: 3 };
    const stopB = { path: '/repo/b.ts', line: 25, column: 5 };
    const stopC = { path: '/repo/c.ts', line: 40, column: 1 };

    store.recordJump('/repo', stopA, stopB);
    store.recordJump('/repo', stopB, stopC);

    expect(useEditorNavigationStore.getState().byDirectory['/repo'].backStack).toEqual([stopA, stopB]);

    const back1 = store.stepBack('/repo', stopC);
    expect(back1).toEqual(stopB);
    expect(useEditorNavigationStore.getState().byDirectory['/repo'].forwardStack).toEqual([stopC]);

    const back2 = store.stepBack('/repo', stopB);
    expect(back2).toEqual(stopA);

    const forward1 = store.stepForward('/repo', stopA);
    expect(forward1).toEqual(stopB);

    const forward2 = store.stepForward('/repo', stopB);
    expect(forward2).toEqual(stopC);
  });

  test('ignores same-line jumps and clears forward history on a new jump', () => {
    const store = useEditorNavigationStore.getState();
    const stopA = { path: '/repo/a.ts', line: 10, column: 1 };
    const stopA2 = { path: '/repo/a.ts', line: 10, column: 8 };
    const stopB = { path: '/repo/b.ts', line: 4, column: 1 };

    store.recordJump('/repo', stopA, stopA2);
    expect(useEditorNavigationStore.getState().byDirectory['/repo']).toBeUndefined();

    store.recordJump('/repo', stopA, stopB);
    store.stepBack('/repo', stopB);
    expect(useEditorNavigationStore.getState().byDirectory['/repo'].forwardStack).toHaveLength(1);

    store.recordJump('/repo', stopA, { path: '/repo/d.ts', line: 1, column: 1 });
    expect(useEditorNavigationStore.getState().byDirectory['/repo'].forwardStack).toEqual([]);
  });
});
