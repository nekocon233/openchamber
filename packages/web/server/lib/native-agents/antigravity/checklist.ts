import { AGY_CHECKLIST_SERVER, AGY_CHECKLIST_TOOL, parseChecklistInput, checklistReceipt } from './checklist-protocol.mjs';
import type { AgyChecklistInput, AgyChecklistStatus } from './checklist-protocol.mjs';
import { NativeAgentError } from '../errors.js';
import type { JsonValue } from '../../shared/json-values.js';

export const AGY_CHECKLIST_PART_TOOL = `${AGY_CHECKLIST_SERVER}_${AGY_CHECKLIST_TOOL}`;

export interface AgyChecklistToolMetadata {
  nativeBackend?: JsonValue | undefined;
  openchamberToolSource?: JsonValue | undefined;
  nativeInputTruncated?: JsonValue | undefined;
}

export type AgyChecklistPart =
  | {
      type: 'tool';
      tool: string;
      callID: string;
      state:
        | { status: 'completed'; input?: JsonValue | undefined; output: string; metadata?: AgyChecklistToolMetadata | undefined }
        | { status: 'running' | 'error' };
    }
  | { type: 'text' | 'reasoning' | 'file' | 'compaction' };

export interface AgyChecklistRecord {
  parts: readonly AgyChecklistPart[];
}

export interface AgyChecklistSnapshotInput {
  sessionId: string;
  records: readonly AgyChecklistRecord[];
  complete?: boolean | undefined;
  observedAt: number;
}

export interface AgyChecklistItem {
  id: string;
  subject: string;
  status: AgyChecklistStatus;
  blocks: string[];
  blockedBy: string[];
}

export type AgyChecklistSnapshot =
  | { state: 'unavailable'; reason: 'source_unknown' }
  | {
      state: 'ready';
      identity: string;
      source: 'history';
      revision: number;
      observedAt: number;
      complete: boolean;
      unreadable: number;
      items: AgyChecklistItem[];
    };

export const antigravityChecklistSnapshot = ({
  sessionId,
  records,
  complete = true,
  observedAt,
}: AgyChecklistSnapshotInput): AgyChecklistSnapshot => {
  let latest: { input: AgyChecklistInput; revision: number } | null = null;
  let unreadable = 0;
  let latestUnrecorded = -1;
  for (const record of records) {
    for (const part of record.parts) {
      if (part.type !== 'tool' || part.tool !== AGY_CHECKLIST_PART_TOOL || part.state.status !== 'completed'
        || part.state.metadata?.nativeBackend !== 'antigravity' || part.state.metadata?.openchamberToolSource !== 'mcp') continue;
      const step = /_(\d+)$/.exec(part.callID);
      const stepNumber = step?.[1];
      if (stepNumber === undefined) continue;
      const revision = Number(stepNumber) + 1;
      const input = !part.state.metadata?.nativeInputTruncated ? parseChecklistInput(part.state.input) : null;
      const receipt = input ? checklistReceipt(input) : null;
      if (!input || !receipt || !part.state.output.split(/\r?\n/).some((line) => line === receipt)) {
        latestUnrecorded = Math.max(latestUnrecorded, revision);
        continue;
      }
      if (!latest || latest.revision < revision) latest = { input, revision };
    }
  }
  if (!latest) {
    if (!complete || latestUnrecorded >= 0) {
      throw new NativeAgentError('Antigravity checklist history is incomplete. Reload and retry.', {
        status: 502,
        code: 'NATIVE_ANTIGRAVITY_CHECKLIST_INCOMPLETE',
      });
    }
    return { state: 'unavailable', reason: 'source_unknown' };
  }
  if (!complete || latestUnrecorded > latest.revision) unreadable = 1;
  return {
    state: 'ready',
    identity: `antigravity:${sessionId}`,
    source: 'history',
    revision: latest.revision,
    observedAt,
    complete: unreadable === 0,
    unreadable,
    items: latest.input.todos.map((todo) => ({
      id: todo.id,
      subject: todo.content,
      status: todo.status,
      blocks: [],
      blockedBy: [],
    })),
  };
};
