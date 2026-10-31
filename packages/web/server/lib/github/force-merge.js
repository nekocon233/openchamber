import { z } from 'zod';

const text = z.string().min(1);
const sha = z.string().regex(/^[0-9a-f]{40}$/i);
const repository = z.object({ name: text, owner: z.object({ login: text }) });
const targetSchema = z.object({
  project: z.object({ owner: text, name: text }), number: z.number().int().positive(),
  head: text, base: text, headSha: sha,
});
const preflightSchema = z.object({ node: z.object({
  __typename: z.literal('PullRequest'), id: text, number: z.number().int().positive(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']), isDraft: z.boolean(),
  mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']),
  headRefOid: sha, headRefName: text, baseRefName: text, repository,
}) });
const resultSchema = z.object({ mergePullRequest: z.object({ pullRequest: z.object({ id: text, merged: z.literal(true) }) }) });
const refusalSchema = z.object({
  errors: z.array(z.object({ message: text, type: z.enum(['FORBIDDEN', 'UNPROCESSABLE', 'NOT_FOUND']) })).min(1),
  data: z.object({ mergePullRequest: z.null() }).nullish(),
});
const preflightAuthErrorSchema = z.object({
  status: z.union([z.literal(401), z.literal(403)]),
  sourceControlIdentity: z.object({ provider: z.literal('github'), instance: z.literal('github.com'), accountId: text }).optional(),
  sourceControlPersistedAccount: z.boolean().optional(),
  sourceControlInvalidated: z.boolean().optional(),
});

/** A failure before the merge write was dispatched, including failed reads. */
export class ForceMergePreflightError extends Error {
  constructor(message, code = 'SOURCE_CONTROL_MUTATION_PRECHECK_FAILED', status = 502) {
    super(message);
    this.name = 'ForceMergePreflightError';
    this.code = code;
    this.status = status;
  }
}

const query = `query ForceMergeTarget($id: ID!) {
  node(id: $id) {
    __typename
    ... on PullRequest {
      id number state isDraft mergeable
      headRefOid headRefName baseRefName repository { name owner { login } }
    }
  }
}`;
const mutation = `mutation ForceMergePullRequest($input: MergePullRequestInput!) {
  mergePullRequest(input: $input) { pullRequest { id merged } }
}`;

/** The caller supplies its fresh REST-validated target and that same account's client. */
export async function forceMergePullRequest({ octokit, nodeId, target, method }) {
  const parsedTarget = targetSchema.safeParse(target);
  if (!parsedTarget.success || !text.safeParse(nodeId).success || !['merge', 'squash', 'rebase'].includes(method)) {
    throw new ForceMergePreflightError('GitHub returned an invalid administrator merge target');
  }
  let response;
  try { response = await octokit.graphql(query, { id: nodeId }); }
  catch (error) {
    const auth = preflightAuthErrorSchema.safeParse(error).data;
    const failure = new ForceMergePreflightError('Could not verify the GitHub pull request. Refresh and try again.',
      'SOURCE_CONTROL_MUTATION_PRECHECK_FAILED', auth?.status ?? 502);
    if (auth?.sourceControlIdentity) failure.sourceControlIdentity = auth.sourceControlIdentity;
    if (auth?.sourceControlPersistedAccount !== undefined) failure.sourceControlPersistedAccount = auth.sourceControlPersistedAccount;
    if (auth?.sourceControlInvalidated !== undefined) failure.sourceControlInvalidated = auth.sourceControlInvalidated;
    throw failure;
  }
  const parsed = preflightSchema.safeParse(response);
  if (!parsed.success) throw new ForceMergePreflightError('GitHub returned an invalid pull request preflight response');
  const pull = parsed.data.node;
  const expected = parsedTarget.data;
  if (pull.id !== nodeId || pull.number !== expected.number
    || pull.repository.owner.login.toLowerCase() !== expected.project.owner.toLowerCase()
    || pull.repository.name.toLowerCase() !== expected.project.name.toLowerCase()
    || pull.headRefName !== expected.head || pull.baseRefName !== expected.base || pull.headRefOid !== expected.headSha) {
    throw new ForceMergePreflightError('The pull request changed. Refresh before merging.', 'SOURCE_CONTROL_MUTATION_TARGET_CHANGED', 409);
  }
  if (pull.state === 'MERGED') {
    throw new ForceMergePreflightError('This pull request is already merged. Refresh the pull request.', 'SOURCE_CONTROL_MUTATION_TARGET_CHANGED', 409);
  }
  if (pull.state !== 'OPEN' || pull.isDraft || pull.mergeable !== 'MERGEABLE') {
    throw new ForceMergePreflightError('Administrator merge requires an open, ready pull request without merge conflicts.', 'SOURCE_CONTROL_MUTATION_REJECTED', 409);
  }
  let merged;
  try {
    merged = await octokit.graphql(mutation, { input: {
      pullRequestId: nodeId, mergeMethod: method.toUpperCase(), expectedHeadOid: expected.headSha,
    } });
  } catch (error) {
    const refusal = refusalSchema.safeParse(error);
    if (refusal.success) {
      throw Object.assign(new Error(refusal.data.errors[0].message), { code: 'SOURCE_CONTROL_MUTATION_REJECTED', status: 422 });
    }
    throw error;
  }
  const result = resultSchema.safeParse(merged);
  if (!result.success || result.data.mergePullRequest.pullRequest.id !== nodeId) {
    throw Object.assign(new Error('GitHub returned an invalid administrator merge result'), { code: 'MALFORMED_PROVIDER_RESPONSE' });
  }
  return { merged: true };
}
