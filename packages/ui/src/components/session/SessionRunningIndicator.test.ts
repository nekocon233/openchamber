import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const indicatorSource = readFileSync(join(currentDirectory, 'SessionRunningIndicator.tsx'), 'utf8');
const nodeSource = readFileSync(join(currentDirectory, 'sidebar/SessionNodeItem.tsx'), 'utf8');
const switcherSource = readFileSync(join(currentDirectory, 'SessionSwitcherDropdown.tsx'), 'utf8');
const commandPaletteSource = readFileSync(join(currentDirectory, '../ui/CommandPalette.tsx'), 'utf8');
const syncSource = readFileSync(join(currentDirectory, '../../sync/sync-context.tsx'), 'utf8');
const cssSource = readFileSync(join(currentDirectory, '../../index.css'), 'utf8');

describe('shared running session indicator', () => {
  test('uses the shared spinner in every desktop session list', () => {
    expect(indicatorSource).toContain('name="loader-4"');
    expect(indicatorSource).toContain('text-[var(--status-info)]');
    expect(nodeSource).toContain('<SessionRunningIndicator');
    expect(nodeSource).toContain('useResolvedSessionStatusType(session.id, !archivedBucket)');
    expect(nodeSource).toContain('{ enabled: !archivedBucket }');
    expect(switcherSource).toContain('<SessionRunningIndicator');
    expect(commandPaletteSource).toContain('<SessionRunningIndicator');
  });

  test('uses per-session global-first status and preserves a reduced-motion glyph', () => {
    expect(syncSource).toContain('state.resolvedStatusById.get(sessionId)');
    expect(syncSource).toContain('resolveSessionStatusType(globalStatus, childStatus?.type)');
    expect(cssSource).toContain('.session-running-spinner');
    expect(cssSource).toContain('animation: none !important');
  });
});
