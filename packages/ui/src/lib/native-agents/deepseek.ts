import { z } from 'zod';

export const deepseekSetupStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.enum(['idle', 'installing', 'ready']) }),
  z.object({ state: z.literal('error'), code: z.string().min(1) }),
]);

export type DeepseekSetupStatus = z.infer<typeof deepseekSetupStatusSchema>;
