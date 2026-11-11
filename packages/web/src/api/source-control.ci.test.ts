import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SourceControlReadContext } from '@openchamber/ui/lib/api/types';
import { createWebSourceControlAPI } from './source-control';

const runtimeFetchMock = vi.fn(async (): Promise<Response> => Response.json({}));
const readContext: SourceControlReadContext = {
  provider: 'github',
  instance: 'https://GitHub.com/',
  directory: '/workspace/app',
  repositoryId: 'repo_one',
  accountId: 'github.com#7',
  bindingRevision: 4,
  primaryRemote: 'origin',
};

afterEach(() => {
  runtimeFetchMock.mockReset();
});

describe('createWebSourceControlAPI CI operations', () => {
  it('validates and parses ciRunsList, ciRunDetail, and ciJobLog payloads', async () => {
    const api = createWebSourceControlAPI({ fetch: runtimeFetchMock });
    const project = {
      provider: 'github',
      instance: 'github.com',
      id: 'openchamber/openchamber',
      owner: 'openchamber',
      name: 'openchamber',
      url: 'https://github.com/openchamber/openchamber',
    };
    const sampleRun = {
      provider: 'github',
      instance: 'github.com',
      id: '9001',
      runNumber: 88,
      runAttempt: 1,
      project,
      workflowName: 'CI',
      title: 'feat: ci list',
      commitMessage: 'feat: ci list',
      status: 'in_progress',
      conclusion: null,
      event: 'push',
      headBranch: 'main',
      headSha: 'a'.repeat(40),
      url: 'https://github.com/openchamber/openchamber/actions/runs/9001',
      actor: {
        provider: 'github',
        instance: 'github.com',
        id: '7',
        username: 'alice',
      },
      startedAt: '2026-11-10T10:00:00Z',
      pullRequests: [{ number: 12, url: 'https://github.com/openchamber/openchamber/pull/12' }],
      jobSummary: { state: 'pending', total: 3, success: 1, failure: 0, pending: 2, inProgress: 1, queued: 1 },
    };

    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      project,
      items: [sampleRun],
      page: 1,
      hasMore: false,
    }));
    const page = await api.ciRunsList(readContext, { page: 1, status: 'active', branch: 'main', query: 'ci' });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.jobSummary?.total).toBe(3);

    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      identity: { provider: 'github', instance: 'github.com' },
      project,
      run: sampleRun,
      ci: {
        summary: sampleRun.jobSummary,
        runs: [{
          provider: 'github',
          instance: 'github.com',
          id: '5001',
          name: 'build',
          status: 'in_progress',
          conclusion: null,
          job: {
            runId: '9001',
            jobId: '5001',
            name: 'build',
            workflowName: 'CI',
            runnerName: 'ubuntu-latest',
            steps: [{ name: 'Test', status: 'in_progress', conclusion: null, number: 2 }],
          },
        }],
      },
    }));
    const detail = await api.ciRunDetail(readContext, '9001');
    expect(detail.run?.id).toBe('9001');
    expect(detail.ci?.runs?.[0]?.job?.runnerName).toBe('ubuntu-latest');

    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      identity: { provider: 'github', instance: 'github.com' },
      jobId: '5001',
      available: true,
      content: 'Error: failed\n',
      truncated: true,
    }));
    const log = await api.ciJobLog(readContext, '5001');
    expect(log).toEqual({
      identity: { provider: 'github', instance: 'github.com' },
      jobId: '5001',
      available: true,
      content: 'Error: failed\n',
      truncated: true,
    });

    await expect(api.ciRunDetail(readContext, 'not-a-number')).rejects.toThrow('positive integer');
    await expect(api.ciJobLog(readContext, '0')).rejects.toThrow('positive integer');

    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      project,
      items: [{ ...sampleRun, url: 'javascript:alert(1)' }],
      page: 1,
      hasMore: false,
    }));
    await expect(api.ciRunsList(readContext)).rejects.toThrow('invalid CI workflow run');
  });
});
