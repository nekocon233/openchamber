import { z } from 'zod';
import type { Session } from '@/lib/opencode/model';

export const agentCombinationIdSchema = z.string().uuid();

const provider = z.enum(['claude-native', 'codex-native', 'deepseek-native', 'antigravity-native']);
export const nativeAgentModelSchema = z.object({
  model: z.object({ providerID: provider, modelID: z.string().trim().min(1).max(300) }).strict(),
  variant: z.string().trim().min(1).max(100).optional(),
}).strict();
export type NativeAgentModel = z.infer<typeof nativeAgentModelSchema>;

export const nativeAgentCombinationSchema = z.object({
  id: agentCombinationIdSchema, name: z.string().trim().min(1).max(80),
  main: nativeAgentModelSchema,
  subagent: nativeAgentModelSchema.nullable(),
  execution: nativeAgentModelSchema,
}).strict();
export const nativeAgentCombinationsSchema = z.array(nativeAgentCombinationSchema).max(100)
  .refine((entries) => new Set(entries.map((entry) => entry.id)).size === entries.length);
export type NativeAgentCombination = z.infer<typeof nativeAgentCombinationSchema>;
export const favoriteAgentCombinationIdsSchema = z.array(z.string().uuid()).max(100).transform((ids) => [...new Set(ids)]);

const nativeAgentConfigurationSchema = z.object({
  unavailable: z.literal(true).optional(),
  revision: z.number().int().nonnegative(),
  subagent: nativeAgentModelSchema.nullable(),
  execution: nativeAgentModelSchema.nullable(),
  combination: z.object({ id: z.string().uuid(), name: z.string().max(80) }).optional(),
}).strict();
type NativeAgentConfiguration = z.infer<typeof nativeAgentConfigurationSchema>;
export type NativeAgentConfigurationWrite = Pick<NativeAgentConfiguration, 'subagent' | 'execution' | 'combination'>;

const sessionConfiguration = z.object({ openchamber: z.object({ native: z.object({ agents: nativeAgentConfigurationSchema.optional() }) }) });
export const nativeAgentConfigurationOf = (metadata: Session['metadata']): NativeAgentConfiguration | undefined => (
  sessionConfiguration.safeParse(metadata).data?.openchamber.native.agents
);

/** Resolve the model half of a default without treating a preset ID as a model. */
export const resolveCombinationModelDefault = (defaults: {
  defaultModel?: string; defaultVariant?: string; defaultAgentCombinationId?: string;
}, combinations: readonly NativeAgentCombination[]) => {
  if (!defaults.defaultAgentCombinationId) return { defaultModel: defaults.defaultModel, defaultVariant: defaults.defaultVariant };
  const entry = combinations.find((entry) => entry.id === defaults.defaultAgentCombinationId);
  return { defaultModel: entry ? `${entry.main.model.providerID}/${entry.main.model.modelID}` : undefined, defaultVariant: entry?.main.variant };
};
