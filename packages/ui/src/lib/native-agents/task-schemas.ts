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

const nativeTodoSchema = z.object({
  id: identity,
  content: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
});

/**
 * The steps a Codex turn reported through `update_plan`. Codex marks the
 * notification carrying them transient and non-durable, so this is an
 * observation of one process rather than a stored list: `unknown` means
 * nothing was observed, and only its generation may be null — no observation
 * has an owner. `inactive` ends observation and keeps what was last seen,
 * because that is the only record that will exist.
 */
export const nativeTodosSnapshotSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('unknown'),
    generation: identity.nullable(),
    revision,
    todos: z.array(nativeTodoSchema),
  }),
  z.object({
    state: z.literal('active'),
    generation: identity,
    revision,
    todos: z.array(nativeTodoSchema),
  }),
  z.object({
    state: z.literal('inactive'),
    generation: identity,
    revision,
    todos: z.array(nativeTodoSchema),
  }),
  z.object({
    state: z.literal('unsupported'),
    generation: z.null(),
    revision,
    todos: z.array(nativeTodoSchema).length(0),
  }),
]);

export const nativeTaskOutputSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('ready'), text: z.string(), truncated: z.boolean() }),
  z.object({ state: z.literal('unavailable'), reason: z.enum(['not_recorded', 'query_closed', 'unreadable']) }),
]);

export const nativeTaskStopResultSchema = z.object({ accepted: z.literal(true) });

/**
 * The plan a Codex thread last wrote. Unlike the checklist it has no identity
 * and no partial reads: a plan belongs to one thread and is read whole from
 * the thread store or not at all. `empty` is an authoritative "this thread
 * has no plan", which is why it is a state of its own rather than an empty
 * `ready`.
 */
export const nativePlanSnapshotSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('ready'),
    observedAt: z.number(),
    text: z.string().min(1),
    truncated: z.boolean(),
    turnId: z.string().min(1),
  }),
  z.object({ state: z.literal('empty') }),
  z.object({ state: z.literal('unavailable'), reason: z.literal('unsupported') }),
]);

export type NativeChecklistItem = z.infer<typeof nativeChecklistItemSchema>;
export type NativeChecklistSnapshot = z.infer<typeof nativeChecklistSnapshotSchema>;
export type NativeExecutionTask = z.infer<typeof nativeExecutionTaskSchema>;
export type NativeTaskSnapshot = z.infer<typeof nativeTaskSnapshotSchema>;
export type NativeTaskOutput = z.infer<typeof nativeTaskOutputSchema>;
export type NativePlanSnapshot = z.infer<typeof nativePlanSnapshotSchema>;
export type NativeTodoItem = z.infer<typeof nativeTodoSchema>;
export type NativeTodosSnapshot = z.infer<typeof nativeTodosSnapshotSchema>;
