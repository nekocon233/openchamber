import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

import { NativeAgentError } from '../errors.js';
import { buildSessionRecord, unconfirmedSessionRecord } from '../records.js';
import { parseAgyTranscript } from './protocol.js';
import { projectAntigravityHistory, resolveAntigravityBindings } from './projector.js';

const SELECT_ROOTS = `select conversation_id, title, preview, last_modified_time, workspace_uris
from conversation_summaries where parent_conversation_id = '' order by last_modified_time desc`;
const SELECT_ONE = `select conversation_id, title, preview, last_modified_time, workspace_uris
from conversation_summaries where conversation_id = ? and parent_conversation_id = '' limit 1`;

const summaryRow = z.object({
  conversation_id: z.string().uuid(),
  title: z.string().nullable(),
  preview: z.string().nullable(),
  last_modified_time: z.string(),
  workspace_uris: z.string(),
});

const unavailable = (message) => new NativeAgentError(message, {
  code: 'NATIVE_ANTIGRAVITY_HISTORY_UNAVAILABLE',
  status: 502,
});

const normalizedDirectory = (value) => {
  const resolved = path.resolve(value);
  return resolved.length > 1 && resolved.endsWith(path.sep) ? resolved.slice(0, -1) : resolved;
};

const workspaceDirectory = (value) => {
  try {
    const uris = JSON.parse(value);
    if (!Array.isArray(uris) || typeof uris[0] !== 'string') return null;
    return normalizedDirectory(fileURLToPath(uris[0]));
  } catch {
    return null;
  }
};

const modifiedTime = (row) => {
  const parsed = Date.parse(row.last_modified_time.trim().replace(' ', 'T'));
  return Number.isNaN(parsed) ? null : parsed;
};

/** Read-only access to agy's own index and transcripts. */
export const createAntigravityStore = ({ registry, home = null, now = Date.now }) => {
  const root = home ?? path.join(os.homedir(), '.gemini', 'antigravity-cli');
  const summaries = path.join(root, 'conversation_summaries.db');
  const transcriptPath = (nativeId) => path.join(
    root, 'brain', nativeId, '.system_generated', 'logs', 'transcript.jsonl',
  );
  const registered = async (directory) => new Map(
    (await registry.listSessions({ backend: 'antigravity', directory }))
      .map((entry) => [entry.nativeId, entry]),
  );
  const open = () => new DatabaseSync(summaries, { readOnly: true });
  const hasSummaries = () => fs.existsSync(summaries);
  const hasTranscript = (nativeId) => fs.existsSync(transcriptPath(nativeId));

  const recordOf = (row, entry) => {
    const modified = modifiedTime(row) ?? entry?.confirmedAt ?? entry?.createdAt ?? now();
    const directory = workspaceDirectory(row.workspace_uris) ?? entry?.directory;
    if (!directory) throw unavailable(`Antigravity conversation ${row.conversation_id} has no readable workspace`);
    const title = entry?.title || row.title?.trim() || row.preview?.trim() || 'Antigravity session';
    return buildSessionRecord({
      id: entry?.sessionId ?? `nag_${row.conversation_id}`,
      backend: 'antigravity', directory, title,
      created: entry?.createdAt ?? modified,
      updated: modified,
      archived: entry?.archivedAt ?? null,
    });
  };

  const one = async (sessionId, nativeId, directory) => {
    const entry = (await registry.getSession(sessionId))
      ?? (await registry.listSessions({ backend: 'antigravity', directory }))
        .find((candidate) => candidate.nativeId === nativeId) ?? null;
    if (!hasSummaries()) {
      if (entry?.origin === 'openchamber' && entry.confirmedAt === undefined) {
        return unconfirmedSessionRecord({ sessionId, ...entry });
      }
      return null;
    }
    let db;
    try {
      db = open();
      const raw = db.prepare(SELECT_ONE).get(nativeId);
      db.close();
      db = null;
      if (!raw) {
        if (entry?.origin === 'openchamber' && entry.confirmedAt === undefined) {
          return unconfirmedSessionRecord({ sessionId, ...entry });
        }
        return null;
      }
      const row = summaryRow.parse(raw);
      const record = recordOf(row, entry ? { ...entry, sessionId } : null);
      if (normalizedDirectory(record.directory) !== normalizedDirectory(directory)) return null;
      return record;
    } catch (error) {
      if (db) db.close();
      if (error instanceof NativeAgentError) throw error;
      throw unavailable(`Could not read Antigravity conversation ${nativeId}: ${error instanceof Error ? error.message : error}`);
    }
  };

  const readTranscript = (nativeId) => {
    try {
      return parseAgyTranscript(fs.readFileSync(transcriptPath(nativeId), 'utf8'));
    } catch (error) {
      throw unavailable(`Could not read Antigravity transcript ${nativeId}: ${error instanceof Error ? error.message : error}`);
    }
  };

  return {
    transcriptPath,

    hasTranscript,

    async listRootSessions(directory) {
      const entries = await registered(directory);
      const unconfirmed = [...entries.values()].filter((entry) => (
        entry.origin === 'openchamber' && entry.confirmedAt === undefined
      ));
      if (!hasSummaries()) {
        const confirmed = [...entries.values()].some((entry) => entry.confirmedAt !== undefined);
        if (confirmed) throw unavailable('The Antigravity conversation index is missing');
        return unconfirmed.map((entry) => unconfirmedSessionRecord({ ...entry }));
      }
      let rows;
      let db;
      try {
        db = open();
        rows = db.prepare(SELECT_ROOTS).all();
        db.close();
        db = null;
      } catch (error) {
        if (db) db.close();
        throw unavailable(`Could not list Antigravity conversations: ${error instanceof Error ? error.message : error}`);
      }
      const records = [];
      const seen = new Set();
      for (const raw of rows) {
        const parsed = summaryRow.safeParse(raw);
        if (!parsed.success) continue;
        const entry = entries.get(parsed.data.conversation_id);
        let record;
        try {
          record = recordOf(parsed.data, entry);
        } catch {
          continue;
        }
        if (normalizedDirectory(record.directory) !== normalizedDirectory(directory)) continue;
        records.push(record);
        seen.add(parsed.data.conversation_id);
      }
      for (const entry of unconfirmed) {
        if (!seen.has(entry.nativeId)) records.push(unconfirmedSessionRecord({ ...entry }));
      }
      return records;
    },

    getSession: one,

    async sessionExists(sessionId, nativeId, directory) {
      return (await one(sessionId, nativeId, directory)) !== null;
    },

    async loadHistory(sessionId, nativeId, directory) {
      const session = await one(sessionId, nativeId, directory);
      if (!session) return null;
      const entry = await registry.getSession(sessionId);
      if (!hasTranscript(nativeId)) {
        if (entry?.origin === 'openchamber' && entry.confirmedAt === undefined) {
          return { records: [], childSessions: [] };
        }
        throw unavailable(`Antigravity transcript is missing: ${nativeId}`);
      }
      const transcript = readTranscript(nativeId);
      const { bindings } = await resolveAntigravityBindings({
        sessionId, entries: transcript.entries, registry,
      });
      const records = projectAntigravityHistory({
        sessionId, nativeId, directory: session.directory,
        entries: transcript.entries, bindings, now,
      });
      return {
        records,
        childSessions: [],
        ...(transcript.malformed > 0 || transcript.unknownTypes.length > 0 ? { metadataComplete: false } : {}),
      };
    },

    /** Used only to distinguish a final response from agy's sticky stream error. */
    async hasCompleteTurn(nativeId, userStepIndex) {
      if (!hasTranscript(nativeId)) return false;
      const transcript = readTranscript(nativeId);
      const current = transcript.entries.filter((entry) => (
        entry.step_index >= userStepIndex && entry.type !== 'EPHEMERAL_MESSAGE'
      ));
      const last = current.at(-1);
      return last?.type === 'PLANNER_RESPONSE'
        && last.status === 'DONE'
        && (last.content ?? '').trim() !== ''
        && last.tool_calls.length === 0;
    },
  };
};
