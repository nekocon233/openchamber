import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { NativeAgentError, sessionNotFoundError } from '../errors.js';

const conversationId = z.string().regex(/^ncv_[0-9a-f-]{36}$/);
const backend = z.enum(['claude', 'codex', 'deepseek']);
export const conversationSelectionSchema = z.object({
  model: z.object({ providerID: z.enum(['claude-native', 'codex-native', 'deepseek-native']), modelID: z.string().min(1) }),
  variant: z.string().min(1).optional(),
  agent: z.enum(['build', 'plan']),
}).strict();

const segmentSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().regex(/^(?:nc[lx]|ndh)_/),
  ownerId: conversationId,
  backend,
  createdAt: z.number(),
  timeOffset: z.number().optional(),
  through: z.string().optional(),
  before: z.string().optional(),
  sends: z.array(z.object({
    messageId: z.string().min(1),
    nativeMessageId: z.string().min(1),
    createdAt: z.number(),
    state: z.enum(['pending', 'accepted']),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    selection: conversationSelectionSchema,
  })),
});

const checkpointSchema = z.object({ through: z.string(), revision: z.number(), text: z.string() });
const rollbackSchema = z.object({
  segments: z.array(segmentSchema), active: z.string().nullable(), cut: z.string().optional(), checkpoint: checkpointSchema.optional(),
});

const manifestSchema = z.object({
  version: z.literal(1),
  id: conversationId,
  directory: z.string().min(1),
  title: z.string().min(1),
  manualTitle: z.boolean().default(false),
  parentID: conversationId.optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  archivedAt: z.number().optional(),
  revision: z.number().int().nonnegative(),
  selectionRevision: z.number().int().nonnegative().default(0),
  historyRevision: z.number().int().nonnegative(),
  selection: conversationSelectionSchema,
  metadata: z.record(z.string(), z.json()),
  segments: z.array(segmentSchema),
  active: z.string().uuid().nullable(),
  cut: z.string().optional(),
  checkpoint: checkpointSchema.optional(),
  admission: z.object({
    segmentId: z.string(), messageId: z.string(), phase: z.enum(['preparing', 'dispatched']), rollback: rollbackSchema,
  }).optional(),
  deletion: z.array(z.string()).optional(),
});

/** @typedef {z.infer<typeof manifestSchema>} ConversationManifest */
/** @typedef {z.infer<typeof segmentSchema>} ConversationSegment */

const storageError = () => new NativeAgentError('The unified conversation could not be read. Reload and retry.', {
  status: 500, code: 'NATIVE_CONVERSATION_STORAGE_UNAVAILABLE',
});

/** Conversation manifests contain references and derived checkpoints, never transcript copies. */
export const createConversationStore = ({ directory, now = Date.now }) => {
  /** @type {Map<string, ConversationManifest>} */
  const manifests = new Map();
  const unavailable = new Set();
  let loading;
  let writes = Promise.resolve();

  const load = () => {
    loading ??= (async () => {
      let files;
      try { files = await fs.readdir(directory); }
      catch (error) {
        if (error.code === 'ENOENT') return;
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

  const persist = async (manifest) => {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `${manifest.id}.json`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
    manifests.set(manifest.id, manifest);
  };

  const serialized = (work) => {
    const run = writes.then(async () => { await load(); return work(); });
    writes = run.then(() => undefined, () => undefined);
    return run;
  };

  const get = (id) => {
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
      const recovered = [];
      for (const id of [...unavailable]) {
        try {
          const manifest = manifestSchema.parse(JSON.parse(await fs.readFile(path.join(directory, `${id}.json`), 'utf8')));
          if (manifest.id !== id || !unavailable.has(id)) continue;
          manifests.set(id, manifest);
          unavailable.delete(id);
          recovered.push(manifest);
        } catch (error) {
          if (error.code === 'ENOENT') unavailable.delete(id);
        }
      }
      return recovered;
    },
    create(input) {
      return serialized(async () => {
        const timestamp = now();
        const manifest = manifestSchema.parse({
          version: 1, id: `ncv_${randomUUID()}`, title: 'New conversation',
          createdAt: timestamp, updatedAt: timestamp, revision: 0, historyRevision: 0,
          metadata: {}, segments: [], active: null, ...input,
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
