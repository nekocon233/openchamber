import { describe, expect, test } from 'bun:test';
import {
  DESKTOP_DISPLAY_PRESETS,
  displayRatioOptions,
  readDisplayRatio,
  resolveSessionSize,
  targetDesktopResolution,
} from './model.ts';

describe('remote desktop display ratio presets', () => {
  test('parses supported ratios and falls back to auto on invalid stored values', () => {
    expect(readDisplayRatio('auto')).toBe('auto');
    expect(readDisplayRatio('16:9')).toBe('16:9');
    expect(readDisplayRatio('16:10')).toBe('16:10');
    expect(readDisplayRatio('4:3')).toBe('4:3');
    for (const invalid of [undefined, null, '', '21:9', 16, {}]) {
      expect(readDisplayRatio(invalid)).toBe('auto');
    }
  });

  test('resolves fixed desktop resolutions for presets and viewport size for auto', () => {
    const viewport = { width: 720, height: 860 };
    expect(targetDesktopResolution('auto')).toBeNull();
    expect(resolveSessionSize('auto', viewport)).toEqual(viewport);

    expect(targetDesktopResolution('16:9')).toEqual({ width: 1920, height: 1080 });
    expect(resolveSessionSize('16:9', viewport)).toEqual({ width: 1920, height: 1080 });
    expect(targetDesktopResolution('16:10')).toEqual({ width: 1440, height: 900 });
    expect(resolveSessionSize('16:10', viewport)).toEqual({ width: 1440, height: 900 });
    expect(targetDesktopResolution('4:3')).toEqual({ width: 1280, height: 960 });
    expect(resolveSessionSize('4:3', viewport)).toEqual({ width: 1280, height: 960 });

    expect(targetDesktopResolution('auto', { width: 390, height: 680 }, true)).toEqual({ width: 1280, height: 800 });
    expect(resolveSessionSize('auto', { width: 390, height: 680 }, true)).toEqual({ width: 1280, height: 800 });
    expect(targetDesktopResolution('auto', { width: 1440, height: 920 }, true)).toEqual({ width: 1440, height: 920 });
    expect(targetDesktopResolution('16:9', { width: 390, height: 680 }, true)).toEqual({ width: 1920, height: 1080 });
  });

  test('builds header select options within SDK status-control limits', () => {
    const options = displayRatioOptions('自适应');
    expect(options).toEqual([
      { value: 'auto', label: '自适应' },
      { value: '16:9', label: DESKTOP_DISPLAY_PRESETS['16:9'].label },
      { value: '16:10', label: DESKTOP_DISPLAY_PRESETS['16:10'].label },
      { value: '4:3', label: DESKTOP_DISPLAY_PRESETS['4:3'].label },
    ]);
    for (const option of options) {
      expect(option.value.length).toBeGreaterThanOrEqual(1);
      expect(option.value.length).toBeLessThanOrEqual(80);
      expect(option.label.length).toBeGreaterThanOrEqual(1);
      expect(option.label.length).toBeLessThanOrEqual(60);
    }
  });
});
