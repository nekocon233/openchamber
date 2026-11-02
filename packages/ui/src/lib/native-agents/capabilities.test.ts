import { describe, expect, test } from 'bun:test';
import { sessionActionSupport, supportsUnifiedNativeBackend } from './capabilities';
import { NATIVE_BACKENDS } from './ids';

describe('native session action support', () => {
  const id = `ndh_${'a'.repeat(64)}`;
  test('keeps unsupported or older DeepSeek servers closed until they advertise actions', () => {
    expect(sessionActionSupport(id)).toEqual({ share: false, moveToWorktree: false, revert: false, delete: false, fork: false });
    expect(sessionActionSupport(id, { openchamber: { native: { actions: { revert: true, delete: false } } } })).toMatchObject({ revert: true, delete: false, fork: false });
    expect(sessionActionSupport(id, { openchamber: { native: { actions: { revert: true, delete: true, fork: true } } } })).toMatchObject({ revert: true, delete: true, fork: true });
  });
  test('keeps every unsupported Antigravity action closed even if metadata asks for it', () => {
    const sessionId = 'nag_f1033b7a-88c5-4b77-bbec-6d63ec3a1188';
    const metadata = { openchamber: { native: { actions: { revert: true, delete: true, fork: true } } } };
    expect(sessionActionSupport(sessionId, metadata)).toEqual({ share: false, moveToWorktree: false, revert: false, delete: false, fork: false });
  });
  test('preserves the action contracts of OpenCode and the other native providers', () => {
    expect(sessionActionSupport('ses_example')).toEqual({ share: true, moveToWorktree: true, revert: true, delete: true, fork: true });
    expect(sessionActionSupport('ncl_example')).toEqual({ share: false, moveToWorktree: false, revert: true, delete: true, fork: true });
    expect(sessionActionSupport('ncx_example')).toEqual({ share: false, moveToWorktree: false, revert: true, delete: true, fork: true });
  });

  test('retains unified rewind and fork while refusing deletion when a source cannot delete', () => {
    const id = 'ncv_f1033b7a-88c5-4b77-bbec-6d63ec3a1188';
    expect(sessionActionSupport(id, { openchamber: { native: { actions: { revert: true, fork: true, delete: false } } } }))
      .toMatchObject({ revert: true, fork: true, delete: false });
  });
});

describe('unified backend negotiation', () => {
  for (const backend of NATIVE_BACKENDS) test(`offers registered ${backend} when advertised`, () => {
    expect(supportsUnifiedNativeBackend({ unifiedSessions: true, unifiedBackends: NATIVE_BACKENDS }, backend)).toBe(true);
    expect(supportsUnifiedNativeBackend({ unifiedSessions: false, unifiedBackends: NATIVE_BACKENDS }, backend)).toBe(false);
    expect(supportsUnifiedNativeBackend({ unifiedSessions: true, unifiedBackends: [] }, backend)).toBe(false);
  });
  test('keeps old servers on their original backend set', () => {
    expect(supportsUnifiedNativeBackend({ unifiedSessions: true }, 'antigravity')).toBe(false);
    expect(supportsUnifiedNativeBackend({ unifiedSessions: true }, 'codex')).toBe(true);
    expect(supportsUnifiedNativeBackend({}, 'claude')).toBe(false);
  });
});
