import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { NativeAgentError, sessionNotFoundError } from '../errors.js';
import { decodeNativeSessionId, nativeBackendSchema, nativeProviderSchema } from '../ids.js';
import { agentConfigurationSchema } from '../agent-configuration.js';

const conversationId = z.string().regex(/^ncv_[0-9a-f-]{36}$/);

export const conversationSelectionSchema = z.object({
  model: z.object({ providerID: nativeProviderSchema, modelID: z.string().min(1) }),
  variant: z.string().min(1).optional(),
  agent: z.enum(['build', 'plan']),
}).strict();

const sendRecordSchema = z.object({
  messageId: z.string().min(1),
  nativeMessageId: z.string().min(1),
  createdAt: z.number(),
  state: z.enum(['pending', 'accepted']),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  selection: conversationSelectionSchema,
});

const segmentSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().refine((id) => decodeNativeSessionId(id) !== null),
  ownerId: conversationId,
  backend: nativeBackendSchema,
  createdAt: z.number(),
  timeOffset: z.number().optional(),
  through: z.string().optional(),
  before: z.string().optional(),
  from: z.string().optional(),
  sends: z.array(sendRecordSchema),
}).refine((segment) => decodeNativeSessionId(segment.sessionId)?.backend === segment.backend, 'The native source must match its backend');

const checkpointSchema = z.object({ through: z.string(), revision: z.number(), text: z.string() });

const rollbackSchema = z.object({
  segments: z.array(segmentSchema),
  active: z.string().nullable(),
  cut: z.string().optional(),
  checkpoint: checkpointSchema.optional(),
});

const manifestSchema = z.object({
  version: z.literal(1),
  id: conversationId,
  directory: z.string().min(1),
  title: z.string().min(1),
  manualTitle: z.boolean().default(false),
  generatedTitle: z.literal(true).optional(),
  parentID: conversationId.optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  archivedAt: z.number().optional(),
  revision: z.number().int().nonnegative(),
  selectionRevision: z.number().int().nonnegative().default(0),
  historyRevision: z.number().int().nonnegative(),
  selection: conversationSelectionSchema,
  metadata: z.record(z.string(), z.json()),
  agents: agentConfigurationSchema.optional(),
  delegation: z.object({ parentID: z.string().min(1), jobID: z.string().uuid() }).optional(),
  segments: z.array(segmentSchema),
  active: z.string().uuid().nullable(),
  cut: z.string().optional(),
  checkpoint: checkpointSchema.optional(),
  admission: z.object({
    segmentId: z.string(),
    messageId: z.string(),
    phase: z.enum(['preparing', 'dispatched']),
    rollback: rollbackSchema,
    rewindSource: z.string().optional(),
  }).optional(),
  deletion: z.array(z.string()).optional(),
});

export type ConversationSelection = z.infer<typeof conversationSelectionSchema>;
export type ConversationSendRecord = z.infer<typeof sendRecordSchema>;
export type ConversationSegment = z.infer<typeof segmentSchema>;
export type ConversationCheckpoint = z.infer<typeof checkpointSchema>;
export type ConversationRollback = z.infer<typeof rollbackSchema>;
export type ConversationManifest = z.infer<typeof manifestSchema>;
export type ConversationAdmission = NonNullable<ConversationManifest['admission']>;
export type ConversationManifestInput = z.input<typeof manifestSchema>;

export const buildRollback = (manifest: ConversationManifest): ConversationRollback => {
  const rollback: ConversationRollback = {
    segments: structuredClone(manifest.segments),
    active: manifest.active,
  };
  if (manifest.cut !== undefined) rollback.cut = manifest.cut;
  if (manifest.checkpoint !== undefined) rollback.checkpoint = manifest.checkpoint;
  return rollback;
};

export const restoreRollback = (current: ConversationManifest, rollback: ConversationRollback): void => {
  current.segments = rollback.segments;
  current.active = rollback.active;
  if (rollback.cut !== undefined) current.cut = rollback.cut;
  else delete current.cut;
  if (rollback.checkpoint !== undefined) current.checkpoint = rollback.checkpoint;
  else delete current.checkpoint;
};

export type ConversationCreateInput = Partial<Omit<ConversationManifestInput, 'directory' | 'selection'>> & {
  directory: string;
  selection: ConversationSelection;
};

export interface ConversationStoreOptions {
  directory: string;
  now?: (() => number) | undefined;
}

export interface ConversationStore {
  load: () => Promise<void>;
  get: (id: string) => ConversationManifest;
  peek: (id: string) => ConversationManifest | undefined;
  list: () => ConversationManifest[];
  unavailable: () => string[];
  retryUnavailable: () => Promise<ConversationManifest[]>;
  create: (input: ConversationCreateInput) => Promise<ConversationManifest>;
  update: (id: string, change: (current: ConversationManifest) => ConversationManifestInput) => Promise<ConversationManifest>;
  remove: (id: string) => Promise<void>;
  drain: () => Promise<void>;
}

const hasErrorCode = (value: unknown): value is { code?: unknown } => value !== null && typeof value === 'object';

const storageError = (): NativeAgentError => new NativeAgentError('The unified conversation could not be read. Reload and retry.', {
  status: 500, code: 'NATIVE_CONVERSATION_STORAGE_UNAVAILABLE',
});

export const createConversationStore = ({ directory, now = Date.now }: ConversationStoreOptions): ConversationStore => {
  const manifests = new Map<string, ConversationManifest>();
  const unavailable = new Set<string>();
  let loading: Promise<void> | undefined;
  let writes: Promise<void> = Promise.resolve();

  const load = (): Promise<void> => {
    loading ??= (async () => {
      let files: string[];
      try { files = await fs.readdir(directory); }
      catch (error) {
        if (hasErrorCode(error) && error.code === 'ENOENT') return;
        throw storageError();
      }
      for (const file of files) {
        if (!/^ncv_[0-9a-f-]{36}\.json$/.test(file)) continue;
        const id = file.slice(0, -5);
        try {
          const manifest = manifestSchema.parse(JSON.parse(await fs.readFile(path.join(directory, file), 'utf8')));
          if (manifest.id !== id) throw storageError();
          manifests.set(id, manifest);
        } catch { unavailable.add(id); }
      }
    })().catch((error) => { loading = undefined; throw error; });
    return loading;
  };

  const persist = async (manifest: ConversationManifest): Promise<void> => {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `${manifest.id}.json`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
    manifests.set(manifest.id, manifest);
  };

  const serialized = <Result>(work: () => Promise<Result>): Promise<Result> => {
    const run = writes.then(async () => { await load(); return work(); });
    writes = run.then(() => undefined, () => undefined);
    return run;
  };

  const get = (id: string): ConversationManifest => {
    if (unavailable.has(id)) throw storageError();
    const manifest = manifests.get(id);
    if (!manifest) throw sessionNotFoundError(id);
    return manifest;
  };

  return {
    load,
    get,
    peek: (id) => manifests.get(id),
    list: () => [...manifests.values()],
    unavailable: () => [...unavailable],
    async retryUnavailable() {
      await load();
      const recovered: ConversationManifest[] = [];
      for (const id of [...unavailable]) {
        try {
          const manifest = manifestSchema.parse(JSON.parse(await fs.readFile(path.join(directory, `${id}.json`), 'utf8')));
          if (manifest.id !== id || !unavailable.has(id)) continue;
          manifests.set(id, manifest);
          unavailable.delete(id);
          recovered.push(manifest);
        } catch (error) {
          if (hasErrorCode(error) && error.code === 'ENOENT') unavailable.delete(id);
        }
      }
      return recovered;
    },
    create(input) {
      return serialized(async () => {
        const timestamp = now();
        const manifest = manifestSchema.parse({
          version: 1,
          id: `ncv_${randomUUID()}`,
          title: 'New conversation',
          createdAt: timestamp,
          updatedAt: timestamp,
          revision: 0,
          historyRevision: 0,
          metadata: {},
          segments: [],
          active: null,
          ...input,
        });
        await persist(manifest);
        return manifest;
      });
    },
    update(id, change) {
      return serialized(async () => {
        const current = get(id);
        const next = manifestSchema.parse(change(structuredClone(current)));
        next.revision = current.revision + 1;
        next.updatedAt = now();
        await persist(next);
        return next;
      });
    },
    remove(id) {
      return serialized(async () => {
        get(id);
        await fs.unlink(path.join(directory, `${id}.json`));
        manifests.delete(id);
      });
    },
    drain: () => writes,
  };
};
