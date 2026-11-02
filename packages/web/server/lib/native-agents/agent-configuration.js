import { z } from 'zod';
import { nativeProviderSchema } from './ids.js';

export const agentModelSchema = z.object({
  model: z.object({ providerID: nativeProviderSchema, modelID: z.string().trim().min(1).max(300) }).strict(),
  variant: z.string().trim().min(1).max(100).optional(),
}).strict();
export const agentConfigurationWriteSchema = z.object({
  subagent: agentModelSchema.nullable(),
  execution: agentModelSchema.nullable(),
  combination: z.object({ id: z.string().uuid(), name: z.string().max(80) }).optional(),
}).strict();
export const agentConfigurationSchema = agentConfigurationWriteSchema.extend({ revision: z.number().int().nonnegative() });
export const agentCombinationsSchema = z.array(z.object({
  id: z.string().uuid(), name: z.string().trim().min(1).max(80),
  main: agentModelSchema, subagent: agentModelSchema.nullable(), execution: agentModelSchema,
}).strict()).max(100).refine((entries) => new Set(entries.map((entry) => entry.id)).size === entries.length);
