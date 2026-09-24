// Boundary schemas for the native CLI session API (/api/native/*). The server
// projects native sessions into OpenCode's Session/Message/Part records; these
// schemas turn the network payload back into those SDK types, and `satisfies`
// keeps each schema's output assignable to the type the stores hold.

import type { Message, Part, Session } from '@opencode-ai/sdk/v2/client';
import { z } from 'zod';

import { sessionStatusSnapshotSchema } from '@/lib/opencode/session-status';

const metadataSchema = z.record(z.string(), z.unknown());

export const nativeSessionSchema = z.object({
  id: z.string().min(1),
  slug: z.string(),
  projectID: z.string(),
  directory: z.string().min(1),
  parentID: z.string().optional(),
  title: z.string(),
  version: z.string(),
  time: z.object({ created: z.number(), updated: z.number(), archived: z.number().optional() }),
  metadata: metadataSchema.optional(),
  // A revert the next prompt has not committed yet: the UI hides the messages
  // from this one on and offers them back.
  revert: z.object({ messageID: z.string().min(1) }).optional(),
}) satisfies z.ZodType<Session>;

const userMessageSchema = z.object({
  id: z.string().min(1),
  sessionID: z.string().min(1),
  role: z.literal('user'),
  time: z.object({ created: z.number() }),
  agent: z.string(),
  model: z.object({ providerID: z.string(), modelID: z.string(), variant: z.string().optional() }),
});

const messageErrorSchema = z.discriminatedUnion('name', [
  z.object({ name: z.literal('MessageAbortedError'), data: z.object({ message: z.string() }) }),
  z.object({ name: z.literal('UnknownError'), data: z.object({ message: z.string() }) }),
]);

const assistantMessageSchema = z.object({
  id: z.string().min(1),
  sessionID: z.string().min(1),
  role: z.literal('assistant'),
  time: z.object({ created: z.number(), completed: z.number().optional() }),
  error: messageErrorSchema.optional(),
  parentID: z.string().min(1),
  modelID: z.string(),
  providerID: z.string(),
  mode: z.string(),
  agent: z.string(),
  path: z.object({ cwd: z.string(), root: z.string() }),
  summary: z.boolean().optional(),
  cost: z.number(),
  tokens: z.object({
    total: z.number().optional(),
    input: z.number(),
    output: z.number(),
    reasoning: z.number(),
    cache: z.object({ read: z.number(), write: z.number() }),
  }),
  variant: z.string().optional(),
  finish: z.string().optional(),
});

const nativeMessageSchema = z.discriminatedUnion('role', [userMessageSchema, assistantMessageSchema]) satisfies z.ZodType<Message>;

const partBase = {
  id: z.string().min(1),
  sessionID: z.string().min(1),
  messageID: z.string().min(1),
};

const toolStateSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('running'),
    input: metadataSchema,
    title: z.string().optional(),
    metadata: metadataSchema.optional(),
    time: z.object({ start: z.number() }),
  }),
  z.object({
    status: z.literal('completed'),
    input: metadataSchema,
    output: z.string(),
    title: z.string(),
    metadata: metadataSchema,
    time: z.object({ start: z.number(), end: z.number() }),
  }),
  z.object({
    status: z.literal('error'),
    input: metadataSchema,
    error: z.string(),
    metadata: metadataSchema.optional(),
    time: z.object({ start: z.number(), end: z.number() }),
  }),
]);

const nativePartSchema = z.discriminatedUnion('type', [
  z.object({
    ...partBase,
    type: z.literal('text'),
    text: z.string(),
    synthetic: z.boolean().optional(),
    time: z.object({ start: z.number(), end: z.number().optional() }).optional(),
    metadata: metadataSchema.optional(),
  }),
  z.object({
    ...partBase,
    type: z.literal('reasoning'),
    text: z.string(),
    time: z.object({ start: z.number(), end: z.number().optional() }),
    metadata: metadataSchema.optional(),
  }),
  z.object({
    ...partBase,
    type: z.literal('file'),
    mime: z.string(),
    filename: z.string().optional(),
    url: z.string(),
  }),
  z.object({
    ...partBase,
    type: z.literal('compaction'),
    auto: z.boolean(),
  }),
  z.object({
    ...partBase,
    type: z.literal('tool'),
    callID: z.string(),
    tool: z.string(),
    state: toolStateSchema,
    metadata: metadataSchema.optional(),
  }),
]) satisfies z.ZodType<Part>;

// A part the schemas reject is left out; a record whose message is malformed
// is left out as a whole. The rest of the page still renders.
const nativeMessageRecordSchema = z.object({
  info: nativeMessageSchema,
  parts: z.array(z.unknown()).transform((parts) => parts.flatMap((rawPart) => {
    const part = nativePartSchema.safeParse(rawPart);
    return part.success ? [part.data] : [];
  })),
});


export const nativeMessagePageSchema = z.object({
  records: z.array(z.unknown()).transform((records) => records.flatMap((rawRecord) => {
    const record = nativeMessageRecordSchema.safeParse(rawRecord);
    return record.success ? [record.data] : [];
  })),
  cursor: z.string().nullable(),
  complete: z.boolean(),
  childSessions: z.array(nativeSessionSchema),
});

const sessionPartitionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), sessions: z.array(nativeSessionSchema) }),
  z.object({ status: z.literal('error'), message: z.string() }),
]);

export const nativeSessionListSchema = z.object({
  backends: z.object({ claude: sessionPartitionSchema, codex: sessionPartitionSchema }),
});


const nativeModelSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  contextWindow: z.number(),
  outputLimit: z.number(),
  efforts: z.array(z.string()),
  defaultEffort: z.string().nullable(),
  input: z.object({ image: z.boolean(), pdf: z.boolean() }),
});

export type NativeModelDescriptor = z.infer<typeof nativeModelSchema>;

const catalogPartitionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), models: z.array(nativeModelSchema) }),
  z.object({ status: z.literal('error'), message: z.string() }),
]);

export const nativeCatalogSchema = z.object({
  backends: z.object({ claude: catalogPartitionSchema, codex: catalogPartitionSchema }),
});

export const nativeCapabilitiesSchema = z.object({
  supported: z.literal(true),
  backends: z.object({
    claude: z.object({ cli: z.boolean() }),
    codex: z.object({ cli: z.boolean() }),
  }),
  registry: z.object({ reset: z.boolean(), resetAt: z.number().optional() }),
});

export const nativeStatusSnapshotSchema = sessionStatusSnapshotSchema;

export const nativeCommandListSchema = z.object({
  commands: z.array(z.object({ name: z.string().min(1), description: z.string(), argumentHint: z.string() })),
});

export const nativePromptAcceptedSchema = z.object({ accepted: z.literal(true) });
export const nativeRevertResultSchema = z.object({
  session: nativeSessionSchema,
  filesRestored: z.number().int().min(0),
  // The reverted prompt ran outside OpenChamber, so no snapshot of the files
  // before it exists: only the conversation goes back.
  conversationOnly: z.boolean(),
});
export const nativeAbortResultSchema = z.object({ aborted: z.boolean() });
export const nativeDeleteResultSchema = z.object({ deleted: z.literal(true) });
export const nativeQuestionRepliedSchema = z.object({ replied: z.literal(true) });
export const nativeQuestionRejectedSchema = z.object({ rejected: z.literal(true) });

export const nativeQuestionListSchema = z.array(z.object({
  id: z.string().min(1),
  sessionID: z.string().min(1),
  questions: z.array(z.object({
    question: z.string(),
    header: z.string(),
    options: z.array(z.object({ label: z.string(), description: z.string() })),
    multiple: z.boolean().optional(),
  })),
  tool: z.object({ messageID: z.string(), callID: z.string() }).optional(),
}));
