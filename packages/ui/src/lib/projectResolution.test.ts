import { describe, expect, test } from 'bun:test';
import { isManagedWorktreePath, resolveProjectForSessionDirectory } from './projectResolution';

const projects = [
  { id: 'openchamber', path: '/workspace/openchamber', label: 'OpenChamber' },
];

// Managed worktrees are created under the OpenCode data directory, which lives
// inside the user's home. A home-directory project therefore matches every one
// of them by ancestry.
const HOME_PROJECT = { id: 'home', path: '/home/dev', label: 'Home' };
const MANAGED_WORKTREE = '/home/dev/.local/share/opencode/worktree/8d0a4f25c1047e2bcc01775a8df69c80642ef52d/chatgpt';

describe('isManagedWorktreePath', () => {
  test('matches a managed checkout and its subdirectories', () => {
    expect(isManagedWorktreePath(MANAGED_WORKTREE)).toBe(true);
    expect(isManagedWorktreePath(`${MANAGED_WORKTREE}/packages/ui`)).toBe(true);
    expect(isManagedWorktreePath('/home/dev/.local/share/opencode/worktree/8d0a4f25')).toBe(true);
  });

  test('does not match the registry root, unrelated paths, or empty input', () => {
    expect(isManagedWorktreePath('/home/dev/.local/share/opencode/worktree')).toBe(false);
    expect(isManagedWorktreePath('/home/dev/.local/share/opencode')).toBe(false);
    expect(isManagedWorktreePath('/home/dev/Documents/app')).toBe(false);
    expect(isManagedWorktreePath(null)).toBe(false);
  });

  test('normalizes Windows separators and trailing slashes', () => {
    expect(isManagedWorktreePath('C:\\Users\\dev\\AppData\\opencode\\worktree\\abc\\feature')).toBe(true);
    expect(isManagedWorktreePath('/home/dev/.local/share/opencode/worktree/')).toBe(false);
  });
});

describe('resolveProjectForSessionDirectory', () => {
  test('resolves a sibling worktree to its registered project', () => {
    const worktrees = new Map([
      ['/workspace/openchamber', [{
        path: '/workspace/openchamber-feature',
        projectDirectory: '/workspace/openchamber',
        branch: 'feature',
        label: 'feature',
      }]],
    ]);

    expect(resolveProjectForSessionDirectory(projects, worktrees, '/workspace/openchamber-feature')).toEqual(projects[0]);
  });

  test('resolves a registered managed worktree to its project, not the ancestor home project', () => {
    const worktrees = new Map([
      ['/workspace/openchamber', [{
        path: MANAGED_WORKTREE,
        projectDirectory: '/workspace/openchamber',
        branch: 'chatgpt',
        label: 'chatgpt',
      }]],
    ]);

    expect(resolveProjectForSessionDirectory([...projects, HOME_PROJECT], worktrees, MANAGED_WORKTREE))
      .toEqual(projects[0]);
    expect(resolveProjectForSessionDirectory([...projects, HOME_PROJECT], worktrees, `${MANAGED_WORKTREE}/packages/ui`))
      .toEqual(projects[0]);
  });

  test('leaves a managed worktree missing from the registry unresolved', () => {
    // Discovery has not published the freshly created worktree yet. Attributing
    // it to the home project would switch the sidebar to that project when the
    // session is selected.
    expect(resolveProjectForSessionDirectory([...projects, HOME_PROJECT], new Map(), MANAGED_WORKTREE)).toBeNull();
  });

  test('prefers the worktree registry over an ancestor project', () => {
    const worktrees = new Map([
      ['/workspace/openchamber', [{
        path: '/home/dev/checkouts/openchamber-feature',
        projectDirectory: '/workspace/openchamber',
        branch: 'feature',
        label: 'feature',
      }]],
    ]);

    expect(resolveProjectForSessionDirectory([...projects, HOME_PROJECT], worktrees, '/home/dev/checkouts/openchamber-feature'))
      .toEqual(projects[0]);
  });

  test('prefers a project registered at the exact directory over the registry', () => {
    const nested = { id: 'nested', path: '/home/dev/checkouts/openchamber-feature', label: 'Nested' };
    const worktrees = new Map([
      ['/workspace/openchamber', [{
        path: '/home/dev/checkouts/openchamber-feature',
        projectDirectory: '/workspace/openchamber',
        branch: 'feature',
        label: 'feature',
      }]],
    ]);

    expect(resolveProjectForSessionDirectory([...projects, nested], worktrees, '/home/dev/checkouts/openchamber-feature'))
      .toEqual(nested);
  });

  test('still resolves an ordinary directory to its nearest ancestor project', () => {
    expect(resolveProjectForSessionDirectory([...projects, HOME_PROJECT], new Map(), '/workspace/openchamber/packages/ui'))
      .toEqual(projects[0]);
    expect(resolveProjectForSessionDirectory([...projects, HOME_PROJECT], new Map(), '/home/dev/Documents/notes'))
      .toEqual(HOME_PROJECT);
  });
});
