import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';

import { createSessionOwnershipIndex } from './sessionOwnership';

describe('createSessionOwnershipIndex', () => {
  test('assigns sessions to the deepest project and registered worktree', () => {
    const sessions = [
      { id: 'nested', directory: '/projects/app/packages/admin/src' },
      { id: 'external-worktree', directory: '/worktrees/app-feature/src' },
      { id: 'worktree-fallback', project: { worktree: '/worktrees/app-feature/src' } },
      { id: 'directory-wins', directory: '/projects/app/packages/admin', project: { worktree: '/projects/app' } },
      { id: 'windows', directory: 'c:\\Projects\\App\\src' },
      { id: 'unassigned', directory: '/elsewhere' },
    ] as unknown as Session[];
    const projects = [
      { id: 'app', normalizedPath: '/projects/app' },
      { id: 'admin', normalizedPath: '/projects/app/packages/admin' },
      { id: 'windows-app', normalizedPath: 'C:/Projects/App' },
    ];
    const worktrees = new Map([
      ['/projects/app', [{ path: '/worktrees/app-feature' }]],
    ]);

    const ownership = createSessionOwnershipIndex(sessions, projects, worktrees, false);

    expect(ownership.bySessionId.get('nested')?.projectId).toBe('admin');
    expect(ownership.bySessionId.get('external-worktree')).toEqual({
      projectId: 'app',
      projectRoot: '/projects/app',
      scopeDirectory: '/worktrees/app-feature',
      kind: 'worktree',
    });
    expect(ownership.bySessionId.get('worktree-fallback')?.scopeDirectory).toBe('/worktrees/app-feature');
    expect(ownership.bySessionId.get('directory-wins')?.projectId).toBe('admin');
    expect(ownership.bySessionId.get('windows')?.projectId).toBe('windows-app');
    expect(ownership.bySessionId.has('unassigned')).toBe(false);
    expect(ownership.sessionsByProject.get('admin')?.map((session) => session.id)).toEqual([
      'nested',
      'directory-wins',
    ]);
    expect(ownership.sessionsByScope.get('/worktrees/app-feature')).toEqual(new Set([
      'external-worktree',
      'worktree-fallback',
    ]));
  });

  test('gives an exact project precedence over a colliding worktree', () => {
    const ownership = createSessionOwnershipIndex(
      [{ id: 'nested', directory: '/projects/app/packages/admin/src' } as Session],
      [
        { id: 'app', normalizedPath: '/projects/app' },
        { id: 'admin', normalizedPath: '/projects/app/packages/admin' },
      ],
      new Map([['/projects/app', [{ path: '/projects/app/packages/admin' }]]]),
      false,
    );

    expect(ownership.bySessionId.get('nested')?.projectId).toBe('admin');
    expect(ownership.bySessionId.get('nested')?.kind).toBe('project');
  });

  test('does not let an ancestor project claim a managed worktree the registry has not published', () => {
    // A worktree created moments ago is still absent from the registry. Its
    // path lives under the OpenCode data directory, so walking up would reach
    // the home-directory project and file the session under it.
    const worktreeRoot = '/home/dev/.local/share/opencode/worktree/8d0a4f25/chatgpt';
    const ownership = createSessionOwnershipIndex(
      // SAFETY: the index reads only `id` and the session directory, both set here.
      [
        { id: 'fresh-worktree', directory: worktreeRoot },
        { id: 'fresh-worktree-nested', directory: `${worktreeRoot}/packages/ui` },
        { id: 'home-session', directory: '/home/dev/notes' },
      ] as Session[],
      [
        { id: 'home', normalizedPath: '/home/dev' },
        { id: 'app', normalizedPath: '/projects/app' },
      ],
      new Map(),
      false,
    );

    expect(ownership.bySessionId.has('fresh-worktree')).toBe(false);
    expect(ownership.bySessionId.has('fresh-worktree-nested')).toBe(false);
    expect(ownership.bySessionId.get('home-session')?.projectId).toBe('home');
  });

  test('owns a registered managed worktree through its project', () => {
    const worktreeRoot = '/home/dev/.local/share/opencode/worktree/8d0a4f25/chatgpt';
    const ownership = createSessionOwnershipIndex(
      // SAFETY: the index reads only `id` and the session directory, both set here.
      [
        { id: 'worktree-root', directory: worktreeRoot },
        { id: 'worktree-nested', directory: `${worktreeRoot}/packages/ui` },
      ] as Session[],
      [
        { id: 'home', normalizedPath: '/home/dev' },
        { id: 'app', normalizedPath: '/projects/app' },
      ],
      new Map([['/projects/app', [{ path: worktreeRoot }]]]),
      false,
    );

    expect(ownership.bySessionId.get('worktree-root')).toEqual({
      projectId: 'app',
      projectRoot: '/projects/app',
      scopeDirectory: worktreeRoot,
      kind: 'worktree',
    });
    expect(ownership.bySessionId.get('worktree-nested')?.projectId).toBe('app');
  });

  test('indexes archived sessions separately', () => {
    const ownership = createSessionOwnershipIndex(
      [],
      [{ id: 'app', normalizedPath: '/projects/app' }],
      new Map([['/projects/app', [{ path: '/worktrees/app-feature' }]]]),
      false,
      [
        { id: 'archived-child', directory: '/worktrees/app-feature/src', time: { archived: 1 } },
        { id: 'archived-fallback', project: { worktree: '/worktrees/app-feature' }, time: { archived: 1 } },
      ] as unknown as Session[],
    );

    expect(ownership.archivedSessionsByProject.get('app')?.map((session) => session.id)).toEqual([
      'archived-child',
      'archived-fallback',
    ]);
  });

  test('requires exact workspace directories in VS Code', () => {
    const ownership = createSessionOwnershipIndex(
      [
        { id: 'workspace', directory: '/projects/app' },
        { id: 'nested', directory: '/projects/app/packages/ui' },
      ] as Session[],
      [{ id: 'app', normalizedPath: '/projects/app' }],
      new Map(),
      true,
    );

    expect(ownership.bySessionId.get('workspace')?.projectId).toBe('app');
    expect(ownership.bySessionId.has('nested')).toBe(false);
  });

  test('supports a Windows drive root project', () => {
    const ownership = createSessionOwnershipIndex(
      [{ id: 'windows-root', directory: 'c:\\Users\\name\\project' } as Session],
      [{ id: 'drive', normalizedPath: 'C:/' }],
      new Map(),
      false,
    );

    expect(ownership.bySessionId.get('windows-root')?.projectId).toBe('drive');
    expect(ownership.bySessionId.get('windows-root')?.scopeDirectory).toBe('C:/');
  });

  test('resolves report-sized data once instead of once per project consumer', () => {
    const projects = Array.from({ length: 15 }, (_, index) => ({
      id: `project-${index}`,
      normalizedPath: `/projects/${index}`,
    }));
    const worktrees = new Map(projects.map((project, projectIndex) => [
      project.normalizedPath,
      Array.from({ length: projectIndex < 7 ? 5 : 4 }, (_, index) => ({
        path: `/worktrees/${projectIndex}/${index}`,
      })),
    ]));
    const sessions = Array.from({ length: 14_561 }, (_, index) => ({
      id: `session-${index}`,
      directory: `/worktrees/${index % 15}/${index % 4}/session/${index}`,
    })) as unknown as Session[];

    const ownership = createSessionOwnershipIndex(sessions, projects, worktrees, false);

    expect(ownership.bySessionId.size).toBe(14_561);
    expect(ownership.directoryResolutions).toBeLessThan(14_561 * 2);
    expect([...ownership.sessionsByProject.values()].reduce((total, bucket) => total + bucket.length, 0)).toBe(14_561);
  });
});
