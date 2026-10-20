import { describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Session } from '@/lib/opencode/model';
import type { SessionNodeItemProps } from './SessionNodeItem';
import type { SessionTreeItemProps } from './SessionTreeItem';
import { installHookTestDom } from '../test-utils/testDom';
import { I18nProvider } from '@/lib/i18n';

const renderedRows: SessionNodeItemProps[] = [];

mock.module('./SessionNodeItem', () => ({
  SessionNodeItem: (props: SessionNodeItemProps) => {
    renderedRows.push(props);
    return null;
  },
}));

mock.module('./hooks/useSessionActions', () => ({
  useSessionActions: (args: {
    setEditingId: (id: string | null) => void;
    setEditTitle: (title: string) => void;
  }) => ({
    handleSaveEdit: () => undefined,
    handleCancelEdit: () => undefined,
    handleSessionSelect: () => undefined,
    handleSessionDoubleClick: (id: string, title: string) => {
      args.setEditingId(id);
      args.setEditTitle(title);
    },
    handleCopySessionId: () => undefined,
    handleDeleteSession: () => undefined,
    handleRestoreSession: () => undefined,
  }),
}));

const { SessionTreeItem } = await import('./SessionTreeItem');

const noopStartSessionWorktreeMenuLoad: SessionTreeItemProps['startSessionWorktreeMenuLoad'] = () => ({
  cachedTargets: [],
  refreshTargets: Promise.resolve([]),
});

const session = (id: string): Session => ({
  id,
  projectID: 'project',
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  title: 'Shared title',
  directory: '/workspace',
  time: { created: 1, updated: 1 },
});

describe('SessionTreeItem public behavior', () => {
  test('updates work actions for metadata-only changes and skips equivalent row rebuilds', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const noop = () => undefined;
    const ids = new Set<string>();
    const current = { ...session('chat'), metadata: { openchamber: { work: { state: 'open' } } } };
    const props: SessionTreeItemProps = {
      node: { session: current, children: [], worktree: null },
      pinnedSessionIds: ids, expandedParents: ids, hasSessionSearchQuery: false, normalizedSessionSearchQuery: '',
      notifyOnSubtasks: false, editingId: null, editingRowKey: null, editTitle: '', openSidebarMenuKey: null,
      setEditingId: noop, setEditingRowKey: noop, setEditTitle: noop, toggleParent: noop, setOpenSidebarMenuKey: noop,
      allowReselect: false, resetSessionSearch: noop, deleteSessionConfirm: null, setDeleteSessionConfirm: noop,
      startFolderRename: noop, startSessionWorktreeMenuLoad: noopStartSessionWorktreeMenuLoad,
      mobileVariant: false, alwaysShowActions: false, renderContext: 'tree-chat',
    };
    const render = () => act(async () => root.render(<I18nProvider><SessionTreeItem {...props} /></I18nProvider>));
    try {
      await render();
      expect(renderedRows).toHaveLength(1);
      for (let index = 0; index < 10; index += 1) {
        props.node = { ...props.node, session: { ...props.node.session }, children: [] };
        await render();
      }
      expect(renderedRows).toHaveLength(1);

      props.node = { ...props.node, session: { ...current, metadata: { openchamber: { work: { state: 'done' } } } } };
      await render();
      expect(renderedRows).toHaveLength(2);
      expect(renderedRows.at(-1)?.node.session.metadata).toEqual(props.node.session.metadata);

      props.node = { ...props.node, session: { ...props.node.session, time: { ...current.time, idle: 2 } } };
      await render();
      expect(renderedRows).toHaveLength(3);
    } finally {
      await act(async () => root.unmount());
      renderedRows.length = 0;
      dom.restore();
    }
  });

  test('keeps duplicate row state parent-owned while targeting one rename occurrence', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const sharedSession = session('same-session');
    const rowNode = { session: sharedSession, children: [], worktree: null };
    const noop = () => undefined;

    const Harness = () => {
      const [editingId, setEditingId] = React.useState<string | null>(null);
      const [editingRowKey, setEditingRowKey] = React.useState<string | null>(null);
      const [editTitle, setEditTitle] = React.useState('');
      const [menuKey, setMenuKey] = React.useState<string | null>(null);
      const rows = [
        { renderContext: 'project' as const, groupDirectory: '/workspace', rowKey: 'project:session:same-session' },
        { renderContext: 'timeline-mixed' as const, groupDirectory: '/workspace', rowKey: 'recent:session:same-session' },
      ];
      return <>{rows.map((context) => <SessionTreeItem
        key={context.renderContext}
        node={rowNode}
        pinnedSessionIds={new Set()}
        expandedParents={new Set()}
        hasSessionSearchQuery={false}
        normalizedSessionSearchQuery=""
        notifyOnSubtasks={false}
        editingId={editingId}
        editingRowKey={editingRowKey}
        setEditingId={setEditingId}
        setEditingRowKey={setEditingRowKey}
        editTitle={editTitle}
        setEditTitle={setEditTitle}
        toggleParent={noop}
        openSidebarMenuKey={menuKey}
        setOpenSidebarMenuKey={setMenuKey}
        allowReselect={false}
        resetSessionSearch={noop}
        deleteSessionConfirm={null}
        setDeleteSessionConfirm={noop}
        startFolderRename={noop}
        startSessionWorktreeMenuLoad={noopStartSessionWorktreeMenuLoad}
        mobileVariant={false}
        alwaysShowActions={false}
        {...context}
      />)}</>;
    };

    try {
      await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>));
      expect(renderedRows).toHaveLength(2);

      await act(async () => renderedRows[0]?.handleSessionDoubleClick(sharedSession.id, sharedSession.title));
      expect(renderedRows).toHaveLength(4);
      expect(renderedRows.slice(-2).map((row) => [row.editingId, row.editingRowKey, row.editTitle]))
        .toEqual([
          [sharedSession.id, 'project:session:same-session', sharedSession.title],
          [sharedSession.id, 'project:session:same-session', sharedSession.title],
        ]);

      await act(async () => renderedRows[3]?.setOpenSidebarMenuKey('session-menu:recent:session:same-session'));
      expect(renderedRows).toHaveLength(6);
      expect(renderedRows.slice(-2).map((row) => row.openSidebarMenuKey))
        .toEqual(['session-menu:recent:session:same-session', 'session-menu:recent:session:same-session']);
    } finally {
      await act(async () => root.unmount());
      renderedRows.length = 0;
      dom.restore();
    }
  });
});
