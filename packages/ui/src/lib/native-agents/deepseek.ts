import { z } from 'zod';

const modelId = z.string().trim().min(1).max(200);
const endpoint = z.string().trim().url().max(2048).refine((value) => {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
});

export const deepseekConfigurationSchema = z.object({
  revision: z.number().int().nonnegative(),
  writable: z.boolean(),
  baseURL: endpoint.nullable(),
  modelIDs: z.array(modelId),
  credential: z.object({ configured: z.boolean(), writable: z.boolean() }),
});
export const deepseekConfigurationWriteSchema = z.object({
  revision: z.number().int().nonnegative(),
  baseURL: endpoint.nullable(),
  modelIDs: z.array(modelId).min(1).max(100).refine((ids) => new Set(ids).size === ids.length),
  apiKey: z.string().trim().min(1).max(8192).optional(),
});
export const deepseekConfigurationSaveSchema = z.object({
  status: z.enum(['saved', 'credential-error']),
  configuration: deepseekConfigurationSchema,
});
export const deepseekSetupStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.enum(['idle', 'installing', 'configuring', 'ready', 'needs-key']) }),
  z.object({ state: z.literal('error'), code: z.string().min(1) }),
]);

export type DeepseekConfiguration = z.infer<typeof deepseekConfigurationSchema>;
export type DeepseekConfigurationWrite = z.infer<typeof deepseekConfigurationWriteSchema>;
export type DeepseekConfigurationSave = z.infer<typeof deepseekConfigurationSaveSchema>;
export type DeepseekSetupStatus = z.infer<typeof deepseekSetupStatusSchema>;
