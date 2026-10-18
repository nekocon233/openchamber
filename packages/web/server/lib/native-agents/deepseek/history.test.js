import { describe, expect, it } from 'vitest';
import { appendDeepseekBranch, initialDeepseekHistory, deepseekHistoryCursor, deepseekCursorPosition, deepseekIdentityScope, deepseekHistorySchema } from './history.js';

describe('DSH logical session history', () => {
  const id = `ndh_${'a'.repeat(64)}`;
  it('keeps identity segments over repeated rewinds and accepts only retained cursor prefixes', () => {
    const original = initialDeepseekHistory(id, 'native-original');
    const middle = appendDeepseekBranch(original, 'native-middle', 20);
    const latest = appendDeepseekBranch(middle, 'native-latest', 30);
    expect(deepseekHistorySchema.parse(latest)).toEqual(latest);
    const branch = latest.branches.at(-1);
    expect(deepseekIdentityScope(branch, 19)).toBe(id);
    expect(deepseekIdentityScope(branch, 20)).toBe('native-middle');
    expect(deepseekIdentityScope(branch, 30)).toBe('native-latest');
    expect(deepseekCursorPosition(id, latest, deepseekHistoryCursor(id, 'native-original', 19))).toBe(19);
    expect(deepseekCursorPosition(id, latest, deepseekHistoryCursor(id, 'native-middle', 29))).toBe(29);
    expect(() => deepseekCursorPosition(id, latest, deepseekHistoryCursor(id, 'native-original', 20))).toThrow('Discarded');
    expect(() => deepseekCursorPosition(id, original, deepseekHistoryCursor(id, 'native-middle', 1))).toThrow('Unrelated');
    expect(() => deepseekCursorPosition(`ndh_${'b'.repeat(64)}`, latest, deepseekHistoryCursor(id, 'native-original', 1))).toThrow();
  });
  it('supports existing cursors and a rewind before every original event', () => {
    const original = initialDeepseekHistory(id, 'native-original');
    expect(deepseekCursorPosition(id, original, `ndh_c_${id.slice(4)}_12`)).toBe(12);
    const empty = appendDeepseekBranch(original, 'native-empty', 0);
    expect(empty.branches.at(-1).segments).toEqual([{ start: 0, scope: 'native-empty' }]);
    expect(() => deepseekCursorPosition(id, empty, `ndh_c_${id.slice(4)}_0`)).toThrow();
  });
});
