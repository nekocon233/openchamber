import { createHash } from 'node:crypto';
import { z } from 'zod';

const segment = z.object({ start: z.number().int().nonnegative(), scope: z.string().min(1) });
const branch = z.object({
  nativeId: z.string().min(1), segments: z.array(segment).min(1),
  parent: z.string().optional(), throughSeq: z.number().int().min(-1).optional(),
});
export const deepseekHistorySchema = z.object({
  active: z.string().min(1), revision: z.number().int().nonnegative(), branches: z.array(branch).min(1),
  admission: z.object({ messageId: z.string(), source: z.string() }).optional(),
}).refine((value) => value.branches.some((item) => item.nativeId === value.active), 'Missing active DSH branch');

export const deepseekRewindSchema = z.object({ nativeId: z.string().min(1), seq: z.number().int().nonnegative() });

export const initialDeepseekHistory = (id, nativeId) => ({
  active: nativeId, revision: 0, branches: [{ nativeId, segments: [{ start: 0, scope: id }] }],
});

export const deepseekIdentityScope = (branch, seq) => {
  let scope = branch.segments[0].scope;
  for (const segment of branch.segments) {
    if (segment.start > seq) break;
    scope = segment.scope;
  }
  return scope;
};

export const appendDeepseekBranch = (state, nativeId, seq) => {
  const source = state.branches.find((branch) => branch.nativeId === state.active);
  const throughSeq = seq - 1;
  const segments = source.segments.filter((segment) => segment.start <= throughSeq);
  segments.push({ start: seq, scope: nativeId });
  return { ...state, active: nativeId, revision: state.revision + 1, branches: [...state.branches, {
    nativeId, parent: state.active, throughSeq, segments,
  }] };
};

const branchKey = (nativeId) => createHash('sha256').update(nativeId).digest('hex').slice(0, 24);
export const deepseekHistoryCursor = (id, nativeId, seq) => `ndh_c2_${id.slice(4)}_${branchKey(nativeId)}_${seq}`;

/** A cursor from a retained prefix remains usable after a fork. A discarded tail does not. */
export const deepseekCursorPosition = (id, state, cursor) => {
  const modern = cursor.startsWith(`ndh_c2_${id.slice(4)}_`);
  const prefix = modern ? `ndh_c2_${id.slice(4)}_` : `ndh_c_${id.slice(4)}_`;
  if (!cursor.startsWith(prefix)) throw new Error('Invalid DSH cursor');
  const fields = cursor.slice(prefix.length).split('_');
  const rawSeq = fields[modern ? 1 : 0];
  if (fields.length !== (modern ? 2 : 1) || !/^\d+$/.test(rawSeq)) throw new Error('Invalid DSH cursor');
  const seq = z.number().int().nonnegative().safe().parse(Number(rawSeq));
  const nativeId = modern ? state.branches.find((item) => branchKey(item.nativeId) === fields[0])?.nativeId : state.branches[0].nativeId;
  if (!nativeId) throw new Error('Unrelated DSH cursor');
  let branch = state.branches.find((item) => item.nativeId === state.active);
  while (branch && branch.nativeId !== nativeId) {
    if (seq > (branch.throughSeq ?? -1)) throw new Error('Discarded DSH cursor');
    branch = state.branches.find((item) => item.nativeId === branch.parent);
  }
  if (!branch) throw new Error('Unrelated DSH cursor');
  return seq;
};
