import { describe, expect, test } from 'bun:test';
import { sessionActionSupport } from './capabilities';

describe('native session action support', () => {
  const id = `ndh_${'a'.repeat(64)}`;
  test('keeps unsupported or older DeepSeek servers closed until they advertise actions', () => {
    expect(sessionActionSupport(id)).toEqual({ share: false, moveToWorktree: false, revert: false, delete: false });
    expect(sessionActionSupport(id, { openchamber: { native: { actions: { revert: true, delete: false } } } })).toMatchObject({ revert: true, delete: false });
    expect(sessionActionSupport(id, { openchamber: { native: { actions: { revert: true, delete: true } } } })).toMatchObject({ revert: true, delete: true });
  });
  test('preserves the action contracts of OpenCode and the other native providers', () => {
    expect(sessionActionSupport('ses_example')).toEqual({ share: true, moveToWorktree: true, revert: true, delete: true });
    expect(sessionActionSupport('ncl_example')).toEqual({ share: false, moveToWorktree: false, revert: true, delete: true });
    expect(sessionActionSupport('ncx_example')).toEqual({ share: false, moveToWorktree: false, revert: true, delete: true });
  });
});
