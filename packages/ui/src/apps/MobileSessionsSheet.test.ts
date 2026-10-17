import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(__dirname, 'MobileSessionsSheet.tsx'), 'utf8');
const mobileAppSource = readFileSync(join(__dirname, 'MobileApp.tsx'), 'utf8');

describe('MobileSessionsSheet session structure', () => {
  test('partitions managed chats and derives the Pinned and In work zones', () => {
    expect(source).toContain('partitionSidebarSessions(sessions, false)');
    expect(source).toContain('sessions: orderSessionsByLifecycleScopes(sectionChatSessions, pinnedSessionIds, sessionOrderRanks)');
    expect(source).toContain('const pinnedZoneSessionIds = React.useMemo');
    expect(source).toContain('isSessionPinned(pinnedSessionIds, directory || null, session.id)');
    expect(source).toContain('const workSessionIds = React.useMemo');
    expect(source).toContain('isSessionInWork(session)');
    expect(source).toContain('getDescendantIds(childrenBySessionId, session.id)');
    expect(source).toContain("const presented = open || variant === 'sidebar'");
    expect(source).toContain('for (const session of projectSessions)');
  });

  test('sorts the Pinned zone with open turns before recent activity', () => {
    expect(source).toContain('comparePinnedZoneSessions');
    expect(source).toContain('getOpenTurnSessionIds(activeSessionIds, backgroundShellSessionIds, backgroundTasksBySession)');
    expect(source).toContain('{ compareRoots: (left, right) => comparePinnedZoneSessions(left, right, sessionOrderRanks, openTurnSessionIds) }');
    expect(source).toContain('heldActiveSessionIdsRef');
    expect(source).toContain('heldBackgroundShellIdsRef');
    expect(source).toContain('heldBackgroundTasksRef');
  });

  test('renders Chats, Pinned and In work, then the project tree with stable bucket identity', () => {
    const chatsSectionIndex = source.indexOf("const chatsLabel = t('mobile.sessions.section.chats')");
    const pinnedSectionIndex = source.indexOf('renderZoneSection(PINNED_SECTION_ID');
    const workSectionIndex = source.indexOf('renderZoneSection(WORK_SECTION_ID');
    const projectTreeIndex = source.indexOf('orderedNodes.map');

    expect(chatsSectionIndex).toBeGreaterThan(-1);
    expect(pinnedSectionIndex).toBeGreaterThan(chatsSectionIndex);
    expect(workSectionIndex).toBeGreaterThan(pinnedSectionIndex);
    expect(projectTreeIndex).toBeGreaterThan(workSectionIndex);
    expect(source).toContain('const chatsBucketKey = `${CHAT_DRAFT_PROJECT_ID}::${CHAT_DRAFT_PROJECT_ID}`');
    expect(source).toContain('alwaysVisibleIds: pinnedChatIds');
    expect(source).toContain('renderBucketSessions(`${node.project.id}::${rootBucket.key}`, rootBucket, 0)');
    expect(source).toContain('renderBucketSessions(`${node.project.id}::${bucket.key}`, bucket, 1)');
  });

  test('uses the persisted display preferences in a mobile header menu', () => {
    expect(source).toContain('const showPinnedSection = useSessionDisplayStore');
    expect(source).toContain('const showChatsSection = useSessionDisplayStore');
    expect(source).toContain('const showWorkSection = useSessionDisplayStore');
    expect(source).toContain("renderMenuChoice('chats', 'sessions.sidebar.header.displayMode.showChats', showChatsSection, handleToggleChatsSection)");
    expect(source).toContain("renderMenuChoice('pinned', 'sessions.sidebar.header.displayMode.showPinned', showPinnedSection, handleTogglePinnedSection)");
    expect(source).toContain("renderMenuChoice('work', 'sessions.sidebar.header.displayMode.showWork', showWorkSection, handleToggleWorkSection)");
    // The menu entry is worthless without the guard: the section has to obey it.
    expect(source).toContain('if (!showChatsSection) return null;');
    expect(source).toContain('void updateDesktopSettings({ sidebarShowChatsSection: next });');
    expect(source).toContain('visibleSessions.filter((session) =>');
  });

  test('lets the In work section be switched off, and says so when it is empty', () => {
    expect(source).toContain("renderZoneSection(WORK_SECTION_ID, 'eye', t('sessions.sidebar.work.title'), workTimelineEntries, { emptyLabel: t('sessions.sidebar.work.empty') })");
    // The zone may not render without its label, or the toggle would have
    // nothing to show whenever no session is in work.
    expect(source).toContain('if (entries.length === 0 && !emptyLabel) return null;');
    // A row's Track/Done reads the session, not the zone: hiding the zone
    // must not change what the row offers.
    expect(source).toContain('const inWork = isSessionInWork(session);');
  });

  test('starts every row and section label in one text column', () => {
    expect(source).toContain('const MOBILE_ROW_TEXT_INSET = treeTextLeft(0)');
    // Chats rows, their Show more rows and the empty note all land in it.
    expect(source).toContain('indent={MOBILE_ROW_TEXT_INSET}');
    expect(source).toContain('const controlIndent = depth === null ? MOBILE_ROW_TEXT_INSET : treeTextLeft(depth)');
    expect(source).toContain('style={{ paddingInlineStart: MOBILE_ROW_TEXT_INSET }}');
    // The Pinned and In work timeline rows take the same column from the sheet.
    expect(source).toContain('indent={MOBILE_ROW_TEXT_INSET} handlers={timelineHandlers}');
    expect(source).not.toContain('TIMELINE_CHAT_INDENT');
  });

  test('uses authoritative activity, exposes pin actions, and keeps mobile sheets mounted', () => {
    expect(source).toContain('useAllSessionStatuses()');
    expect(source).toContain('useSessionTurnActivity(session.id)');
    expect(source).toContain('useHasSessionActivityDuration(session.id, isStreaming)');
    expect(source).toContain('<SessionActivityDuration');
    expect(source).toContain('running={isStreaming}');
    expect(source).toContain('<SessionActivityIndicator');
    expect(source).not.toContain("t('mobile.sessions.status.running')");
    expect(source).toContain('togglePinnedSession({');
    expect(source).toContain('directory: sessionDirectory');
    expect(source).toContain('sessionId: session.id');
    expect(source).toContain("<Icon name={pinned ? 'unpin' : 'pushpin'}");
    expect(source).toContain('readDirectoryStatuses(directory, { signal: controller.signal })');
    expect(source).toContain("applyGlobalSessionStatusSnapshot(directory, snapshot.statuses, sessionIds, baselineRevision, 'authoritative', snapshot.covers)");
    expect(source).toContain('state.resolvedStatusById');
    expect(source.indexOf('const globalStatus = globalResolvedStatusById.get(sessionId);')).toBeLessThan(
      source.indexOf('const liveStatus = sessionStatuses[sessionId]?.type;'),
    );
    expect(source).not.toContain('useSyncDirectoryStore');
    expect(source).toContain('.sort((a, b) => a.lastPolledAt - b.lastPolledAt || a.index - b.index)');
    expect(source).toContain('.slice(0, STATUS_POLL_DIRECTORY_LIMIT)');
    expect(source).toContain('getGlobalSessionStatusRevision()');
    expect(source).toContain('STATUS_POLL_REQUEST_TIMEOUT_MS');
    expect(source).toContain('fetchSessionStatusSnapshot(directory, controller.signal)');
    expect(source).toContain('for (const controller of activeRequests) controller.abort();');
    expect(source).toContain('useAllAuthoritativeLiveSessionIds()');
    expect(source).toContain('!archivedIds.has(session.id)');
    expect(source).toContain('!hasAuthoritativeGlobalSessions || authoritativeLiveSessionIds.has(session.id)');
    expect(mobileAppSource).toContain(`<MobileSessionsSheet
                  open
                  variant="sidebar"`);
    expect(mobileAppSource).toContain(`{!isTabletLayout ? (
          <MobileSessionsSheet`);
    expect(mobileAppSource).toContain('open={sessionsSheetOpen}');
    expect(mobileAppSource).not.toContain(`{sessionsSheetOpen ? (
          <MobileSessionsSheet`);
  });
});
