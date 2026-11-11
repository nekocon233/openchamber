import {
  invalidProviderPayload,
  isPlainObject,
  isProviderString,
  mapAnnotations,
  mapCI,
  mapProject,
  mapWorkflowJobAsCiRun,
  mapWorkflowRun,
  requireGitHubWorkflowJobs,
  requireGitHubWorkflowRun,
  requireGitHubWorkflowRuns,
} from './mappers.js';
import { summarizeCheckRuns } from './checks-summary.js';

const CI_RUNS_PER_PAGE = 30;
const FILTER_SCAN_PER_PAGE = 50;
const FILTER_SCAN_MAX_PAGES = 3;
const MAX_JOBS_PAGES = 3;
const JOBS_PER_PAGE = 100;
const MAX_ENRICHED_LIST_RUNS = 4;
const MAX_ANNOTATED_FAILED_JOBS = 10;
const ACTIVE_STATUS_BUCKET = new Set(['in_progress', 'queued', 'waiting', 'requested', 'pending']);

const normalizeLower = (value) => (isProviderString(value) ? value.trim().toLowerCase() : '');

async function mapLimited(items, limit, workerFn) {
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      results[idx] = await workerFn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Parse a CI search string into GitHub API filters and local match predicates.
 * Supports pasted Actions URLs, numeric run IDs, `#runNumber`, `branch:`,
 * `actor:` / `@login`, `event:`, 40-hex commit SHAs, and free-text terms.
 */
export function parseCiRunQuery(rawQuery, primaryRepo, instance) {
  const trimmed = isProviderString(rawQuery) ? rawQuery.trim() : '';
  if (!trimmed) {
    return {
      outOfScope: false,
      directRunId: null,
      runNumber: null,
      branch: '',
      actor: '',
      event: '',
      headSha: '',
      terms: [],
    };
  }

  // Pasted GitHub Actions run URL: https://<host>/<owner>/<repo>/actions/runs/<id>
  try {
    const parsedUrl = new URL(trimmed);
    if (parsedUrl.protocol === 'https:' || parsedUrl.protocol === 'http:') {
      const match = parsedUrl.pathname.match(/^\/([^/]+)\/([^/]+)\/actions\/runs\/([1-9]\d*)(?:\/|$)/i);
      if (match) {
        const urlHost = parsedUrl.hostname.toLowerCase();
        const sameHost = urlHost === String(instance || 'github.com').toLowerCase();
        const sameRepo = match[1].toLowerCase() === primaryRepo.owner.toLowerCase()
          && match[2].toLowerCase() === primaryRepo.repo.toLowerCase();
        if (!sameHost || !sameRepo) {
          return { outOfScope: true, directRunId: null, runNumber: null, branch: '', actor: '', event: '', headSha: '', terms: [] };
        }
        const runId = Number(match[3]);
        if (Number.isSafeInteger(runId) && runId > 0) {
          return { outOfScope: false, directRunId: runId, runNumber: null, branch: '', actor: '', event: '', headSha: '', terms: [] };
        }
      }
    }
  } catch {
    // Plain text query.
  }

  // Large bare integer (>= 1,000,000) is a GitHub Actions workflow run ID.
  if (/^[1-9]\d{6,}$/.test(trimmed)) {
    const runId = Number(trimmed);
    if (Number.isSafeInteger(runId)) {
      return { outOfScope: false, directRunId: runId, runNumber: null, branch: '', actor: '', event: '', headSha: '', terms: [] };
    }
  }

  let branch = '';
  let actor = '';
  let event = '';
  let headSha = '';
  let runNumber = null;
  const terms = [];

  for (const token of trimmed.split(/\s+/).filter(Boolean)) {
    const lowerToken = token.toLowerCase();
    if (lowerToken.startsWith('branch:') && token.length > 7) {
      branch = token.slice(7);
      continue;
    }
    if (lowerToken.startsWith('actor:') && token.length > 6) {
      actor = token.slice(6);
      continue;
    }
    if (token.startsWith('@') && token.length > 1 && !token.includes('/')) {
      actor = token.slice(1);
      continue;
    }
    if (lowerToken.startsWith('event:') && token.length > 6) {
      event = token.slice(6).toLowerCase();
      continue;
    }
    if (/^[0-9a-f]{40}$/i.test(token)) {
      headSha = lowerToken;
      continue;
    }
    const numberMatch = token.match(/^#([1-9]\d*)$/);
    if (numberMatch) {
      const parsed = Number(numberMatch[1]);
      if (Number.isSafeInteger(parsed)) {
        runNumber = parsed;
        continue;
      }
    }
    terms.push(lowerToken);
  }

  return { outOfScope: false, directRunId: null, runNumber, branch, actor, event, headSha, terms };
}

function matchesLocalFilters(rawRun, { runNumber, terms, status }) {
  if (status === 'active' && !ACTIVE_STATUS_BUCKET.has(normalizeLower(rawRun.status))) {
    return false;
  }
  if (status === 'failure') {
    const conclusion = normalizeLower(rawRun.conclusion);
    if (rawRun.status !== 'completed' || !['failure', 'timed_out', 'startup_failure', 'action_required'].includes(conclusion)) {
      return false;
    }
  }
  if (status === 'success') {
    if (rawRun.status !== 'completed' || normalizeLower(rawRun.conclusion) !== 'success') {
      return false;
    }
  }
  if (runNumber !== null && rawRun.run_number !== runNumber) {
    return false;
  }
  if (terms.length === 0) return true;
  const haystack = [
    rawRun.name,
    rawRun.display_title,
    rawRun.head_branch,
    rawRun.head_sha,
    rawRun.event,
    rawRun.actor?.login,
    rawRun.triggering_actor?.login,
    rawRun.head_commit?.message,
    `#${rawRun.run_number}`,
    String(rawRun.id),
  ]
    .filter(isProviderString)
    .join('\n')
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

function requireWorkflowRunsPage(response) {
  const data = response?.data;
  if (!isPlainObject(data) || !Array.isArray(data.workflow_runs) || !Number.isSafeInteger(data.total_count) || data.total_count < 0) {
    throw invalidProviderPayload('GitHub returned an invalid workflow runs response');
  }
  return {
    runs: requireGitHubWorkflowRuns(data.workflow_runs),
    totalCount: data.total_count,
  };
}

async function listWorkflowRunJobs(octokit, repo, runId, { maxPages = 1 } = {}) {
  const allJobs = [];
  let totalCount = 0;
  for (let page = 1; page <= maxPages; page += 1) {
    const response = await octokit.rest.actions.listJobsForWorkflowRun({
      owner: repo.owner,
      repo: repo.repo,
      run_id: runId,
      filter: 'latest',
      per_page: JOBS_PER_PAGE,
      page,
    });
    const data = response?.data;
    if (!isPlainObject(data)) {
      throw invalidProviderPayload('GitHub returned an invalid workflow jobs response');
    }
    const jobs = requireGitHubWorkflowJobs(data.jobs);
    if (Number.isSafeInteger(data.total_count) && data.total_count >= 0) {
      totalCount = data.total_count;
    }
    allJobs.push(...jobs);
    if (jobs.length < JOBS_PER_PAGE || (totalCount > 0 && allJobs.length >= totalCount)) {
      break;
    }
  }
  return allJobs;
}

function summarizeWorkflowJobs(jobs) {
  // Workflow jobs carry the exact same `status`, `conclusion`, and `started_at`
  // fields as check runs, so `summarizeCheckRuns` produces identical counts.
  return summarizeCheckRuns(jobs);
}

async function enrichListRunsWithJobSummaries(octokit, repo, rawRuns, { includeNewestCompleted = false } = {}) {
  const candidates = [];
  for (let i = 0; i < rawRuns.length && candidates.length < MAX_ENRICHED_LIST_RUNS; i += 1) {
    const run = rawRuns[i];
    const isActive = ACTIVE_STATUS_BUCKET.has(normalizeLower(run.status));
    if (isActive || (includeNewestCompleted && i === 0)) {
      candidates.push(run.id);
    }
  }
  const byRunId = new Map();
  await mapLimited(candidates, 4, async (runId) => {
    try {
      const jobs = await listWorkflowRunJobs(octokit, repo, runId, { maxPages: 1 });
      if (jobs.length > 0) {
        byRunId.set(runId, summarizeWorkflowJobs(jobs));
      }
    } catch (error) {
      if ((error?.status ?? error?.response?.status) === 401) throw error;
      // Optional job-count enrichment never fails the workflow run listing.
    }
  });
  return byRunId;
}

export async function listGitHubCiRuns({
  octokit,
  identity,
  repo,
  page = 1,
  status = 'all',
  branch = '',
  query = '',
}) {
  const project = mapProject(repo, identity);
  const parsed = parseCiRunQuery(query, repo, identity.instance);
  if (parsed.outOfScope) {
    return { project, items: [], page: 1, hasMore: false };
  }

  const effectiveBranch = branch.trim() || parsed.branch;

  if (parsed.directRunId !== null) {
    if (page > 1) return { project, items: [], page, hasMore: false };
    try {
      const response = await octokit.rest.actions.getWorkflowRun({
        owner: repo.owner,
        repo: repo.repo,
        run_id: parsed.directRunId,
      });
      const rawRun = requireGitHubWorkflowRun(response?.data);
      if (effectiveBranch && (rawRun.head_branch ?? '') !== effectiveBranch) {
        return { project, items: [], page: 1, hasMore: false };
      }
      if (!matchesLocalFilters(rawRun, { runNumber: null, terms: [], status })) {
        return { project, items: [], page: 1, hasMore: false };
      }
      const summaries = await enrichListRunsWithJobSummaries(octokit, repo, [rawRun], { includeNewestCompleted: true });
      return {
        project,
        items: [mapWorkflowRun(rawRun, project, identity, { jobSummary: summaries.get(rawRun.id) })],
        page: 1,
        hasMore: false,
      };
    } catch (error) {
      if ((error?.status ?? error?.response?.status) === 404) {
        return { project, items: [], page: 1, hasMore: false };
      }
      throw error;
    }
  }

  const baseParams = {
    owner: repo.owner,
    repo: repo.repo,
  };
  if (effectiveBranch) baseParams.branch = effectiveBranch;
  if (parsed.actor) baseParams.actor = parsed.actor;
  if (parsed.event) baseParams.event = parsed.event;
  if (parsed.headSha) baseParams.head_sha = parsed.headSha;

  const hasLocalTextFilter = parsed.runNumber !== null || parsed.terms.length > 0;

  if (status === 'active' && !hasLocalTextFilter) {
    const [inProgressRes, queuedRes, waitingRes] = await Promise.all([
      octokit.rest.actions.listWorkflowRunsForRepo({ ...baseParams, status: 'in_progress', per_page: CI_RUNS_PER_PAGE, page }),
      octokit.rest.actions.listWorkflowRunsForRepo({ ...baseParams, status: 'queued', per_page: CI_RUNS_PER_PAGE, page }),
      octokit.rest.actions.listWorkflowRunsForRepo({ ...baseParams, status: 'waiting', per_page: CI_RUNS_PER_PAGE, page }).catch((error) => {
        if ((error?.status ?? error?.response?.status) === 401) throw error;
        return null;
      }),
    ]);
    const inProgress = requireWorkflowRunsPage(inProgressRes);
    const queued = requireWorkflowRunsPage(queuedRes);
    const waiting = waitingRes ? requireWorkflowRunsPage(waitingRes) : { runs: [], totalCount: 0 };
    const deduped = new Map();
    for (const run of [...inProgress.runs, ...queued.runs, ...waiting.runs]) {
      if (!deduped.has(run.id)) deduped.set(run.id, run);
    }
    const merged = Array.from(deduped.values()).sort((left, right) => {
      const leftTime = Date.parse(left.created_at || '') || 0;
      const rightTime = Date.parse(right.created_at || '') || 0;
      return rightTime - leftTime || right.id - left.id;
    });
    const hasMore = page * CI_RUNS_PER_PAGE < inProgress.totalCount
      || page * CI_RUNS_PER_PAGE < queued.totalCount
      || page * CI_RUNS_PER_PAGE < waiting.totalCount;
    const summaries = await enrichListRunsWithJobSummaries(octokit, repo, merged);
    return {
      project,
      items: merged.map((run) => mapWorkflowRun(run, project, identity, { jobSummary: summaries.get(run.id) })),
      page,
      hasMore,
    };
  }

  const apiStatus = status === 'failure' ? 'failure' : status === 'success' ? 'success' : undefined;

  if (!hasLocalTextFilter) {
    const requestParams = { ...baseParams, per_page: CI_RUNS_PER_PAGE, page };
    if (apiStatus) requestParams.status = apiStatus;
    const response = await octokit.rest.actions.listWorkflowRunsForRepo(requestParams);
    const { runs, totalCount } = requireWorkflowRunsPage(response);
    const summaries = await enrichListRunsWithJobSummaries(octokit, repo, runs, {
      includeNewestCompleted: Boolean(effectiveBranch) && page === 1 && status === 'all',
    });
    return {
      project,
      items: runs.map((run) => mapWorkflowRun(run, project, identity, { jobSummary: summaries.get(run.id) })),
      page,
      hasMore: (page - 1) * CI_RUNS_PER_PAGE + runs.length < totalCount && runs.length > 0,
    };
  }

  // Local text / `#runNumber` filter scans bounded pages starting at `page`.
  const matched = [];
  let scanPage = (page - 1) * FILTER_SCAN_MAX_PAGES + 1;
  let pagesScanned = 0;
  let upstreamHasMore = false;
  while (pagesScanned < FILTER_SCAN_MAX_PAGES && matched.length < CI_RUNS_PER_PAGE) {
    const scanParams = { ...baseParams, per_page: FILTER_SCAN_PER_PAGE, page: scanPage };
    if (apiStatus) scanParams.status = apiStatus;
    const response = await octokit.rest.actions.listWorkflowRunsForRepo(scanParams);
    const { runs, totalCount } = requireWorkflowRunsPage(response);
    for (const run of runs) {
      if (matchesLocalFilters(run, { runNumber: parsed.runNumber, terms: parsed.terms, status })) {
        matched.push(run);
      }
    }
    upstreamHasMore = (scanPage - 1) * FILTER_SCAN_PER_PAGE + runs.length < totalCount && runs.length > 0;
    pagesScanned += 1;
    scanPage += 1;
    if (!upstreamHasMore || parsed.runNumber !== null && matched.length > 0) {
      break;
    }
  }
  const pageItems = matched.slice(0, CI_RUNS_PER_PAGE);
  const summaries = await enrichListRunsWithJobSummaries(octokit, repo, pageItems);
  return {
    project,
    items: pageItems.map((run) => mapWorkflowRun(run, project, identity, { jobSummary: summaries.get(run.id) })),
    page,
    hasMore: matched.length > CI_RUNS_PER_PAGE || upstreamHasMore,
  };
}

export async function readGitHubCiRunDetail({
  octokit,
  identity,
  repo,
  runId,
}) {
  const project = mapProject(repo, identity);
  let rawRun;
  try {
    const response = await octokit.rest.actions.getWorkflowRun({
      owner: repo.owner,
      repo: repo.repo,
      run_id: runId,
    });
    rawRun = requireGitHubWorkflowRun(response?.data);
  } catch (error) {
    if ((error?.status ?? error?.response?.status) === 404) {
      return { identity, project, run: null, ci: null };
    }
    throw error;
  }

  const jobs = await listWorkflowRunJobs(octokit, repo, runId, { maxPages: MAX_JOBS_PAGES });
  const failedJobs = jobs
    .filter((job) => {
      const conclusion = normalizeLower(job.conclusion);
      return Boolean(job.id) && Boolean(conclusion) && !['success', 'neutral', 'skipped'].includes(conclusion);
    })
    .slice(0, MAX_ANNOTATED_FAILED_JOBS);

  const annotationsByJobId = new Map();
  await mapLimited(failedJobs, 4, async (job) => {
    try {
      const response = await octokit.rest.checks.listAnnotations({
        owner: repo.owner,
        repo: repo.repo,
        check_run_id: job.id,
        per_page: 50,
        page: 1,
      });
      const rawAnnotations = Array.isArray(response?.data) ? response.data : [];
      const mapped = mapAnnotations(rawAnnotations);
      if (mapped.length > 0) annotationsByJobId.set(job.id, mapped);
    } catch (error) {
      if ((error?.status ?? error?.response?.status) === 401) throw error;
      // Missing check-run annotations leave the job readable.
    }
  });

  const workflowName = isProviderString(rawRun.name) && rawRun.name ? rawRun.name : 'Workflow';
  const mappedRuns = jobs.map((job) => mapWorkflowJobAsCiRun(job, {
    runId: rawRun.id,
    workflowName,
    annotations: annotationsByJobId.get(job.id),
  }, identity));

  let summary;
  if (jobs.length > 0) {
    summary = summarizeWorkflowJobs(jobs);
  } else {
    summary = {
      state: rawRun.status !== 'completed'
        ? 'pending'
        : normalizeLower(rawRun.conclusion) === 'success' || normalizeLower(rawRun.conclusion) === 'skipped' || normalizeLower(rawRun.conclusion) === 'neutral'
          ? 'success'
          : rawRun.conclusion ? 'failure' : 'unknown',
      total: 0,
      success: 0,
      failure: 0,
      pending: 0,
      inProgress: rawRun.status === 'in_progress' ? 1 : 0,
      queued: rawRun.status === 'queued' || rawRun.status === 'waiting' ? 1 : 0,
    };
    if (isProviderString(rawRun.run_started_at) && rawRun.run_started_at) {
      summary.startedAt = rawRun.run_started_at;
    }
  }

  let latestCompletedAt = null;
  if (rawRun.status === 'completed') {
    for (const job of jobs) {
      if (isProviderString(job.completed_at) && (!latestCompletedAt || job.completed_at > latestCompletedAt)) {
        latestCompletedAt = job.completed_at;
      }
    }
  }

  return {
    identity,
    project,
    run: mapWorkflowRun(rawRun, project, identity, {
      jobSummary: summary,
      completedAtOverride: latestCompletedAt,
    }),
    ci: mapCI(summary, mappedRuns),
  };
}

export async function readGitHubCiJobLog({
  octokit,
  identity,
  repo,
  jobId,
  downloadJobLog,
}) {
  try {
    const jobResponse = await octokit.rest.actions.getJobForWorkflowRun({
      owner: repo.owner,
      repo: repo.repo,
      job_id: jobId,
    });
    if (!isPlainObject(jobResponse?.data) || !Number.isSafeInteger(jobResponse.data.id)) {
      throw invalidProviderPayload('GitHub returned an invalid workflow job');
    }
  } catch (error) {
    if ((error?.status ?? error?.response?.status) === 404) {
      return { identity, jobId: String(jobId), available: false, content: '', truncated: false };
    }
    throw error;
  }

  const downloaded = await downloadJobLog(octokit, {
    owner: repo.owner,
    repo: repo.repo,
    jobId,
  });
  return {
    identity,
    jobId: String(jobId),
    available: Boolean(downloaded.available),
    content: isProviderString(downloaded.content) ? downloaded.content : '',
    truncated: Boolean(downloaded.truncated),
  };
}
