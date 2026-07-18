import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(__dirname, 'MobileSessionsSheet.tsx'), 'utf8');
const mobileAppSource = readFileSync(join(__dirname, 'MobileApp.tsx'), 'utf8');
const mobileTreeStoreSource = readFileSync(join(__dirname, '../stores/useMobileSessionTreeStore.ts'), 'utf8');

describe('MobileSessionsSheet activity sections', () => {
  test('sorts recent and pinned sessions from the same live message activity map', () => {
    expect(source).toContain('open && (showPinnedSection || showRecentSection)');
    expect(source).toContain('deriveRecentSessions(sessions, recentNow, messageActivityBySessionId)');
    expect(source).toContain('sortSessionsByActivity(');
    expect(source).toContain('sessions.filter((session) => pinnedSessionIds.has(session.id))');
    expect(source).toContain('if (!open || !showPinnedSection || normalizedQuery || editingOrder) return [];');
    expect(source).toContain('if (!open || !showRecentSection || normalizedQuery || editingOrder) return [];');
    expect(source).not.toContain('compareSessionsByPinnedAndTime');
  });

  test('renders pinned then recent before the project tree with persisted expansion and shared pagination', () => {
    const pinnedSectionIndex = source.indexOf("title={t('mobile.sessions.section.pinned')}");
    const recentSectionIndex = source.indexOf("title={t('sessions.sidebar.activity.recentTitle')}");
    const projectTreeIndex = source.indexOf('{orderedNodes.map');

    expect(pinnedSectionIndex).toBeGreaterThan(-1);
    expect(recentSectionIndex).toBeGreaterThan(pinnedSectionIndex);
    expect(projectTreeIndex).toBeGreaterThan(recentSectionIndex);
    expect(source).toContain('const MobileSessionActivityGroup: React.FC');
    expect(source).toContain('count + SESSIONS_PER_BUCKET');
    expect(source).toContain('expanded={pinnedSectionExpanded}');
    expect(source).toContain('onExpandedChange={setPinnedSectionExpanded}');
    expect(source).toContain('expanded={recentSectionExpanded}');
    expect(source).toContain('onExpandedChange={setRecentSectionExpanded}');
    expect(source).not.toContain('const [expanded, setExpanded] = React.useState(true)');
    expect(mobileTreeStoreSource).toContain('pinnedSectionExpanded: true');
    expect(mobileTreeStoreSource).toContain('recentSectionExpanded: true');
    expect(mobileTreeStoreSource).toContain("name: 'mobile-session-tree'");
  });

  test('uses persisted display preferences in the mobile editor and activity list', () => {
    expect(source).toContain('state.showPinnedSection');
    expect(source).toContain('state.showRecentSection');
    expect(source).toContain('state.setShowPinnedSection');
    expect(source).toContain('state.setShowRecentSection');
    expect(source).toContain("t('sessions.sidebar.header.displayMode.showPinned')");
    expect(source).toContain("t('sessions.sidebar.header.displayMode.showRecent')");
  });

  test('uses authoritative running status and exposes pin actions on mobile rows', () => {
    expect(source).toContain('useAllSessionStatuses()');
    expect(source).toContain("statusType === 'busy' || statusType === 'retry'");
    expect(source).toContain('name="loader-4"');
    expect(source).toContain("t('mobile.sessions.status.running')");
    expect(source).toContain('onTogglePinned={() => togglePinnedSession(session.id)}');
    expect(source).toContain("<Icon name={pinned ? 'unpin' : 'pushpin'}");
    expect(source).toContain('opencodeClient.getSessionStatusForDirectory(directory, { signal: controller.signal })');
    expect(source).toContain('applyGlobalSessionStatusSnapshot(directory, snapshot, sessionIds, baselineRevision)');
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
    expect(mobileAppSource).toContain(`{ipadSidebarOpen ? (
                <ErrorBoundary>
                  <MobileSessionsSheet`);
    expect(mobileAppSource).toContain(`{sessionsSheetOpen ? (
          <MobileSessionsSheet`);
    expect(mobileAppSource).not.toContain('active={ipadSidebarOpen}');
  });
});
