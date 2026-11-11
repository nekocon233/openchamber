import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOctokit, downloadGitHubJobLog } from './octokit.js';
import { listGitHubCiRuns, parseCiRunQuery, readGitHubCiJobLog, readGitHubCiRunDetail } from './ci-runs.js';
import { registerGitHubRoutes } from '../source-control/provider-routes.github.test-support.js';
import { registerSourceControlRoutes } from '../source-control/routes.js';
import { createSourceControlProviders } from '../source-control/provider-registry.js';

const IDENTITY = { provider: 'github', instance: 'github.com' };
const REPO = { owner: 'acme', repo: 'app', host: 'github.com', url: 'https://github.com/acme/app' };

const makeRawRun = (overrides = {}) => ({
  id: 1001,
  run_number: 42,
  run_attempt: 1,
  name: 'CI',
  display_title: 'feat: add ci list',
  status: 'completed',
  conclusion: 'success',
  event: 'push',
  head_branch: 'main',
  head_sha: 'a'.repeat(40),
  html_url: 'https://github.com/acme/app/actions/runs/1001',
  created_at: '2026-11-10T10:00:00Z',
  run_started_at: '2026-11-10T10:00:05Z',
  updated_at: '2026-11-10T10:03:00Z',
  actor: { id: 7, login: 'alice', avatar_url: 'https://avatars.githubusercontent.com/u/7' },
  head_commit: { message: 'feat: add ci list\n\ndetails' },
  pull_requests: [
    { id: 1, number: 12, url: 'https://api.github.com/repos/acme/app/pulls/12' },
    { id: 2, number: 99, url: 'https://api.github.com/repos/other/fork/pulls/99' },
  ],
  ...overrides,
});

const makeRawJob = (overrides = {}) => ({
  id: 5001,
  name: 'build-and-test',
  status: 'completed',
  conclusion: 'success',
  html_url: 'https://github.com/acme/app/actions/runs/1001/job/5001',
  started_at: '2026-11-10T10:00:10Z',
  completed_at: '2026-11-10T10:02:55Z',
  runner_name: 'ubuntu-latest-1',
  steps: [
    { name: 'Checkout', status: 'completed', conclusion: 'success', number: 1, started_at: '2026-11-10T10:00:11Z', completed_at: '2026-11-10T10:00:15Z' },
    { name: 'Test', status: 'completed', conclusion: 'success', number: 2, started_at: '2026-11-10T10:00:16Z', completed_at: '2026-11-10T10:02:50Z' },
  ],
  ...overrides,
});

describe('parseCiRunQuery', () => {
  it('parses same-repo GitHub Actions URLs and marks foreign URLs out of scope', () => {
    expect(parseCiRunQuery('https://github.com/Acme/App/actions/runs/987654/job/123', REPO, 'github.com')).toEqual(
      expect.objectContaining({ outOfScope: false, directRunId: 987654 }),
    );
    expect(parseCiRunQuery('https://github.com/other/repo/actions/runs/987654', REPO, 'github.com')).toEqual(
      expect.objectContaining({ outOfScope: true, directRunId: null }),
    );
    expect(parseCiRunQuery('https://ghe.example.com/acme/app/actions/runs/987654', REPO, 'github.com')).toEqual(
      expect.objectContaining({ outOfScope: true, directRunId: null }),
    );
  });

  it('extracts qualifiers, #runNumber, 40-hex SHA, and free-text terms', () => {
    const sha = 'b'.repeat(40);
    expect(parseCiRunQuery(`branch:feat/ci @alice event:pull_request #42 ${sha} lint`, REPO, 'github.com')).toEqual({
      outOfScope: false,
      directRunId: null,
      runNumber: 42,
      branch: 'feat/ci',
      actor: 'alice',
      event: 'pull_request',
      headSha: sha,
      terms: ['lint'],
    });
  });
});

describe('GitHub CI resource helpers', () => {
  it('lists workflow runs, enriches active runs with job counts, and filters foreign PR links', async () => {
    const activeRun = makeRawRun({
      id: 1002,
      run_number: 43,
      status: 'in_progress',
      conclusion: null,
      updated_at: '2026-11-10T10:05:00Z',
    });
    const completedRun = makeRawRun({ id: 1001, run_number: 42 });
    const octokit = {
      rest: {
        actions: {
          listWorkflowRunsForRepo: vi.fn(async () => ({
            data: { total_count: 2, workflow_runs: [activeRun, completedRun] },
          })),
          listJobsForWorkflowRun: vi.fn(async ({ run_id }) => ({
            data: {
              total_count: 3,
              jobs: [
                makeRawJob({ id: run_id * 10 + 1, status: 'completed', conclusion: 'success' }),
                makeRawJob({ id: run_id * 10 + 2, status: 'in_progress', conclusion: null }),
                makeRawJob({ id: run_id * 10 + 3, status: 'queued', conclusion: null }),
              ],
            },
          })),
        },
      },
    };

    const page = await listGitHubCiRuns({ octokit, identity: IDENTITY, repo: REPO, page: 1, status: 'all' });
    expect(page.hasMore).toBe(false);
    expect(page.items).toHaveLength(2);
    // Only the active run was enriched on an unfiltered repo-wide list.
    expect(octokit.rest.actions.listJobsForWorkflowRun).toHaveBeenCalledTimes(1);
    expect(page.items[0].jobSummary).toEqual(expect.objectContaining({
      state: 'pending',
      total: 3,
      success: 1,
      failure: 0,
      pending: 2,
      inProgress: 1,
      queued: 1,
    }));
    expect(page.items[1].jobSummary).toBeUndefined();
    expect(page.items[1].pullRequests).toEqual([
      { number: 12, url: 'https://github.com/acme/app/pull/12' },
    ]);
  });

  it('enriches the newest completed run when querying a specific branch on page 1', async () => {
    const completedRun = makeRawRun({ id: 1005, run_number: 45, head_branch: 'feat/no-pr' });
    const octokit = {
      rest: {
        actions: {
          listWorkflowRunsForRepo: vi.fn(async () => ({
            data: { total_count: 1, workflow_runs: [completedRun] },
          })),
          listJobsForWorkflowRun: vi.fn(async () => ({
            data: {
              total_count: 2,
              jobs: [
                makeRawJob({ id: 1, status: 'completed', conclusion: 'success' }),
                makeRawJob({ id: 2, status: 'completed', conclusion: 'failure' }),
              ],
            },
          })),
        },
      },
    };

    const page = await listGitHubCiRuns({
      octokit,
      identity: IDENTITY,
      repo: REPO,
      page: 1,
      status: 'all',
      branch: 'feat/no-pr',
    });
    expect(page.items[0]?.jobSummary).toEqual(expect.objectContaining({
      state: 'failure',
      total: 2,
      success: 1,
      failure: 1,
      pending: 0,
    }));
  });

  it('merges and deduplicates in_progress, queued, and waiting runs for status=active', async () => {
    const r1 = makeRawRun({ id: 201, run_number: 1, status: 'in_progress', conclusion: null, created_at: '2026-11-10T10:01:00Z' });
    const r2 = makeRawRun({ id: 202, run_number: 2, status: 'queued', conclusion: null, created_at: '2026-11-10T10:02:00Z' });
    const octokit = {
      rest: {
        actions: {
          listWorkflowRunsForRepo: vi.fn(async ({ status }) => {
            if (status === 'in_progress') return { data: { total_count: 1, workflow_runs: [r1] } };
            if (status === 'queued') return { data: { total_count: 2, workflow_runs: [r2, r1] } };
            return { data: { total_count: 0, workflow_runs: [] } };
          }),
          listJobsForWorkflowRun: vi.fn(async () => ({ data: { total_count: 0, jobs: [] } })),
        },
      },
    };

    const page = await listGitHubCiRuns({ octokit, identity: IDENTITY, repo: REPO, page: 1, status: 'active' });
    expect(page.items.map((item) => item.id)).toEqual(['202', '201']);
  });

  it('reads run detail with jobs, steps, and failed job annotations', async () => {
    const octokit = {
      rest: {
        actions: {
          getWorkflowRun: vi.fn(async () => ({
            data: makeRawRun({ id: 3001, status: 'completed', conclusion: 'failure', updated_at: '2026-11-10T10:02:00Z' }),
          })),
          listJobsForWorkflowRun: vi.fn(async () => ({
            data: {
              total_count: 2,
              jobs: [
                makeRawJob({ id: 701, name: 'lint', conclusion: 'success', completed_at: '2026-11-10T10:01:00Z' }),
                makeRawJob({
                  id: 702,
                  name: 'unit-tests',
                  conclusion: 'failure',
                  completed_at: '2026-11-10T10:04:30Z',
                  steps: [
                    { name: 'Run tests', status: 'completed', conclusion: 'failure', number: 2 },
                  ],
                }),
              ],
            },
          })),
        },
        checks: {
          listAnnotations: vi.fn(async ({ check_run_id }) => ({
            data: check_run_id === 702 ? [{
              path: 'src/app.ts',
              start_line: 14,
              end_line: 14,
              annotation_level: 'failure',
              title: 'AssertionError',
              message: 'expected 1 to be 2',
            }] : [],
          })),
        },
      },
    };

    const detail = await readGitHubCiRunDetail({ octokit, identity: IDENTITY, repo: REPO, runId: 3001 });
    expect(detail.run?.completedAt).toBe('2026-11-10T10:04:30Z');
    expect(detail.ci?.summary).toEqual(expect.objectContaining({
      state: 'failure',
      total: 2,
      success: 1,
      failure: 1,
      pending: 0,
    }));
    expect(octokit.rest.checks.listAnnotations).toHaveBeenCalledTimes(1);
    expect(detail.ci?.runs?.[1]?.annotations).toEqual([{
      path: 'src/app.ts',
      startLine: 14,
      endLine: 14,
      level: 'failure',
      title: 'AssertionError',
      message: 'expected 1 to be 2',
      rawDetails: undefined,
    }]);
    expect(detail.ci?.runs?.[0]?.job?.runnerName).toBe('ubuntu-latest-1');
  });

  it('downloads redirected job logs without forwarding Authorization headers and truncates cleanly', async () => {
    const octokit = createOctokit('secret-ghe-token', 'acc-1', 'ghe.example.com');
    const calls = [];
    const rawLog = `${'line-prefix-0123456789\n'.repeat(20)}\u001b[31mERROR: test failed\u001b[0m\nfinal line\n`;
    const fetchMock = vi.fn(async (url, init) => {
      calls.push({ url, headers: init?.headers ?? null, redirect: init?.redirect });
      if (calls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://storage.blobs.example.com/logs/job-55?sig=abc' },
        });
      }
      return new Response(rawLog, { status: 200 });
    });

    const log = await downloadGitHubJobLog(octokit, {
      owner: 'acme',
      repo: 'app',
      jobId: 55,
      maxBytes: 64,
      fetchImpl: fetchMock,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      url: 'https://ghe.example.com/api/v3/repos/acme/app/actions/jobs/55/logs',
      headers: expect.objectContaining({ Authorization: 'token secret-ghe-token' }),
      redirect: 'manual',
    });
    // Redirect target receives NO Authorization header.
    expect(calls[1]).toEqual({
      url: 'https://storage.blobs.example.com/logs/job-55?sig=abc',
      headers: null,
      redirect: 'error',
    });
    expect(log.available).toBe(true);
    expect(log.truncated).toBe(true);
    expect(log.content).toContain('ERROR: test failed\nfinal line\n');
    expect(log.content).not.toContain('\u001b[');
  });

  it('refuses insecure HTTP redirect locations for job logs', async () => {
    const octokit = createOctokit('secret-token', 'acc-1', 'github.com');
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { Location: 'http://insecure.example.com/logs/55' },
    }));
    await expect(downloadGitHubJobLog(octokit, {
      owner: 'acme',
      repo: 'app',
      jobId: 55,
      fetchImpl: fetchMock,
    })).rejects.toMatchObject({ status: 502 });
  });

  it('preserves text between OSC 8 hyperlinks and strips unclosed OSC sequences in linear time', async () => {
    const octokit = createOctokit('secret-token', 'acc-1', 'github.com');
    const oscLog = [
      '\u001b]8;;https://example.com/file.rs\u001b\\src/file.rs:42\u001b]8;;\u001b\\: panicked at assertion',
      '\u001b]'.repeat(32_768),
      'visible tail line',
    ].join('\n');
    const fetchMock = vi.fn(async () => new Response(oscLog, { status: 200 }));
    const started = Date.now();
    const log = await downloadGitHubJobLog(octokit, {
      owner: 'acme',
      repo: 'app',
      jobId: 56,
      maxBytes: 256 * 1024,
      fetchImpl: fetchMock,
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(log.content).toContain('src/file.rs:42: panicked at assertion');
    expect(log.content).toContain('visible tail line');
  });

  it('returns available:false when a job or its log is 404', async () => {
    const octokit = {
      rest: {
        actions: {
          getJobForWorkflowRun: vi.fn(async () => {
            throw Object.assign(new Error('Not Found'), { status: 404 });
          }),
        },
      },
    };
    const result = await readGitHubCiJobLog({
      octokit,
      identity: IDENTITY,
      repo: REPO,
      jobId: 999,
      downloadJobLog: vi.fn(),
    });
    expect(result).toEqual({
      identity: IDENTITY,
      jobId: '999',
      available: false,
      content: '',
      truncated: false,
    });
  });
});

describe('CI provider routes', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-ci-routes-'));
  const previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
  let accountId = '';

  beforeAll(() => {
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
  });

  beforeEach(async () => {
    const { setGitHubAuth, setGhCliDisabled } = await import('./auth.js');
    setGhCliDisabled(true);
    accountId = (await setGitHubAuth({ accessToken: 'ci-route-token', user: { id: 9, login: 'ciuser' } })).accountId;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
    else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('serves /ci/runs, /ci/run, and /ci/job-log through bound read validation and rejects malformed payloads', async () => {
    const app = express();
    app.use(express.json());
    registerGitHubRoutes(app, {
      validateReadContext: vi.fn(async (ctx) => ({ ...ctx, bindingRevision: Number(ctx.bindingRevision) })),
      resolveGitHubRepoFromDirectory: vi.fn(async () => ({ repo: REPO })),
    });

    let corruptPayload = false;
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (corruptPayload) {
        return Response.json({ invalid: true }, { status: 200 });
      }
      if (url.includes('/actions/runs/1001/jobs')) {
        return Response.json({ total_count: 1, jobs: [makeRawJob()] });
      }
      if (url.includes('/actions/runs/1001')) {
        return Response.json(makeRawRun());
      }
      if (url.includes('/actions/runs')) {
        return Response.json({ total_count: 1, workflow_runs: [makeRawRun()] });
      }
      if (url.includes('/actions/jobs/5001/logs')) {
        expect(new Headers(init?.headers).get('authorization')).toBe('token ci-route-token');
        return new Response(null, { status: 302, headers: { Location: 'https://logs.example.com/5001.txt' } });
      }
      if (url === 'https://logs.example.com/5001.txt') {
        expect(new Headers(init?.headers).get('authorization')).toBeNull();
        return new Response('step 1 ok\n', { status: 200 });
      }
      if (url.includes('/actions/jobs/5001')) {
        return Response.json(makeRawJob());
      }
      return Response.json({}, { status: 404 });
    }));

    const query = {
      directory: '/workspace/app',
      repositoryId: 'repo-1',
      accountId,
      bindingRevision: '1',
      primaryRemote: 'origin',
    };

    const runsRes = await request(app).get('/api/source-control/github/ci/runs').query(query).expect(200);
    expect(runsRes.body.items).toHaveLength(1);
    expect(runsRes.body.items[0].id).toBe('1001');

    const detailRes = await request(app).get('/api/source-control/github/ci/run').query({ ...query, runId: '1001' }).expect(200);
    expect(detailRes.body.run.id).toBe('1001');
    expect(detailRes.body.ci.runs).toHaveLength(1);

    await request(app).get('/api/source-control/github/ci/run').query({ ...query, runId: 'abc' }).expect(400);

    const logRes = await request(app).get('/api/source-control/github/ci/job-log').query({ ...query, jobId: '5001' }).expect(200);
    expect(logRes.body).toEqual({
      identity: IDENTITY,
      jobId: '5001',
      available: true,
      content: 'step 1 ok\n',
      truncated: false,
    });

    corruptPayload = true;
    // Different page avoids octokit's ETag conditional replay of page 1.
    const invalidRes = await request(app).get('/api/source-control/github/ci/runs').query({ ...query, page: '2' }).expect(500);
    expect(invalidRes.body.error).toContain('invalid workflow runs');
  });

  it('answers 501 SOURCE_CONTROL_CAPABILITY_UNSUPPORTED for providers without CI run resources', async () => {
    const providers = createSourceControlProviders({
      loaders: {
        gitlab: async () => ({
          createProvider: () => ({
            classifyFailure: () => 'provider-error',
            auth: {
              resolveAccount: vi.fn(async () => ({ accountId: 'gl-1', instance: 'https://gitlab.com' })),
              listInstances: vi.fn(async () => []),
              listConnectedAccounts: vi.fn(async () => []),
            },
            resources: {},
          }),
        }),
      },
    });
    const app = express();
    registerSourceControlRoutes(app, {
      providers,
      bindingService: {
        validateReadContext: vi.fn(async (ctx) => ctx),
        validateMutationContext: vi.fn(),
        accountUnavailable: vi.fn(),
        accountConnected: vi.fn(),
      },
      identityProvisioning: { backfillAccountIdentities: vi.fn(), ensureAccountIdentity: vi.fn(), repointAccountIdentities: vi.fn() },
      mutationExecutor: { read: vi.fn(), execute: vi.fn() },
    });

    const res = await request(app).get('/api/source-control/gitlab/ci/runs').query({
      instance: 'https://gitlab.com',
      directory: '/workspace/app',
      repositoryId: 'repo-1',
      accountId: 'gl-1',
      bindingRevision: '1',
      primaryRemote: 'origin',
    }).expect(501);
    expect(res.body.code).toBe('SOURCE_CONTROL_CAPABILITY_UNSUPPORTED');
  });
});
