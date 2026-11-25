import { z } from 'zod';
import { digestMutationInput } from '../source-control/mutation-executor.js';
import { reviewCommentPosition } from '../source-control/review-position.js';
import { isProviderString } from './mappers.js';
import { parsePendingReviewAction } from './pending-reviews.js';
import { isSourceControlInteger } from '../source-control/input-guards.js';
import type { SourceControlJson, SourceControlJsonObject, SourceControlMutationTarget } from '@openchamber/sdk';
import type { AccountIdentity, ProviderDescriptor, ProviderMutationContext } from '../source-control/provider-contract.js';
import type { GitHubEnvelope } from './contracts.js';
import type { NormalizedGitHubMutation, GitHubMutationInput } from './mutations.js';

export type MutationTarget = SourceControlMutationTarget;

export type MergeMethod = 'merge' | 'squash' | 'rebase';

const cancelAutoMergeSchema = z.strictObject({ enabledAt: z.iso.datetime(), mergeMethod: z.enum(['MERGE', 'SQUASH', 'REBASE']) });
export type AutoMergeRequest = { enabledAt: string; mergeMethod: string };

export type Credential = { accountId: string; credentialRevision: number };

export const isArray = (value: unknown): value is unknown[] => Array.isArray(value);

const isMergeMethod = (value: unknown): value is MergeMethod => value === 'merge' || value === 'squash' || value === 'rebase';

const isJsonBoolean = (value: SourceControlJson | undefined): value is boolean =>
  Object.prototype.toString.call(value) === '[object Boolean]';

const isNameList = (value: unknown): value is string[] => isArray(value)
  && !value.some((entry) => !isProviderString(entry) || !entry.trim() || entry.length > 256);

export const DISCUSSION_CLOSE_REASONS = Object.freeze({ resolved: 'RESOLVED', outdated: 'OUTDATED', duplicate: 'DUPLICATE' });

export const REVIEW_EVENTS = Object.freeze({
  approve: { event: 'APPROVE', state: 'APPROVED' },
  'request-changes': { event: 'REQUEST_CHANGES', state: 'CHANGES_REQUESTED' },
  comment: { event: 'COMMENT', state: 'COMMENTED' },
});

export const mutationError = (message: string, code = 'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT', status = 400) => Object.assign(new Error(message), { code, status });

export function commentText(value: SourceControlJson | undefined, required: true, maxLength: number): string;
export function commentText(value: SourceControlJson | undefined, required: boolean, maxLength: number): string | undefined;
export function commentText(value: SourceControlJson | undefined, required: boolean, maxLength: number) {
  if (value === undefined && !required) return undefined;
  if (!isProviderString(value) || !value.trim()) throw mutationError('body is required');
  if (value.length > maxLength) throw mutationError('body is too long');
  return value;
}

const nodeId = (value: SourceControlJson | undefined, name: string) => {
  if (!isProviderString(value) || !/^[A-Za-z0-9_=-]{1,200}$/.test(value)) throw mutationError(`${name} is invalid`);
  return value;
};

const restCommentId = (value: SourceControlJson | undefined) => {
  const id = isProviderString(value) || Number.isSafeInteger(value) ? String(value).trim() : '';
  if (!/^[1-9]\d{0,15}$/.test(id) || !Number.isSafeInteger(Number(id))) throw mutationError('commentId is invalid');
  return Number(id);
};

const reviewThreadId = (value: SourceControlJson | undefined) => nodeId(value, 'threadId');

const nameList = (value: SourceControlJson | undefined, name: string, limit: number): string[] => {
  if (!isArray(value) || value.length > limit || !isNameList(value)) {
    throw mutationError(`${name} are invalid`);
  }
  return [...new Set(value)].sort();
};

const requiredText = (value: SourceControlJson | undefined, name: string) => {
  if (!isProviderString(value) || !value.trim()) throw mutationError(`${name} is required`);
  return value.trim();
};

export const optionalText = (value: GitHubEnvelope['data'], name: string, trim = false) => {
  if (value === undefined) return undefined;
  if (!isProviderString(value)) throw mutationError(`${name} is invalid`);
  const normalized = trim ? value.trim() : value;
  if (trim && !normalized) throw mutationError(`${name} is invalid`);
  return normalized;
};

export function normalizeOperation(operation: string, body: SourceControlJsonObject, context: ProviderMutationContext, actor: AccountIdentity, credential: Credential, limits: ProviderDescriptor['limits']): NormalizedGitHubMutation {
  const digestOf = <Fields extends { target: MutationTarget }>(fields: Fields) => digestMutationInput({ kind: operation, actor, credential, ...fields });
  if (operation === 'create') {
    const title = requiredText(body.title, 'title');
    const text = optionalText(body.body, 'body');
    if (body.draft !== undefined && !isJsonBoolean(body.draft)) {
      throw mutationError('draft is invalid');
    }
    const draft = body.draft;
    const remote = optionalText(body.remote, 'remote', true);
    const headRemote = optionalText(body.headRemote, 'headRemote', true) ?? context.primaryRemote;
    const head = requiredText(context.target.head, 'target head');
    const base = requiredText(context.target.base, 'target base');
    if (context.target.number !== undefined || context.target.headSha !== undefined) throw mutationError('Create target is invalid');
    return {
      input: { title, body: text, draft, remote, headRemote, head, base },
      digest: (target) => {
        const fields: { target: MutationTarget } & Pick<GitHubMutationInput, 'title' | 'headRemote' | 'body' | 'draft' | 'remote'> = { target, title, headRemote };
        if (text !== undefined) fields.body = text;
        if (draft !== undefined) fields.draft = draft;
        if (remote) fields.remote = remote;
        return digestOf(fields);
      },
    };
  }

  if (!isSourceControlInteger(context.target.number) || context.target.number < 1) throw mutationError('target number is required');
  if (operation === 'update' || operation === 'issue-update' || operation === 'discussion-update') {
    const title = requiredText(body.title, 'title');
    const text = optionalText(body.body, 'body');
    return {
      input: { title, body: text },
      digest: (target) => digestOf(text === undefined ? { target, title } : { target, title, body: text }),
    };
  }
  if (operation === 'merge') {
    const method = requiredText(body.method, 'method');
    if (!isMergeMethod(method)) throw mutationError('merge method is invalid');
    if (body.cancel !== undefined && body.cancel !== true && body.cancel !== false) {
      const cancel = cancelAutoMergeSchema.safeParse(body.cancel);
      if (!cancel.success || method !== 'squash' || body.force === true) throw mutationError('cancel is invalid');
      requiredText(context.target.headSha, 'target headSha');
      requiredText(context.target.base, 'target base');
      return { input: { method, cancelAutoMerge: cancel.data }, digest: (target) => digestOf({ target, method, cancelAutoMerge: cancel.data }) };
    }
    if (body.force === true) {
      if (body.cancel === true) throw mutationError('Cannot force and cancel the same merge');
      requiredText(context.target.headSha, 'target headSha');
      return { input: { method, force: true }, digest: (target) => digestOf({ target, method, force: true }) };
    }
    return body.cancel === true
      ? { input: { method, cancel: true }, digest: (target) => digestOf({ target, method, cancel: true }) }
      : { input: { method }, digest: (target) => digestOf({ target, method }) };
  }
  if (operation === 'ready' || operation === 'draft') return { input: {}, digest: (target) => digestOf({ target }) };
  if (operation === 'labels' || operation === 'issue-labels' || operation === 'discussion-labels') {
    const labels = nameList(body.labels, 'labels', limits.labelsMax);
    return { input: { labels }, digest: (target) => digestOf({ target, labels }) };
  }
  if (operation === 'discussion-comment') {
    const replyTo = body.replyTo === undefined ? undefined : nodeId(body.replyTo, 'replyTo');
    const text = commentText(body.body, true, limits.commentMaxLength);
    return {
      input: { replyTo, body: text },
      digest: (target) => digestOf(replyTo === undefined ? { target, body: text } : { target, replyTo, body: text }),
    };
  }
  if (operation === 'discussion-state') {
    if (body.state === 'open') {
      if (body.reason !== undefined) throw mutationError('reason is invalid');
      return { input: { state: 'open' }, digest: (target) => digestOf({ target, state: 'open' }) };
    }
    if (body.state !== 'closed' || !Object.hasOwn(DISCUSSION_CLOSE_REASONS, String(body.reason))) throw mutationError('state is invalid');
    const { reason } = body;
    return { input: { state: 'closed', reason }, digest: (target) => digestOf({ target, state: 'closed', reason }) };
  }
  if (operation === 'discussion-answer') {
    const commentId = nodeId(body.commentId, 'commentId');
    if (body.answer !== true && body.answer !== false) throw mutationError('answer is invalid');
    const { answer } = body;
    return { input: { commentId, answer }, digest: (target) => digestOf({ target, commentId, answer }) };
  }
  if (operation === 'change-request-comment-update' || operation === 'issue-comment-update') {
    const commentId = restCommentId(body.commentId);
    const text = commentText(body.body, true, limits.commentMaxLength);
    return { input: { commentId, body: text }, digest: (target) => digestOf({ target, commentId, body: text }) };
  }
  if (operation === 'change-request-comment-delete' || operation === 'issue-comment-delete') {
    const commentId = restCommentId(body.commentId);
    return { input: { commentId }, digest: (target) => digestOf({ target, commentId }) };
  }
  if (operation === 'discussion-comment-update') {
    const commentId = nodeId(body.commentId, 'commentId');
    const text = commentText(body.body, true, limits.commentMaxLength);
    return { input: { commentId, body: text }, digest: (target) => digestOf({ target, commentId, body: text }) };
  }
  if (operation === 'discussion-comment-delete') {
    const commentId = nodeId(body.commentId, 'commentId');
    return { input: { commentId }, digest: (target) => digestOf({ target, commentId }) };
  }
  if (operation === 'reviewers') {
    const reviewers = nameList(body.reviewers, 'reviewers', limits.reviewersMax);
    return { input: { reviewers }, digest: (target) => digestOf({ target, reviewers }) };
  }
  if (operation === 'state' || operation === 'issue-state') {
    if (body.state !== 'open' && body.state !== 'closed') throw mutationError('state is invalid');
    const { state } = body;
    return { input: { state }, digest: (target) => digestOf({ target, state }) };
  }
  if (operation === 'comment' || operation === 'issue-comment') {
    const text = commentText(body.body, true, limits.commentMaxLength);
    return { input: { body: text }, digest: (target) => digestOf({ target, body: text }) };
  }
  if (operation === 'thread-reply') {
    const threadId = reviewThreadId(body.threadId);
    const text = commentText(body.body, true, limits.commentMaxLength);
    return { input: { threadId, body: text }, digest: (target) => digestOf({ target, threadId, body: text }) };
  }
  if (operation === 'thread-resolve') {
    const threadId = reviewThreadId(body.threadId);
    if (body.resolved !== true && body.resolved !== false) throw mutationError('resolved is invalid');
    const { resolved } = body;
    return { input: { threadId, resolved }, digest: (target) => digestOf({ target, threadId, resolved }) };
  }
  if (operation === 'review') {
    const { verdict } = body;
    if (!Object.hasOwn(REVIEW_EVENTS, String(verdict))) throw mutationError('review verdict is invalid');
    requiredText(context.target.headSha, 'target headSha');
    const text = commentText(body.body, false, limits.commentMaxLength);
    return {
      input: { verdict, body: text },
      digest: (target) => digestOf(text === undefined ? { target, verdict } : { target, verdict, body: text }),
    };
  }
  if (operation === 'pending-review') {
    requiredText(context.target.headSha, 'target headSha');
    const action = parsePendingReviewAction(body.action);
    return { input: { action }, digest: (target) => digestOf({ target, action }) };
  }
  if (operation === 'review-comment') {
    requiredText(context.target.headSha, 'target headSha');
    const position = reviewCommentPosition(body, (message) => { throw mutationError(message); });
    const text = commentText(body.body, true, limits.commentMaxLength);
    return { input: { ...position, body: text }, digest: (target) => digestOf({ target, ...position, body: text }) };
  }
  if (operation === 'review-comment-update') {
    const commentId = nodeId(body.commentId, 'commentId');
    const text = commentText(body.body, true, limits.commentMaxLength);
    return { input: { commentId, body: text }, digest: (target) => digestOf({ target, commentId, body: text }) };
  }
  if (operation === 'review-comment-delete') {
    const commentId = nodeId(body.commentId, 'commentId');
    return { input: { commentId }, digest: (target) => digestOf({ target, commentId }) };
  }
  if (operation === 'review-discard') return { input: {}, digest: (target) => digestOf({ target }) };
  throw mutationError('Mutation kind is invalid');
}
