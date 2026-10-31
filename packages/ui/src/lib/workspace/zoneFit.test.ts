import { describe, expect, test } from 'bun:test';
import { planZoneFit } from './zoneFit';
import { clampSidebarWidth, getSidebarWidth } from './sidebarGeometry';

describe('planZoneFit', () => {
  test('legacy and oversized sidebar widths use the same limits as the column', () => {
    // Dragging to zero reaches the minimum; a saved zero uses the initial width.
    expect(clampSidebarWidth(0)).toBe(264);
    for (const [saved, width] of [[168, 264], [0, 280], [420, 420], [800, 500]]) {
      expect(getSidebarWidth(saved)).toBe(width);
    }
  });

  test('a zone that fits beside the chat changes nothing', () => {
    expect(planZoneFit({ rowWidth: 1600, leftWidth: 480, rightWidth: 540, sidebarWidth: 280, opening: 'left' }))
      .toEqual({ collapseSidebar: false, displace: null });
  });

  test('the sidebar folds first when that is enough', () => {
    expect(planZoneFit({ rowWidth: 1300, leftWidth: 480, rightWidth: 540, sidebarWidth: 280, opening: 'left' }))
      .toEqual({ collapseSidebar: true, displace: null });
  });

  test('the zone on the other side gives way when the sidebar is not enough', () => {
    expect(planZoneFit({ rowWidth: 1000, leftWidth: 480, rightWidth: 540, sidebarWidth: 280, opening: 'left' }))
      .toEqual({ collapseSidebar: true, displace: 'right' });
  });

  test('with the sidebar already folded, the other side gives way at once', () => {
    expect(planZoneFit({ rowWidth: 1200, leftWidth: 480, rightWidth: 540, sidebarWidth: null, opening: 'right' }))
      .toEqual({ collapseSidebar: false, displace: 'left' });
  });

  test('nothing is displaced when no zone stands on the other side', () => {
    expect(planZoneFit({ rowWidth: 600, leftWidth: 480, rightWidth: 0, sidebarWidth: null, opening: 'left' }))
      .toEqual({ collapseSidebar: false, displace: null });
  });
});
