import { z } from 'zod';

const claudeConnectionModelSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  modelID: z.string().trim().min(1).max(200),
  contextWindow: z.number().int().min(1024).max(10_000_000),
  outputLimit: z.number().int().min(1).max(1_000_000),
  input: z.object({ image: z.boolean(), pdf: z.boolean() }),
  efforts: z.array(z.enum(['low', 'medium', 'high', 'xhigh', 'max'])).max(5),
});
export const claudeConnectionWriteSchema = z.object({
  name: z.string().trim().min(1).max(120),
  baseURL: z.string().url().max(2048).refine((value) => {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  }),
  auth: z.enum(['api-key', 'bearer']),
  apiKey: z.string().trim().min(1).max(8192).optional(),
  models: z.array(claudeConnectionModelSchema).min(1).max(50)
    .refine((models) => new Set(models.map((model) => model.id)).size === models.length),
});
export const claudeConnectionSchema = claudeConnectionWriteSchema.omit({ apiKey: true }).extend({
  id: z.string().uuid(),
  revision: z.number().int().positive(),
  hasKey: z.boolean(),
});
export const claudeConnectionListSchema = z.array(claudeConnectionSchema);
export type ClaudeConnection = z.infer<typeof claudeConnectionSchema>;
export type ClaudeConnectionWrite = z.infer<typeof claudeConnectionWriteSchema>;
export type ClaudeConnectionModel = z.infer<typeof claudeConnectionModelSchema>;
