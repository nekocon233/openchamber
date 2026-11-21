import { createHash } from 'node:crypto';
import { z } from 'zod';

const segmentSchema = z.object({ start: z.number().int().nonnegative(), scope: z.string().min(1) });
const branchSchema = z.object({
  nativeId: z.string().min(1),
  segments: z.array(segmentSchema).min(1),
  parent: z.string().optional(),
  throughSeq: z.number().int().min(-1).optional(),
});
export const deepseekHistorySchema = z.object({
  active: z.string().min(1),
  revision: z.number().int().nonnegative(),
  branches: z.array(branchSchema).min(1),
  admission: z.object({ messageId: z.string(), source: z.string() }).optional(),
}).refine((value) => value.branches.some((item) => item.nativeId === value.active), 'Missing active DSH branch');

export const deepseekRewindSchema = z.object({ nativeId: z.string().min(1), seq: z.number().int().nonnegative() });

export type DeepseekHistorySegment = z.infer<typeof segmentSchema>;
export type DeepseekHistoryBranch = z.infer<typeof branchSchema>;
export type DeepseekHistoryState = z.infer<typeof deepseekHistorySchema>;
export type DeepseekRewindPoint = z.infer<typeof deepseekRewindSchema>;

export const initialDeepseekHistory = (id: string, nativeId: string): DeepseekHistoryState => ({
  active: nativeId,
  revision: 0,
  branches: [{ nativeId, segments: [{ start: 0, scope: id }] }],
});

export const deepseekIdentityScope = (branch: DeepseekHistoryBranch, seq: number): string => {
  const first = branch.segments[0];
  if (!first) throw new Error('Missing DSH history segment');
  let scope = first.scope;
  for (const segment of branch.segments) {
    if (segment.start > seq) break;
    scope = segment.scope;
  }
  return scope;
};

export const appendDeepseekBranch = (state: DeepseekHistoryState, nativeId: string, seq: number): DeepseekHistoryState => {
  const source = state.branches.find((branch) => branch.nativeId === state.active);
  if (!source) throw new Error('Missing active DSH branch');
  const throughSeq = seq - 1;
  const segments = source.segments.filter((segment) => segment.start <= throughSeq);
  segments.push({ start: seq, scope: nativeId });
  return {
    ...state,
    active: nativeId,
    revision: state.revision + 1,
    branches: [...state.branches, {
      nativeId,
      parent: state.active,
      throughSeq,
      segments,
    }],
  };
};

const branchKey = (nativeId: string): string => createHash('sha256').update(nativeId).digest('hex').slice(0, 24);
export const deepseekHistoryCursor = (id: string, nativeId: string, seq: number): string => `ndh_c2_${id.slice(4)}_${branchKey(nativeId)}_${seq}`;

export const deepseekCursorPosition = (id: string, state: DeepseekHistoryState, cursor: string): number => {
  const modern = cursor.startsWith(`ndh_c2_${id.slice(4)}_`);
  const prefix = modern ? `ndh_c2_${id.slice(4)}_` : `ndh_c_${id.slice(4)}_`;
  if (!cursor.startsWith(prefix)) throw new Error('Invalid DSH cursor');
  const fields = cursor.slice(prefix.length).split('_');
  const rawSeq = fields[modern ? 1 : 0];
  if (fields.length !== (modern ? 2 : 1) || rawSeq === undefined || !/^\d+$/.test(rawSeq)) throw new Error('Invalid DSH cursor');
  const seq = z.number().int().nonnegative().safe().parse(Number(rawSeq));
  const nativeId = modern ? state.branches.find((item) => branchKey(item.nativeId) === fields[0])?.nativeId : state.branches[0]?.nativeId;
  if (!nativeId) throw new Error('Unrelated DSH cursor');
  let branch = state.branches.find((item) => item.nativeId === state.active);
  while (branch && branch.nativeId !== nativeId) {
    if (seq > (branch.throughSeq ?? -1)) throw new Error('Discarded DSH cursor');
    branch = state.branches.find((item) => item.nativeId === branch?.parent);
  }
  if (!branch) throw new Error('Unrelated DSH cursor');
  return seq;
};
