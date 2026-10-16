import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const indicatorSource = readFileSync(join(currentDirectory, 'SessionRunningIndicator.tsx'), 'utf8');
const activityIndicatorSource = readFileSync(join(currentDirectory, 'SessionActivityIndicator.tsx'), 'utf8');
const nodeSource = readFileSync(join(currentDirectory, 'sidebar/sessions/SessionNodeItem.tsx'), 'utf8');
const switcherSource = readFileSync(join(currentDirectory, 'SessionSwitcherDropdown.tsx'), 'utf8');
const mobileSessionsSource = readFileSync(join(currentDirectory, '../../apps/MobileSessionsSheet.tsx'), 'utf8');
const mobileSwitcherSource = readFileSync(join(currentDirectory, '../../apps/MobileSessionSwitcher.tsx'), 'utf8');
const commandPaletteSource = readFileSync(join(currentDirectory, '../ui/CommandPalette.tsx'), 'utf8');
const collapsedIndicatorSource = readFileSync(join(currentDirectory, 'sidebar/sessions/collapsedActivityIndicator.tsx'), 'utf8');
const projectCollectionSource = readFileSync(join(currentDirectory, 'sidebar/list/SessionProjectCollection.tsx'), 'utf8');
const syncSource = readFileSync(join(currentDirectory, '../../sync/sync-context.tsx'), 'utf8');
const cssSource = readFileSync(join(currentDirectory, '../../index.css'), 'utf8');
const projectAggregateSource = projectCollectionSource.slice(
  projectCollectionSource.indexOf('const ProjectAggregateStatusIndicator'),
  projectCollectionSource.indexOf('type Project ='),
);

describe('shared running session indicator', () => {
  test('uses the shared spinner in every individual session list', () => {
    expect(indicatorSource).toContain('name="loader-4"');
    expect(indicatorSource).toContain('text-[var(--status-info)]');
    expect(nodeSource).toContain('<SessionActivityIndicator');
    expect(nodeSource).toContain("const statusMarkerContent = <SessionActivityIndicator state={turnActivity ?? 'unread'} tooltip />;");
    expect(nodeSource).toContain('useSessionTurnActivity(session.id)');
    expect(switcherSource).toContain('<SessionActivityIndicator');
    expect(mobileSessionsSource).toContain('<SessionActivityIndicator');
    expect(mobileSwitcherSource).toContain('<SessionActivityIndicator');
    expect(commandPaletteSource).toContain('<SessionRunningIndicator');
  });

  test('keeps unread and collapsed aggregate markers as static dots', () => {
    expect(activityIndicatorSource).toContain('{running && animated ? (');
    expect(activityIndicatorSource).toContain("unread: { icon: 'checkbox-circle'");
    expect(nodeSource).toContain("state={turnActivity ?? 'unread'}");
    expect(mobileSwitcherSource).toContain('<SessionActivityIndicator');
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
