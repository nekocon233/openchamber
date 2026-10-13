import { z } from 'zod';

const revision = z.number().int().nonnegative();
const identity = z.string().min(1);

const nativeChecklistItemSchema = z.object({
  id: identity,
  subject: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
  description: z.string().optional(),
  activeForm: z.string().optional(),
  owner: z.string().optional(),
  blocks: z.array(identity).default([]),
  blockedBy: z.array(identity).default([]),
});

export const nativeChecklistSnapshotSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('ready'),
    identity,
    source: z.enum(['files', 'history']),
    revision,
    observedAt: z.number(),
    complete: z.boolean(),
    unreadable: z.number().int().nonnegative(),
    items: z.array(nativeChecklistItemSchema),
  }).refine((snapshot) => !snapshot.complete || snapshot.unreadable === 0, {
    message: 'A complete checklist cannot contain unreadable entries',
  }),
  z.object({ state: z.literal('unavailable'), reason: z.enum(['unsupported', 'source_unknown']) }),
]);

const nativeExecutionTaskSchema = z.object({
  id: identity,
  type: z.string(),
  description: z.string(),
  // Membership is independent from the task's last reported outcome.
  active: z.boolean(),
  ambient: z.boolean(),
  status: z.enum(['unknown', 'pending', 'running', 'paused', 'completed', 'failed', 'stopped']),
  canStop: z.boolean(),
  outputAvailable: z.boolean(),
  toolUseId: identity.optional(),
  childSessionId: identity.optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  usage: z.object({
    totalTokens: z.number().nonnegative(),
    toolUses: z.number().nonnegative(),
    durationMs: z.number().nonnegative(),
  }).optional(),
  lastToolName: z.string().optional(),
});

export const nativeTaskSnapshotSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('unknown'),
    generation: identity,
    revision,
    tasks: z.array(nativeExecutionTaskSchema),
    omitted: z.number().int().nonnegative(),
  }),
  z.object({
    state: z.literal('active'),
    generation: identity,
    revision,
    tasks: z.array(nativeExecutionTaskSchema),
    omitted: z.number().int().nonnegative(),
  }),
  z.object({
    state: z.literal('inactive'),
    generation: z.null(),
    revision,
    tasks: z.array(nativeExecutionTaskSchema).length(0),
    omitted: z.literal(0),
  }),
  z.object({
    state: z.literal('unsupported'),
    generation: z.null(),
    revision,
    tasks: z.array(nativeExecutionTaskSchema).length(0),
    omitted: z.literal(0),
  }),
]);

export const nativeTaskOutputSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('ready'), text: z.string(), truncated: z.boolean() }),
  z.object({ state: z.literal('unavailable'), reason: z.enum(['not_recorded', 'query_closed', 'unreadable']) }),
]);

export const nativeTaskStopResultSchema = z.object({ accepted: z.literal(true) });

export type NativeChecklistItem = z.infer<typeof nativeChecklistItemSchema>;
export type NativeChecklistSnapshot = z.infer<typeof nativeChecklistSnapshotSchema>;
export type NativeExecutionTask = z.infer<typeof nativeExecutionTaskSchema>;
export type NativeTaskSnapshot = z.infer<typeof nativeTaskSnapshotSchema>;
export type NativeTaskOutput = z.infer<typeof nativeTaskOutputSchema>;
