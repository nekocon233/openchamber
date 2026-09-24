// OpenChamber's own record of native CLI sessions. The CLIs own the sessions;
// this registry only holds what they cannot tell us:
// - which sessions OpenChamber created or resumed (Claude lists SDK-created
//   sessions only on request, and Codex records every app-server client as
//   the same source), so they stay listed next to terminal sessions;
// - whether the CLI has confirmed a session OpenChamber created by finishing
//   a turn in it: until then the CLI may have no transcript for it;
// - an archive flag for Claude, which has no archive of its own;
// - the model, effort and agent each OpenChamber prompt was sent with;
// - the work-tree snapshots taken around each OpenChamber turn, and a revert
//   waiting for the CLI to rewind the conversation.
//
// Persistence rules: a missing file is an empty registry; an unparseable file
// is moved aside and the registry starts empty (reported through `status()`);
// a read failure is thrown so callers never mistake it for "no sessions".
// Writes are serialized and atomic, and memory changes only after the write
// succeeded.

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const MAX_SENDS_PER_SESSION = 200;
const MAX_TURNS_PER_SESSION = 200;

// OpenChamber's own session metadata (btw and review links, goals, the
// assist, pins): what OpenCode keeps in its session metadata, which a native
// session does not have.
const metadataSchema = z.record(z.string(), z.unknown());

const sessionEntrySchema = z.object({
  backend: z.enum(['claude', 'codex']),
  nativeId: z.string().min(1),
  directory: z.string().min(1),
  origin: z.enum(['openchamber', 'adopted']),
  createdAt: z.number(),
  confirmedAt: z.number().optional(),
  archivedAt: z.number().optional(),
  title: z.string().optional(),
  // Malformed metadata is dropped; it never costs the session its entry.
  metadata: metadataSchema.optional().catch(undefined),
});

const sendRecordSchema = z.object({
  messageId: z.string().min(1),
  providerID: z.string().min(1),
  modelID: z.string(),
  variant: z.string().optional(),
  agent: z.string().min(1),
  sentAt: z.number(),
});

// The work tree before an OpenChamber prompt, and after the turn that answered it.
const turnSnapshotSchema = z.object({
  messageId: z.string().min(1),
  root: z.string().min(1),
  before: z.string().min(1),
  after: z.string().min(1).optional(),
});

// A revert of `messageId` and the user messages after it (`messageIds`).
// While `pending`, `preRevert` and `files` undo it. The next prompt commits
// it, rewinding the conversation at `resumeAt` (Claude chain entry) or
// `beforeTurnId` (Codex turn); a Claude revert stays `committed` until the
// transcript no longer holds `messageId`.
const pendingRevertSchema = z.object({
  messageId: z.string().min(1),
  messageIds: z.array(z.string().min(1)),
  phase: z.enum(['pending', 'committed']),
  root: z.string().min(1).optional(),
  preRevert: z.string().min(1).optional(),
  files: z.array(z.string()),
  resumeAt: z.string().min(1).optional(),
  beforeTurnId: z.string().min(1).optional(),
});

const registryFileSchema = z.object({
  version: z.literal(1),
  sessions: z.record(z.string(), z.unknown()).catch({}),
  sends: z.record(z.string(), z.array(z.unknown())).catch({}),
  turns: z.record(z.string(), z.array(z.unknown())).catch({}),
  reverts: z.record(z.string(), z.unknown()).catch({}),
});

const emptyState = () => ({ sessions: new Map(), sends: new Map(), turns: new Map(), reverts: new Map() });

const cloneState = (state) => ({
  sessions: new Map(state.sessions),
  sends: new Map(Array.from(state.sends, ([sessionId, records]) => [sessionId, [...records]])),
  turns: new Map(Array.from(state.turns, ([sessionId, records]) => [sessionId, [...records]])),
  reverts: new Map(state.reverts),
});

const serialize = (state) => JSON.stringify({
  version: 1,
  sessions: Object.fromEntries(state.sessions),
  sends: Object.fromEntries(state.sends),
  turns: Object.fromEntries(state.turns),
  reverts: Object.fromEntries(state.reverts),
}, null, 2);

const validEntries = (values, schema) => values
  .map((value) => schema.safeParse(value))
  .filter((result) => result.success)
  .map((result) => result.data);

const errorCode = z.object({ code: z.string() }).passthrough();

/**
 * @param {object} options
 * @param {string} options.filePath
 * @param {() => number} [options.now]
 */
export const createNativeRegistry = ({ filePath, now = Date.now }) => {
  let state = null;
  let loadPromise = null;
  let writeChain = Promise.resolve();
  let resetAt = null;

  const readState = async () => {
    let raw;
    try {
      raw = await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
      if (errorCode.safeParse(error).data?.code === 'ENOENT') return emptyState();
      throw error;
    }
    let parsed;
    try {
      parsed = registryFileSchema.parse(JSON.parse(raw));
    } catch (error) {
      const backup = `${filePath}.corrupt-${now()}`;
      await fs.promises.rename(filePath, backup).catch(() => undefined);
      console.warn(`[native-agents] registry was unreadable and moved to ${backup}: ${error instanceof Error ? error.message : error}`);
      resetAt = now();
      return emptyState();
    }
    const next = emptyState();
    for (const [sessionId, value] of Object.entries(parsed.sessions)) {
      const entry = sessionEntrySchema.safeParse(value);
      if (entry.success) next.sessions.set(sessionId, entry.data);
    }
    for (const [sessionId, values] of Object.entries(parsed.sends)) {
      const records = validEntries(values, sendRecordSchema);
      if (records.length > 0) next.sends.set(sessionId, records.slice(-MAX_SENDS_PER_SESSION));
    }
    for (const [sessionId, values] of Object.entries(parsed.turns)) {
      const records = validEntries(values, turnSnapshotSchema);
      if (records.length > 0) next.turns.set(sessionId, records.slice(-MAX_TURNS_PER_SESSION));
    }
    for (const [sessionId, value] of Object.entries(parsed.reverts)) {
      const revert = pendingRevertSchema.safeParse(value);
      if (revert.success) next.reverts.set(sessionId, revert.data);
    }
    return next;
  };

  const load = () => {
    if (!loadPromise) {
      loadPromise = readState().then((loaded) => {
        state = loaded;
        return state;
      }, (error) => {
        loadPromise = null;
        throw error;
      });
    }
    return loadPromise;
  };

  const writeState = async (next) => {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmpPath, serialize(next), 'utf8');
    await fs.promises.rename(tmpPath, filePath);
  };

  /** Applies `update` to a copy, persists it, then makes it current. */
  const mutate = (update) => {
    const run = writeChain.then(async () => {
      await load();
      const next = cloneState(state);
      const result = update(next);
      await writeState(next);
      state = next;
      return result;
    });
    writeChain = run.catch(() => undefined);
    return run;
  };

  return {
    load,

    /** Reports a registry that had to be reset because its file was unreadable. */
    status() {
      return resetAt === null ? { reset: false } : { reset: true, resetAt };
    },

    async getSession(sessionId) {
      await load();
      return state.sessions.get(sessionId) ?? null;
    },

    /** @param {{ backend?: 'claude' | 'codex', directory?: string }} [filter] */
    async listSessions(filter = {}) {
      await load();
      return Array.from(state.sessions, ([sessionId, entry]) => ({ sessionId, ...entry }))
        .filter((entry) => filter.backend === undefined || entry.backend === filter.backend)
        .filter((entry) => filter.directory === undefined || entry.directory === filter.directory);
    },

    /**
     * Sessions OpenChamber created that no finished turn has confirmed yet.
     * The CLI may have no transcript for them, so they exist here alone.
     * @param {{ backend?: 'claude' | 'codex', directory?: string, sessionId?: string }} [filter]
     */
    async unconfirmedSessions(filter = {}) {
      await load();
      return Array.from(state.sessions, ([sessionId, entry]) => ({ sessionId, ...entry }))
        .filter((entry) => entry.origin === 'openchamber' && entry.confirmedAt === undefined)
        .filter((entry) => filter.sessionId === undefined || entry.sessionId === filter.sessionId)
        .filter((entry) => filter.backend === undefined || entry.backend === filter.backend)
        .filter((entry) => filter.directory === undefined || entry.directory === filter.directory);
    },

    /** Registers a session unless it is already known; returns its entry. */
    registerSession(sessionId, entry) {
      const parsed = sessionEntrySchema.parse(entry);
      return mutate((next) => {
        const existing = next.sessions.get(sessionId);
        if (existing) return existing;
        next.sessions.set(sessionId, parsed);
        return parsed;
      });
    },

    /** Records that the CLI finished a turn in the session; later calls keep the first time. */
    confirmSession(sessionId) {
      return mutate((next) => {
        const existing = next.sessions.get(sessionId);
        if (!existing || existing.confirmedAt !== undefined) return existing ?? null;
        const confirmed = { ...existing, confirmedAt: now() };
        next.sessions.set(sessionId, confirmed);
        return confirmed;
      });
    },

    /** @param {{ archivedAt?: number | null, title?: string, metadata?: Record<string, unknown> | null }} patch */
    updateSession(sessionId, patch) {
      return mutate((next) => {
        const existing = next.sessions.get(sessionId);
        if (!existing) return null;
        const updated = { ...existing };
        if (patch.archivedAt === null) delete updated.archivedAt;
        else if (patch.archivedAt !== undefined) updated.archivedAt = patch.archivedAt;
        if (patch.title !== undefined) updated.title = patch.title;
        if (patch.metadata === null) delete updated.metadata;
        else if (patch.metadata !== undefined) updated.metadata = patch.metadata;
        next.sessions.set(sessionId, sessionEntrySchema.parse(updated));
        return next.sessions.get(sessionId);
      });
    },

    removeSession(sessionId) {
      return mutate((next) => {
        next.sessions.delete(sessionId);
        next.sends.delete(sessionId);
        next.turns.delete(sessionId);
        next.reverts.delete(sessionId);
      });
    },

    /** Records the work tree before an OpenChamber prompt's turn. */
    recordTurnStart(sessionId, snapshot) {
      const parsed = turnSnapshotSchema.parse(snapshot);
      return mutate((next) => {
        const records = (next.turns.get(sessionId) ?? []).filter((existing) => existing.messageId !== parsed.messageId);
        records.push(parsed);
        next.turns.set(sessionId, records.slice(-MAX_TURNS_PER_SESSION));
      });
    },

    /** Records the work tree after a turn, for every prompt that turn answered. */
    recordTurnEnd(sessionId, after) {
      return mutate((next) => {
        const records = next.turns.get(sessionId);
        if (!records?.some((record) => record.after === undefined)) return;
        next.turns.set(sessionId, records.map((record) => (record.after === undefined ? { ...record, after } : record)));
      });
    },

    async turnSnapshots(sessionId) {
      await load();
      return [...(state.turns.get(sessionId) ?? [])];
    },

    /** Forgets the snapshots of prompts a committed revert removed. */
    dropTurns(sessionId, messageIds) {
      const dropped = new Set(messageIds);
      return mutate((next) => {
        const records = next.turns.get(sessionId);
        if (records) next.turns.set(sessionId, records.filter((record) => !dropped.has(record.messageId)));
      });
    },

    async pendingRevert(sessionId) {
      await load();
      return state.reverts.get(sessionId) ?? null;
    },

    /** @param {z.infer<typeof pendingRevertSchema> | null} revert */
    setPendingRevert(sessionId, revert) {
      const parsed = revert === null ? null : pendingRevertSchema.parse(revert);
      return mutate((next) => {
        if (parsed === null) next.reverts.delete(sessionId);
        else next.reverts.set(sessionId, parsed);
      });
    },

    recordSend(sessionId, record) {
      const parsed = sendRecordSchema.parse(record);
      return mutate((next) => {
        const records = (next.sends.get(sessionId) ?? []).filter((existing) => existing.messageId !== parsed.messageId);
        records.push(parsed);
        next.sends.set(sessionId, records.slice(-MAX_SENDS_PER_SESSION));
      });
    },

    /**
     * Send records of a session keyed by message id, for projections.
     * @returns {Promise<Map<string, { modelID: string, variant?: string, agent: string }>>}
     */
    async sendRecords(sessionId) {
      await load();
      return new Map((state.sends.get(sessionId) ?? []).map((record) => [record.messageId, record]));
    },
  };
};
