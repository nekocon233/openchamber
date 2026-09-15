import { describe, expect, test } from 'bun:test';

import { resolveMissingProjectSessionSelection } from './useProjectSessionSelection';

type SessionMeta = { directory: string | null };

const projectMapOf = (...sessionIds: string[]): ReadonlyMap<string, SessionMeta> => new Map(
  sessionIds.map((id) => [id, { directory: null }] as const),
);

const resolve = (overrides: Partial<Parameters<typeof resolveMissingProjectSessionSelection<SessionMeta>>[0]>) => (
  resolveMissingProjectSessionSelection<SessionMeta>({
    activeProjectId: 'active',
    currentSessionId: 'current',
    currentSessionOwnerProjectId: 'other',
    projectMap: projectMapOf('remembered', 'first'),
    rememberedSessionId: 'remembered',
    fallbackSessionId: 'first',
    ...overrides,
  })
);

describe('resolveMissingProjectSessionSelection', () => {
  test('keeps a session this project owns', () => {
    expect(resolve({ currentSessionOwnerProjectId: 'active' })).toEqual({ kind: 'preserve-current' });
  });

  test('keeps the current session while its owner is unknown', () => {
    // Selecting a session in a worktree the registry has not published yet
    // switches the active project before ownership resolves. Replacing the
    // selection here would drop the session the user just opened in favour of
    // this project's remembered one.
    expect(resolve({ currentSessionOwnerProjectId: null })).toEqual({ kind: 'preserve-current' });
    expect(resolve({ currentSessionOwnerProjectId: undefined })).toEqual({ kind: 'preserve-current' });
  });

  test('selects the remembered session when another project owns the current one', () => {
    expect(resolve({})).toEqual({ kind: 'select-session', sessionId: 'remembered' });
  });

  test('falls back to the first session when the remembered one is gone', () => {
    expect(resolve({ projectMap: projectMapOf('first') }))
      .toEqual({ kind: 'select-session', sessionId: 'first' });
  });

  test('opens a draft when the active project has no sessions', () => {
    expect(resolve({ projectMap: undefined })).toEqual({ kind: 'open-draft' });
    expect(resolve({ projectMap: projectMapOf() })).toEqual({ kind: 'open-draft' });
    expect(resolve({ currentSessionId: null, projectMap: projectMapOf() })).toEqual({ kind: 'open-draft' });
  });

  test('does nothing when the target is already current', () => {
    expect(resolve({ projectMap: projectMapOf('current'), rememberedSessionId: 'current' }))
      .toEqual({ kind: 'none' });
    expect(resolve({ projectMap: projectMapOf('other-session'), rememberedSessionId: undefined, fallbackSessionId: null }))
      .toEqual({ kind: 'none' });
  });

  test('selects for a project with no current session at all', () => {
    expect(resolve({ currentSessionId: null, currentSessionOwnerProjectId: null }))
      .toEqual({ kind: 'select-session', sessionId: 'remembered' });
  });
});
