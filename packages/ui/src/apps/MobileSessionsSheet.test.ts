import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(__dirname, 'MobileSessionsSheet.tsx'), 'utf8');
const mobileAppSource = readFileSync(join(__dirname, 'MobileApp.tsx'), 'utf8');

describe('MobileSessionsSheet session structure', () => {
  test('partitions managed chats and derives Pinned and Recent activity sessions', () => {
    expect(source).toContain('partitionSidebarSessions(sessions, false)');
    expect(source).toContain('sessions: orderSessionsByLifecycleScopes(chatSessions');
    expect(source).toContain('derivePinnedSessions(sessions, pinnedSessionIds)');
    expect(source).toContain('deriveRecentSessions(sessions, globalActiveSessionIds)');
    expect(source).toContain('includeSessionDescendants(roots, sessions)');
    expect(source).toContain("const activitySectionsEnabled = open || variant === 'sidebar'");
    expect(source).toContain('for (const session of projectSessions)');
  });

  test('renders Pinned, Chats, Recent, then the project tree with stable bucket identity', () => {
    const pinnedSectionIndex = source.indexOf('showPinnedSection ? renderActivitySection');
    const chatsSectionIndex = source.indexOf('showChatsSection ? renderActivitySection');
    const recentSectionIndex = source.indexOf('showRecentSection ? renderActivitySection');
    const projectTreeIndex = source.indexOf('orderedNodes.map');

    expect(pinnedSectionIndex).toBeGreaterThan(-1);
    expect(chatsSectionIndex).toBeGreaterThan(pinnedSectionIndex);
    expect(recentSectionIndex).toBeGreaterThan(chatsSectionIndex);
    expect(projectTreeIndex).toBeGreaterThan(recentSectionIndex);
    expect(source).toContain('bucketKey: `${PINNED_SECTION_KEY}::${PINNED_SECTION_KEY}`');
    expect(source).toContain('bucketKey: chatsBucketKey');
    expect(source).toContain('renderBucketSessions(bucketKey, bucket, PROJECT_SESSION_INDENT)');
    expect(source).toContain('bucketKey: `${RECENT_SECTION_KEY}::${RECENT_SECTION_KEY}`');
    expect(source).toContain('renderBucketSessions(`${node.project.id}::${bucket.key}`, bucket, PROJECT_SESSION_INDENT)');
  });

  test('uses the persisted display preferences in a mobile header menu', () => {
    expect(source).toContain('const showPinnedSection = useSessionDisplayStore');
    expect(source).toContain('const showChatsSection = useSessionDisplayStore');
    expect(source).toContain('const showRecentSection = useSessionDisplayStore');
    expect(source).toContain('onClick={togglePinnedSection}');
    expect(source).toContain('onClick={toggleChatsSection}');
    expect(source).toContain('onClick={toggleRecentSection}');
    expect(source).toContain("t('sessions.sidebar.header.displayMode.showPinned')");
    expect(source).toContain("t('sessions.sidebar.header.displayMode.showChats')");
    expect(source).toContain("t('sessions.sidebar.header.displayMode.showRecent')");
    expect(source).toContain('visibleSessions.filter((session) =>');
  });

  test('uses authoritative activity, exposes pin actions, and keeps mobile sheets mounted', () => {
    expect(source).toContain('useAllSessionStatuses()');
    expect(source).toContain('useSessionTurnActive(session.id)');
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
