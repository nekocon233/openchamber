import { z } from 'zod';
import {
  REFERENCE_PAGE_SIZE,
  REFERENCE_REPOSITORY_QUERY,
  REPOSITORY_ISSUES_QUERY,
  REPOSITORY_PULLS_QUERY,
  issueNodeSchema,
  pullNodeSchema,
  referenceRepositorySchema,
  referenceSearchPageSchema,
} from './reference-contracts.js';
import { searchGitHubReferences, toReference } from './reference-search.js';
import type { Octokit, ReferenceRepo, SearchInput } from './contracts.js';

const repositoryReference = ({ name, owner }: z.infer<typeof referenceRepositorySchema>): ReferenceRepo =>
  ({ repo: name, owner: owner.login, source: 'origin' });
const referenceRepositoryResultSchema = z.object({ repository: referenceRepositorySchema });

const repositoryPullsSchema = z.object({
  repository: referenceRepositorySchema.extend({
    pullRequests: z.object({
      totalCount: z.number().int().nonnegative(),
      pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
      nodes: z.array(pullNodeSchema),
    }),
  }),
});

async function listRepositoryPullRequests({ octokit, repo, state, cursor }: {
  octokit: Octokit; repo: Pick<ReferenceRepo, 'repo' | 'owner'>;
  state: Exclude<SearchInput['state'], 'unanswered'>; cursor: string | null;
}) {
  const states = { open: ['OPEN'], closed: ['CLOSED', 'MERGED'], merged: ['MERGED'], all: null };
  const { repository } = repositoryPullsSchema.parse(await octokit.graphql(REPOSITORY_PULLS_QUERY, {
    owner: repo.owner,
    repo: repo.repo,
    states: states[state],
    first: REFERENCE_PAGE_SIZE,
    after: cursor || null,
    withReviewRequests: false,
  }));
  const page = repository.pullRequests;
  const repos = [repositoryReference(repository)];
  const items = page.nodes.map((node) => {
    const item = toReference(node, repos);
    if (!item) throw new Error('GitHub returned a pull request outside the bound repository');
    return item;
  });
  return { items, cursor: page.pageInfo.endCursor, hasMore: page.pageInfo.hasNextPage, total: page.totalCount };
}

const repositoryIssuesSchema = z.object({
  repository: referenceRepositorySchema.extend({
    issues: referenceSearchPageSchema.extend({ totalCount: z.number().int().nonnegative(), nodes: z.array(issueNodeSchema) }),
  }),
});

async function listRepositoryIssues({ octokit, repo, state, cursor }: {
  octokit: Octokit; repo: Pick<ReferenceRepo, 'repo' | 'owner'>;
  state: Exclude<SearchInput['state'], 'unanswered'>; cursor: string | null;
}) {
  const states = state === 'all' ? null : [state === 'open' ? 'OPEN' : 'CLOSED'];
  const { repository } = repositoryIssuesSchema.parse(await octokit.graphql(REPOSITORY_ISSUES_QUERY, {
    owner: repo.owner, repo: repo.repo, states, first: REFERENCE_PAGE_SIZE, after: cursor || null,
  }));
  const page = repository.issues;
  if (page.pageInfo.hasNextPage && !page.pageInfo.endCursor) throw new Error('GitHub returned an invalid issue cursor');
  const repos = [repositoryReference(repository)];
  const items = page.nodes.map(node => {
    const item = toReference(node, repos);
    if (!item) throw new Error('GitHub returned an issue outside the bound repository');
    return item;
  });
  return { items, cursor: page.pageInfo.endCursor, hasMore: page.pageInfo.hasNextPage, total: page.totalCount };
}

async function readRepositoryReferencePage(input: SearchInput, repo: ReferenceRepo, host: string) {
  if (!input.text.trim() && !input.labels?.length && input.people === 'any' && input.state !== 'unanswered') {
    const args = { octokit: input.octokit, repo, state: input.state, cursor: input.cursor };
    if (input.kind === 'issue') return listRepositoryIssues(args);
    if (input.kind === 'pull') return listRepositoryPullRequests(args);
  }
  const { repository } = referenceRepositoryResultSchema.parse(await input.octokit.graphql(REFERENCE_REPOSITORY_QUERY, {
    owner: repo.owner, repo: repo.repo,
  }));
  return searchGitHubReferences({ ...input, repos: [repositoryReference(repository)] }, { host, alias: repo });
}

export async function readGitHubReferencePage(input: SearchInput, host: string) {
  const bound = input.repos[0];
  if (input.scope !== 'repository' || !bound || input.repos.length !== 1) return searchGitHubReferences(input);
  const page = await readRepositoryReferencePage(input, bound, host);
  const sourceRepo = { owner: bound.owner, repo: bound.repo, source: bound.source };
  return { ...page, items: page.items.map(item => ({ ...item, sourceRepo })) };
}
