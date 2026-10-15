import { z } from 'zod';

export const nativeMemoryConnectionSchema = z.object({
  backend: z.enum(['claude', 'codex']), installed: z.boolean(), ready: z.boolean(),
  reviewRequired: z.boolean(), lastSeen: z.number().nullable(),
});
export const nativeMemoryStatusSchema = z.object({
  enabled: z.boolean(), canManage: z.boolean(),
  backends: z.array(z.union([
    nativeMemoryConnectionSchema.extend({ status: z.literal('ok') }),
    z.object({ status: z.literal('unavailable'), backend: z.enum(['claude', 'codex']) }),
  ])),
  progressUnavailable: z.boolean().optional(), sourcesUnavailable: z.boolean().optional(),
  progress: z.array(z.object({
    backend: z.enum(['claude', 'codex']), sessionId: z.string(), projectId: z.string(),
    summary: z.string(), status: z.enum(['completed', 'interrupted']), observedAt: z.number(), revision: z.number(),
  })),
  sources: z.array(z.object({ id: z.string(), backend: z.enum(['claude', 'codex']), name: z.string(), bytes: z.number() })),
});
export type NativeMemoryStatus = z.infer<typeof nativeMemoryStatusSchema>;
export type NativeMemoryConnection = z.infer<typeof nativeMemoryConnectionSchema>;
