import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const indicatorSource = readFileSync(join(currentDirectory, 'SessionRunningIndicator.tsx'), 'utf8');
const nodeSource = readFileSync(join(currentDirectory, 'sidebar/SessionNodeItem.tsx'), 'utf8');
const switcherSource = readFileSync(join(currentDirectory, 'SessionSwitcherDropdown.tsx'), 'utf8');
const mobileSessionsSource = readFileSync(join(currentDirectory, '../../apps/MobileSessionsSheet.tsx'), 'utf8');
const mobileSwitcherSource = readFileSync(join(currentDirectory, '../../apps/MobileSessionSwitcher.tsx'), 'utf8');
const commandPaletteSource = readFileSync(join(currentDirectory, '../ui/CommandPalette.tsx'), 'utf8');
const collapsedIndicatorSource = readFileSync(join(currentDirectory, 'sidebar/collapsedActivityIndicator.tsx'), 'utf8');
const sidebarSource = readFileSync(join(currentDirectory, 'SessionSidebar.tsx'), 'utf8');
const syncSource = readFileSync(join(currentDirectory, '../../sync/sync-context.tsx'), 'utf8');
const cssSource = readFileSync(join(currentDirectory, '../../index.css'), 'utf8');
const projectAggregateSource = sidebarSource.slice(
  sidebarSource.indexOf('const ProjectAggregateStatusIndicator'),
  sidebarSource.indexOf('const SessionSidebarComponent'),
);

describe('shared running session indicator', () => {
  test('uses the shared spinner in every individual session list', () => {
    expect(indicatorSource).toContain('name="loader-4"');
    expect(indicatorSource).toContain('text-[var(--status-info)]');
    expect(nodeSource).toContain('<SessionRunningIndicator');
    expect(nodeSource).toContain('const statusMarkerContent = isStreaming ? (');
    expect(nodeSource).toContain('useResolvedSessionStatusType(session.id, !archivedBucket)');
    expect(nodeSource).toContain('{ enabled: !archivedBucket }');
    expect(switcherSource).toContain('<SessionRunningIndicator');
    expect(mobileSessionsSource).toContain('<SessionRunningIndicator');
    expect(mobileSwitcherSource).toContain('<SessionRunningIndicator');
    expect(commandPaletteSource).toContain('<SessionRunningIndicator');
  });

  test('keeps unread and collapsed aggregate markers as static dots', () => {
    expect(nodeSource).toContain('className="h-1.5 w-1.5 rounded-full bg-[var(--status-info)]"');
    expect(mobileSessionsSource).toContain('className="size-1.5 rounded-full bg-[var(--status-info)]"');
    expect(mobileSwitcherSource).toContain('className="size-1.5 rounded-full bg-[var(--status-info)]"');
    expect(nodeSource).toContain('role="img"');
    expect(mobileSwitcherSource).toContain('role="img"');
    expect(mobileSwitcherSource).toContain('aria-label={unreadStatusLabel}');
    expect(collapsedIndicatorSource).not.toContain('SessionRunningIndicator');
    expect(collapsedIndicatorSource).not.toContain('animate-spin');
    expect(projectAggregateSource).not.toContain('SessionRunningIndicator');
    expect(projectAggregateSource).not.toContain('animate-spin');
  });

  test('uses per-session global-first status and preserves a reduced-motion glyph', () => {
    expect(syncSource).toContain('state.resolvedStatusById.get(sessionId)');
    expect(syncSource).toContain('resolveSessionStatusType(globalStatus, activeStatus?.type)');
    expect(cssSource).toContain('.session-running-spinner');
    expect(cssSource).toContain('animation: none !important');
  });
});
