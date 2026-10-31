import { describe, expect, test } from 'bun:test';
import {
  carrySurfaceToZone,
  reconcileZonePlacement,
  zoneOfMode,
  CLOSED_ZONE_VIEW,
  isZoneShown,
  resolveZoneActiveTab,
  keepZoneViewsOnTabs,
  zonePlacementSchema,
  zoneViewsSchema,
  settleZones,
  shownContextModes,
  type ContextZonePlacement,
  type ZonedPanel,
} from './zones';

const tab = (id: string, mode: 'file' | 'git' | 'terminal' | 'diff', touchedAt = 1) => ({ id, mode, touchedAt });

const panel = (patch: Partial<ZonedPanel> = {}): ZonedPanel => ({
  isOpen: false,
  expanded: false,
  activeTabId: null,
  tabs: [tab('git', 'git'), tab('file:a', 'file'), tab('terminal', 'terminal')],
  zones: { left: CLOSED_ZONE_VIEW, bottom: CLOSED_ZONE_VIEW },
  ...patch,
});

describe('workspace zones', () => {
  test('a zone never shows a tab whose surface is placed elsewhere', () => {
    const placement: ContextZonePlacement = { file: 'left' };
    const state = panel({ isOpen: true, activeTabId: 'file:a' });

    // The right zone named the file tab before Files moved left.
    expect(resolveZoneActiveTab(state, placement, 'right', 'right')?.id).toBe('terminal');
    expect(resolveZoneActiveTab(state, placement, 'left', 'right')?.id).toBe('file:a');
  });

  test('shown modes list one surface per open zone', () => {
    const placement: ContextZonePlacement = { terminal: 'bottom' };
    const state = panel({
      isOpen: true,
      activeTabId: 'git',
      zones: { left: CLOSED_ZONE_VIEW, bottom: { isOpen: true, expanded: false, activeTabId: 'terminal' } },
    });

    expect([...shownContextModes(state, placement, 'right')].sort()).toEqual(['git', 'terminal']);
    expect(isZoneShown(state, placement, 'left', 'right')).toBe(false);
  });

  test('settling closes a zone left without tabs and drops its expansion', () => {
    const state = panel({ zones: { left: { isOpen: true, expanded: true, activeTabId: 'gone' }, bottom: CLOSED_ZONE_VIEW } });

    expect(settleZones(state, {}, 'right').zones.left).toEqual(CLOSED_ZONE_VIEW);
  });

  test('a surface on screen takes its zone along, and the zone it left closes', () => {
    const state = panel({ isOpen: true, expanded: true, activeTabId: 'file:a' });
    const moved = carrySurfaceToZone(state, 'file', 'right', 'left', { file: 'left' }, 'right');

    expect(moved.zones.left).toEqual({ isOpen: true, expanded: false, activeTabId: 'file:a' });
    expect(moved.isOpen).toBe(false);
    expect(moved.expanded).toBe(false);
  });

  test('a surface off screen moves without opening anything', () => {
    const state = panel({ isOpen: true, activeTabId: 'git' });
    const moved = carrySurfaceToZone(state, 'terminal', 'right', 'bottom', { terminal: 'bottom' }, 'right');

    expect(moved.zones.bottom.isOpen).toBe(false);
    expect(moved.isOpen).toBe(true);
    expect(moved.activeTabId).toBe('git');
  });

  test('placement keeps explicit right as well as left and bottom', () => {
    expect(zonePlacementSchema.parse({
      file: 'left',
      terminal: 'bottom',
      git: 'right',
      diff: 'top',
      'plugin:notes-x': 'left',
      'not a mode': 'left',
    })).toEqual({ file: 'left', terminal: 'bottom', git: 'right', 'plugin:notes-x': 'left' });
    expect(zonePlacementSchema.parse('left')).toEqual({});
    expect(zonePlacementSchema.parse(undefined)).toEqual({});
  });

  test('built-in and future plugin modes follow the layout unless explicitly placed', () => {
    for (const mode of ['git', 'diff', 'terminal', 'plugin:future-panel'] as const) {
      expect(zoneOfMode({}, mode, 'left')).toBe('left');
      expect(zoneOfMode({}, mode, 'right')).toBe('right');
      const placement: ContextZonePlacement = {};
      placement[mode] = 'right';
      expect(zoneOfMode(placement, mode, 'left')).toBe('right');
      placement[mode] = 'bottom';
      expect(zoneOfMode(placement, mode, 'left')).toBe('bottom');
    }
  });

  test('a layout change carries visible tabs and keeps a manual terminal below', () => {
    const state = panel({
      isOpen: true, expanded: true, activeTabId: 'git',
      zones: { left: CLOSED_ZONE_VIEW, bottom: { isOpen: true, expanded: false, activeTabId: 'terminal' } },
    });
    const next = reconcileZonePlacement(state, { terminal: 'bottom' }, 'left');
    expect(next.tabs).toBe(state.tabs);
    expect(next.isOpen).toBe(false);
    expect(next.expanded).toBe(false);
    expect(next.zones.left).toEqual({ isOpen: true, expanded: false, activeTabId: 'git' });
    expect(next.zones.bottom).toBe(state.zones.bottom);
    expect(reconcileZonePlacement(next, { terminal: 'bottom' }, 'left')).toBe(next);
  });

  test('collisions keep the latest visible tab and preserve the destination on a tie', () => {
    for (const touchedAt of [1, 2, 3]) {
      const state = panel({
        isOpen: true, activeTabId: 'git',
        tabs: [tab('git', 'git', touchedAt), tab('file:a', 'file', 2)],
        zones: { left: { isOpen: true, expanded: false, activeTabId: 'file:a' }, bottom: CLOSED_ZONE_VIEW },
      });
      const next = reconcileZonePlacement(state, { file: 'left' }, 'left');
      expect(next.tabs).toBe(state.tabs);
      expect(next.isOpen).toBe(false);
      expect(next.zones.left.activeTabId).toBe(touchedAt > 2 ? 'git' : 'file:a');
    }
  });

  test('changing defaults does not open closed tabs', () => {
    const next = reconcileZonePlacement(panel(), {}, 'left');
    expect(shownContextModes(next, {}, 'left').size).toBe(0);
    expect(next.tabs).toHaveLength(3);
  });

  test('stored zone views load closed when missing, malformed or pointing at a closed tab', () => {
    const ids = new Set(['git']);
    expect(keepZoneViewsOnTabs(zoneViewsSchema.parse(undefined), ids)).toEqual({ left: CLOSED_ZONE_VIEW, bottom: CLOSED_ZONE_VIEW });
    expect(keepZoneViewsOnTabs(zoneViewsSchema.parse({ left: 'open' }), ids)).toEqual({ left: CLOSED_ZONE_VIEW, bottom: CLOSED_ZONE_VIEW });
    expect(keepZoneViewsOnTabs(zoneViewsSchema.parse({ left: { isOpen: true, expanded: true, activeTabId: 'gone' } }), ids).left).toEqual(CLOSED_ZONE_VIEW);
    expect(keepZoneViewsOnTabs(zoneViewsSchema.parse({ bottom: { isOpen: true, expanded: false, activeTabId: 'git' } }), ids).bottom)
      .toEqual({ isOpen: true, expanded: false, activeTabId: 'git' });
  });
});
