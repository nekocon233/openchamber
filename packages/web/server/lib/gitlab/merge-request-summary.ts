import { isPlainObject as isPlain, isString } from './validation.js';
import type { JsonObject, JsonValue } from '../shared/json-values.js';
import type { createGitLabClient } from './client.js';

export type Client = ReturnType<typeof createGitLabClient>;

export type Reply = Awaited<ReturnType<Client['Projects']['show']>>;

export type Field = JsonValue | undefined;

export type Ref = { owner: string; repo: string; number: number };

export const isPlainObject = (value: Reply | undefined): value is JsonObject => isPlain(value);

export const hasFields = (value: unknown): value is JsonObject => value != null;

export const obj = (value: Reply | undefined): JsonObject | undefined => hasFields(value) ? value : undefined;

export const integer = (value: Field): value is number => Number.isInteger(value);

export const hasIid = (value: Reply | undefined): value is JsonObject & { iid: number } => isPlainObject(value) && integer(value.iid);

export const text = (value: Field) => (isString(value) && value ? value : '');

const PIPELINE_PENDING = new Set(['created', 'waiting_for_resource', 'preparing', 'pending', 'running', 'manual', 'scheduled']);

export function liveMergeRequestSummary(ref: Ref, raw: Reply) {
  if (!hasIid(raw)) return null;
  const state = raw.state === 'opened' ? 'open' : raw.state === 'merged' ? 'merged' : 'closed';
  const conflicts = raw.has_conflicts === true;
  const ready = raw.detailed_merge_status === 'mergeable';
  const pipeline = text(obj(raw.head_pipeline)?.status);
  let checks = null;
  if (state === 'open' && pipeline) {
    const outcome = pipeline === 'success' || pipeline === 'skipped' ? 'success'
      : pipeline === 'failed' || pipeline === 'canceled' ? 'failure'
        : PIPELINE_PENDING.has(pipeline) ? 'pending' : 'unknown';
    checks = {
      state: outcome,
      total: 1,
      success: outcome === 'success' ? 1 : 0,
      failure: outcome === 'failure' ? 1 : 0,
      pending: outcome === 'pending' ? 1 : 0,
    };
  }
  const summary = {
    owner: ref.owner,
    repo: ref.repo,
    number: raw.iid,
    state,
    draft: raw.draft === true || raw.work_in_progress === true,
    title: isString(raw.title) ? raw.title : '',
    mergeable: conflicts ? false : ready ? true : null,
    mergeableState: conflicts ? 'dirty' : ready ? 'clean' : null,
    checks,
  };
  if (text(raw.sha)) Object.assign(summary, { headSha: raw.sha });
  if (text(raw.target_branch)) Object.assign(summary, { base: raw.target_branch });
  if (integer(raw.user_notes_count)) Object.assign(summary, { activity: raw.user_notes_count });
  return summary;
}
