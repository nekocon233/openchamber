import { describe, expect, test } from 'bun:test';
import { computeZoneDropTargets, hitTestZoneDropTargets } from './zoneDropTargets';

describe('zone drop targets', () => {
  test('the resident editor is not mistaken for an occupied tool zone', () => {
    const row = { left: 44, top: 48, width: 1276, height: 852 };
    const editor = { left: 44, top: 48, width: 638, height: 852 };
    const chat = { left: 682, top: 48, width: 638, height: 852 };
    const targets = computeZoneDropTargets(row, chat, null, false, editor);
    expect(targets.left.width).toBeLessThan(200);
    expect(hitTestZoneDropTargets(targets, { x: 400, y: 200 })).toBeNull();
    expect(targets.bottom.left).toBe(chat.left);
    const rtl = computeZoneDropTargets(row, { ...chat, left: 44 }, null, true, { ...editor, left: 682 });
    expect(rtl.left.left + rtl.left.width).toBe(1320);
    expect(hitTestZoneDropTargets(rtl, { x: 1000, y: 200 })).toBeNull();
  });
  test('navigation and the rail stand outside the measured tool row', () => {
    const row = { left: 324, top: 48, width: 1276, height: 852 };
    const editor = { left: 644, top: 48, width: 478, height: 852 };
    const chat = { left: 1122, top: 48, width: 478, height: 852 };
    const targets = computeZoneDropTargets(row, chat, null, false, editor);
    expect(targets.left).toEqual({ left: 324, top: 48, width: 320, height: 852 });
    for (const x of [140, 300, 900]) {
      expect(hitTestZoneDropTargets(targets, { x, y: 200 })).toBeNull();
    }
    expect(hitTestZoneDropTargets(targets, { x: 500, y: 200 })).toBe('left');
  });

  test('RTL mirrors the tool row while excluding start-side navigation', () => {
    const row = { left: 0, top: 48, width: 1276, height: 852 };
    const editor = { left: 478, top: 48, width: 478, height: 852 };
    const chat = { left: 0, top: 48, width: 478, height: 852 };
    const targets = computeZoneDropTargets(row, chat, null, true, editor);
    expect(targets.left).toEqual({ left: 956, top: 48, width: 320, height: 852 });
    for (const x of [1400, 1300, 700]) {
      expect(hitTestZoneDropTargets(targets, { x, y: 200 })).toBeNull();
    }
    expect(hitTestZoneDropTargets(targets, { x: 1100, y: 200 })).toBe('left');
    expect(hitTestZoneDropTargets(targets, { x: 10, y: 200 })).toBe('right');
  });

  test('with nothing beside the chat, edge strips stop above the bottom band, which spans the chat', () => {
    const row = { left: 300, top: 50, width: 1400, height: 800 };
    const targets = computeZoneDropTargets(row, row);
    expect(targets.left).toEqual({ left: 300, top: 50, width: 280, height: 560 });
    expect(targets.right).toEqual({ left: 1420, top: 50, width: 280, height: 560 });
    expect(targets.bottom).toEqual({ left: 300, top: 610, width: 1400, height: 240 });
  });

  test('an open bottom zone is the whole bottom target, and edge strips stop above it', () => {
    const row = { left: 300, top: 50, width: 1400, height: 800 };
    const bottomZone = { left: 300, top: 530, width: 1400, height: 320 };
    const targets = computeZoneDropTargets(row, row, bottomZone);
    expect(targets.bottom).toEqual({ left: 300, top: 530, width: 1400, height: 320 });
    expect(targets.left.height).toBe(480);
    expect(targets.right.height).toBe(480);
  });

  test('whatever stands beside the chat takes its side, full height', () => {
    // Left zone 540 px, chat column 800 px (with a bottom zone), the work-status card's 480 px column.
    const row = { left: 0, top: 50, width: 1820, height: 800 };
    const chatColumn = { left: 540, top: 50, width: 800, height: 800 };
    const bottomZone = { left: 540, top: 530, width: 800, height: 320 };
    const targets = computeZoneDropTargets(row, chatColumn, bottomZone);
    expect(targets.left).toEqual({ left: 0, top: 50, width: 540, height: 800 });
    expect(targets.right).toEqual({ left: 1340, top: 50, width: 480, height: 800 });
    expect(targets.bottom).toEqual({ left: 540, top: 530, width: 800, height: 320 });
  });

  test('targets never overlap, so the pointer picks exactly one', () => {
    const row = { left: 300, top: 50, width: 1400, height: 800 };
    const targets = computeZoneDropTargets(row, row);
    expect(hitTestZoneDropTargets(targets, { x: 310, y: 800 })).toBe('bottom');
    expect(hitTestZoneDropTargets(targets, { x: 310, y: 300 })).toBe('left');
    expect(hitTestZoneDropTargets(targets, { x: 1600, y: 100 })).toBe('right');
    expect(hitTestZoneDropTargets(targets, { x: 900, y: 200 })).toBeNull();
  });
});
