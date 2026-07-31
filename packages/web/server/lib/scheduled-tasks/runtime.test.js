import { describe, expect, it, vi } from 'vitest';
import {
  computeNextRunAt,
  createScheduledTasksRuntime,
  expandCommandGoalObjective,
  formatScheduledSessionTitle,
  parseScheduledCommandPrompt,
} from './runtime.js';

describe('scheduled-tasks runtime helpers', () => {
  it('computes next daily run in timezone', () => {
    const nowUtc = Date.UTC(2025, 0, 1, 8, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'daily',
        times: ['09:30'],
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBe(Date.UTC(2025, 0, 1, 9, 30, 0));
  });

  it('computes weekly next run using weekdays', () => {
    // Monday 2025-01-06 10:00:00 UTC
    const nowUtc = Date.UTC(2025, 0, 6, 10, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'weekly',
        times: ['09:00'],
        weekdays: [1, 3],
        timezone: 'UTC',
      },
    }, nowUtc);

    // Wednesday 2025-01-08 09:00:00 UTC
    expect(next).toBe(Date.UTC(2025, 0, 8, 9, 0, 0));
  });

  it('picks nearest time from multiple daily times', () => {
    const nowUtc = Date.UTC(2025, 0, 1, 9, 20, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'daily',
        times: ['09:15', '09:45', '18:00'],
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBe(Date.UTC(2025, 0, 1, 9, 45, 0));
  });

  it('computes one-time next run for future date', () => {
    const nowUtc = Date.UTC(2026, 3, 15, 10, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'once',
        date: '2026-04-16',
        time: '13:30',
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBe(Date.UTC(2026, 3, 16, 13, 30, 0));
  });

  it('returns null for past one-time schedule', () => {
    const nowUtc = Date.UTC(2026, 3, 16, 14, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'once',
        date: '2026-04-16',
        time: '13:30',
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBeNull();
  });

  it('formats session title with timestamp suffix', () => {
    const title = formatScheduledSessionTitle({
      name: 'Morning Sync',
      schedule: { timezone: 'UTC' },
    }, Date.UTC(2025, 2, 10, 7, 5, 0));

    expect(title).toBe('Morning Sync 2025-03-10 07:05');
  });

  it('parses slash command prompt for scheduled command mode', () => {
    expect(parseScheduledCommandPrompt('/review src/components')).toEqual({
      command: 'review',
      arguments: 'src/components',
    });
  });

  it('returns null when prompt is not a slash command', () => {
    expect(parseScheduledCommandPrompt('Summarize open issues')).toBeNull();
    expect(parseScheduledCommandPrompt('/')).toBeNull();
  });

  it('expands command arguments into the goal objective', () => {
    expect(expandCommandGoalObjective(
      'Run the issue pipeline for $ARGUMENTS. Verify $ARGUMENTS is represented by the PR.',
      'LIN-123 --draft',
    )).toBe('Run the issue pipeline for LIN-123 --draft. Verify LIN-123 --draft is represented by the PR.');
    expect(expandCommandGoalObjective(undefined, 'LIN-123')).toBeNull();
    expect(expandCommandGoalObjective('Move $1 to $2', '"src old" dist extra')).toBe('Move src old to dist extra');
    expect(expandCommandGoalObjective('Review the requested scope.', 'auth module'))
      .toBe('Review the requested scope.\n\nauth module');
  });

  it('persists a disabled permission policy before sending the task prompt', async () => {
    let task = {
      id: 'task-1',
      name: 'Manual approval task',
      enabled: true,
      schedule: { kind: 'daily', times: ['23:59'], timezone: 'UTC' },
      execution: {
        prompt: 'Run the task',
        providerID: 'provider',
        modelID: 'model',
        permissionAutoAccept: false,
        goalEnabled: false,
      },
      state: {},
    };
    const operations = [];
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      const method = init.method ?? (input instanceof Request ? input.method : 'GET');
      if (url.pathname === '/session' && method === 'POST') {
        operations.push('create');
        return Response.json({ id: 'session-1' });
      }
      if (url.pathname === '/session/session-1/prompt_async' && method === 'POST') {
        operations.push('prompt');
        return new Response(null, { status: 204 });
      }
      return new Response('', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchImpl);

    try {
      const runtime = createScheduledTasksRuntime({
        projectConfigRuntime: {
          listScheduledTasks: async () => [task],
          updateScheduledTaskState: async (_projectID, _taskID, patch) => {
            task = { ...task, state: { ...task.state, ...patch } };
            return { task };
          },
        },
        listProjects: async () => [{ id: 'project-1', path: '/project' }],
        buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
        getOpenCodeAuthHeaders: () => ({}),
        setSessionAutoAccept: async (sessionID, enabled, directory) => {
          operations.push(`policy:${sessionID}:${enabled}:${directory}`);
        },
        logger: { info: () => undefined, warn: () => undefined },
      });

      await runtime.syncProject('project-1');
      const result = await runtime.runNow('project-1', 'task-1');

      expect(result.ok).toBe(true);
      expect(operations).toEqual([
        'create',
        'policy:session-1:false:/project',
        'prompt',
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
