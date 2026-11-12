import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test } from 'bun:test';
import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import type { Session } from '@/lib/opencode/model';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useBackgroundShellsStore } from './background-shells';
import { useGlobalSessionStatusStore } from './global-session-status';
import { usePrWatchStore } from './pr-watch';
import { useSessionBackgroundTasksStore } from './session-background-tasks';
import { useWorkflowActivityStore } from './workflow-activity';
import { useOpenTurnSessionIds } from './use-open-turn-session-ids';

const session = (id: string, parentID?: string): Session => {
  // SAFETY: the global session index reads these identity, hierarchy and time fields from the fixture.
  return { id, parentID, directory: '/repo', time: { created: 1, updated: 1 } } as Session;
};

test('live activity orders unopened sessions and follows hierarchy, background work and visibility', async () => {
  const dom = installHookTestDom();
  const root = createRoot(dom.container);
  const oldStatus = useGlobalSessionStatusStore.getState();
  const oldShells = useBackgroundShellsStore.getState();
  const oldTasks = useSessionBackgroundTasksStore.getState();
  const oldWorkflows = useWorkflowActivityStore.getState();
  const oldWatches = usePrWatchStore.getState();
  const oldSessions = useGlobalSessionsStore.getState();
  const captured = React.createRef<ReadonlySet<string>>();
  let renders = 0;
  const Harness = ({ enabled = true }: { enabled?: boolean }) => {
    renders += 1;
    captured.current = useOpenTurnSessionIds(enabled);
    return null;
  };
  try {
    await act(async () => {
      useGlobalSessionsStore.getState().applySnapshot([], []);
      useGlobalSessionStatusStore.setState({ activeSessionIds: new Set(['child']) });
      useBackgroundShellsStore.setState({ sessionIds: new Set(['shell']) });
      useSessionBackgroundTasksStore.setState({ tasksBySession: new Map([['task', [{ id: '1', type: 'job', description: 'one' }]]]) });
      useWorkflowActivityStore.setState({ runningSessionIds: new Set(['workflow']) });
      usePrWatchStore.setState({ bySession: new Map([['watch', { sessionID: 'watch', directory: '/repo', url: 'https://example.test/pr/1', number: 1, title: '', status: 'pending', startedAt: 1 }]]) });
      root.render(<Harness />);
    });
    expect([...captured.current ?? []].sort()).toEqual(['child', 'shell', 'task', 'watch', 'workflow']);

    // The parent arrives after the busy event; it must move up without another status event.
    await act(async () => useGlobalSessionsStore.getState().applySnapshot([session('parent'), session('child', 'parent')], []));
    expect(captured.current?.has('parent')).toBe(true);
    const beforeDetails = renders;
    await act(async () => useSessionBackgroundTasksStore.setState({ tasksBySession: new Map([['task', [{ id: '1', type: 'job', description: 'updated' }]]]) }));
    expect(renders).toBe(beforeDetails);

    await act(async () => root.render(<Harness enabled={false} />));
    const held = captured.current;
    await act(async () => {
      useGlobalSessionStatusStore.setState({ activeSessionIds: new Set() });
      useBackgroundShellsStore.setState({ sessionIds: new Set() });
      useSessionBackgroundTasksStore.setState({ tasksBySession: new Map() });
      useWorkflowActivityStore.setState({ runningSessionIds: new Set() });
      usePrWatchStore.setState({ bySession: new Map() });
    });
    expect(captured.current).toBe(held);
    await act(async () => root.render(<Harness />));
    expect([...captured.current ?? []]).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    useGlobalSessionStatusStore.setState(oldStatus);
    useBackgroundShellsStore.setState(oldShells);
    useSessionBackgroundTasksStore.setState(oldTasks);
    useWorkflowActivityStore.setState(oldWorkflows);
    usePrWatchStore.setState(oldWatches);
    useGlobalSessionsStore.setState(oldSessions);
    dom.restore();
  }
});
