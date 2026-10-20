import React from 'react';
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Session } from '@/lib/opencode/model';
import { opencodeClient } from '@/lib/opencode/client';
import { warmChatsRootDirectory } from '@/lib/chatDirectories';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { EMPTY_MULTI_RUN_INDEX, buildMultiRunIndex } from '@/lib/multirun/runs';
import { withMultiRunMembership } from '@/lib/multirun/identity';
import { I18nProvider } from '@/lib/i18n';
import { SyncProvider } from '@/sync/sync-context';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { MobileTimelineRows, type TimelineProject, type TimelineRowHandlers } from './MobileTimelineList';
import { buildMobileTimelineEntries } from './mobileTimelineEntries';

const session = (id: string, directory = '/srv/chats/day/chat'): Session => ({
  id, directory, projectID: 'global', title: id, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
  metadata: { openchamber: { work: { state: 'open' } } },
});
const project: TimelineProject = { id: 'project', label: 'Project' };
const context = { project, branch: 'main', inSpace: false };
let runtime = 0;
let home = spyOn(opencodeClient, 'getFilesystemHomeInfo');
beforeEach(async () => {
  switchRuntimeEndpoint({ apiBaseUrl: 'http://timeline.test', runtimeKey: `chat-work-${++runtime}` });
  home = spyOn(opencodeClient, 'getFilesystemHomeInfo').mockResolvedValue({ home: '/home/user', chatsRoot: '/srv/chats' });
  await warmChatsRootDirectory();
});
afterEach(() => home.mockRestore());

test('chat rows survive without a project and retain their own routing directory', () => {
  const chat = session('Chat in work');
  const regular = session('Project in work', '/repo');
  const unknown = session('Unowned', '/elsewhere');
  const entries = buildMobileTimelineEntries([chat, regular, unknown], new Map([[regular.id, context]]), EMPTY_MULTI_RUN_INDEX, new Map());
  expect(entries).toEqual([
    { kind: 'session', session: chat, project: null, branch: null, inSpace: false },
    { kind: 'session', session: regular, ...context },
  ]);
  expect(entries[0].kind === 'session' && entries[0].session).toBe(chat);
});

test('chat and project rows render together in compact and detailed views', () => {
  const chat = session('Chat in work');
  const regular = session('Project in work', '/repo');
  const entries = buildMobileTimelineEntries([chat, regular], new Map([[regular.id, context]]), EMPTY_MULTI_RUN_INDEX, new Map());
  const noop = () => undefined;
  const handlers: TimelineRowHandlers = {
    currentSessionId: null, revealedSessionId: null, confirmingDeleteSessionId: null, renamingSessionId: null,
    onSelect: noop, onRevealedChange: noop, onArchive: noop, onRequestDelete: noop, onConfirmDelete: noop,
    onRequestRename: noop, onSubmitRename: noop, onCancelRename: noop, onToggleWork: noop,
    isPinned: () => false, onTogglePin: noop, descendantIdsOf: () => [],
  };
  for (const compact of [false, true]) {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ThemeSystemProvider>
          <SyncProvider sdk={opencodeClient.getSdkClient()} directory={chat.directory}>
            <MobileTimelineRows entries={entries} showProject compact={compact} handlers={handlers} />
          </SyncProvider>
        </ThemeSystemProvider>
      </I18nProvider>,
    );
    expect(markup).toContain(chat.title);
    expect(markup).toContain(regular.title);
    expect(markup).toContain('Mark done');
    expect(markup).not.toContain(chat.directory);
    if (!compact) expect(markup).toContain('Chats');
  }
});

test('chat rows do not change run collapsing or project order', () => {
  const lanes = ['lane-1', 'lane-2'].map((id) => {
    const record = session(id, '/repo');
    return { ...record, metadata: withMultiRunMembership(record.metadata ?? {}, {
      version: 1, sessionID: id, group: { kind: 'id', id: '9f512893-6e63-4e49-a534-5de733ca103e' },
      role: 'run', groupSlug: 'Compare', providerID: 'provider', modelID: id,
    }) };
  });
  const chat = session('chat');
  const runIndex = buildMultiRunIndex(lanes, () => '/repo');
  const entries = buildMobileTimelineEntries([lanes[0], chat, lanes[1]], new Map(lanes.map((lane) => [lane.id, context])), runIndex, new Map());
  expect(entries.map((entry) => entry.kind)).toEqual(['run', 'session']);
  expect(entries[0].kind === 'run' && entries[0].run.memberIds).toEqual(lanes.map((lane) => lane.id));
  expect(entries[1].project).toBeNull();
});
