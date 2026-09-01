import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(__dirname, 'MobileSessionsSheet.tsx'), 'utf8');
const mobileAppSource = readFileSync(join(__dirname, 'MobileApp.tsx'), 'utf8');

describe('MobileSessionsSheet session structure', () => {
  test('partitions managed chats from project sessions', () => {
    expect(source).toContain('partitionSidebarSessions(sessions, false)');
    expect(source).toContain('sessions: orderSessionsByLifecycleScopes(chatSessions');
    expect(source).toContain('for (const session of projectSessions)');
    expect(source).not.toContain('deriveRecentSessions(');
  });

  test('renders managed chats before the project tree with stable bucket identity', () => {
    const chatsSectionIndex = source.indexOf("const chatsLabel = t('mobile.sessions.section.chats')");
    const projectTreeIndex = source.indexOf('{orderedNodes.map');

    expect(chatsSectionIndex).toBeGreaterThan(-1);
    expect(projectTreeIndex).toBeGreaterThan(chatsSectionIndex);
    expect(source).toContain('renderBucketSessions(chatsBucketKey, chatsBucket, PROJECT_SESSION_INDENT)');
    expect(source).toContain('renderBucketSessions(`${node.project.id}::${bucket.key}`, bucket, PROJECT_SESSION_INDENT)');
  });

  test('uses authoritative activity, exposes pin actions, and keeps mobile sheets mounted', () => {
    expect(source).toContain('useAllSessionStatuses()');
    expect(source).toContain("statusType === 'busy' || statusType === 'retry'");
    expect(source).toContain('useHasSessionActivityDuration(session.id, isStreaming)');
    expect(source).toContain('<SessionActivityDuration');
    expect(source).toContain('running={isStreaming}');
    expect(source).toContain('<SessionRunningIndicator');
    expect(source).toContain('className="size-1.5 rounded-full bg-[var(--status-info)]"');
    expect(source.match(/aria-describedby=\{statusLabel \? statusDescriptionId : undefined\}/g)).toHaveLength(2);
    expect(source).toContain('aria-describedby={statusDescriptionId}');
    expect(source).not.toContain('disabled={!hasChildren || !onToggleChildren}');
    expect(source).not.toContain("t('mobile.sessions.status.running')");
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
