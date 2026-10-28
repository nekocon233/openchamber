import { z } from 'zod';
import type { Metadata } from '@/lib/opencode/model';

const namespaceSchema = z.object({ native: z.union([
  z.object({ backend: z.literal('deepseek'), historyRevision: z.number().int().nonnegative().default(0) }).catchall(z.json()),
  z.object({ kind: z.literal('unified'), backend: z.enum(['claude', 'codex', 'deepseek']), historyRevision: z.number().int().nonnegative() }).catchall(z.json()),
]) }).catchall(z.json());

export const nativeHistoryRevision = (metadata: Metadata | undefined): number | null => (
  namespaceSchema.safeParse(metadata?.openchamber).data?.native.historyRevision ?? null
);

export const withNativeHistoryRevision = (metadata: Metadata | undefined, revision: number): Metadata | undefined => {
  const namespace = namespaceSchema.safeParse(metadata?.openchamber);
  if (!namespace.success) return metadata;
  return { ...metadata, openchamber: { ...namespace.data, native: { ...namespace.data.native, historyRevision: revision } } };
};
