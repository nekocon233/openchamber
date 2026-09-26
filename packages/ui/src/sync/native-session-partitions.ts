import type { Session } from '@/lib/opencode/model';

import type { NativeAgentsAPI, NativeSessionList } from '@/lib/api/types';
import { isNativeSessionId, nativeBackendOfSessionId, type NativeBackend } from '@/lib/native-agents/ids';
import { normalizePath } from '@/lib/pathNormalization';

// Native CLI sessions come from their own backends, next to OpenCode's list.
// Each (directory, backend) pair is a partition with its own completeness: a
// backend that fails keeps the sessions it had, and never blocks or erases
// OpenCode sessions or the other backend. Subagent sessions are not listed by
// the backends (they arrive with their parent's history), so they are kept
// until their parent goes away.

const BACKENDS: NativeBackend[] = ['claude', 'codex'];
const NATIVE_LIST_CONCURRENCY = 4;

/** Fresh root sessions per backend; null marks a backend that could not be read. */
export type NativePartitionSnapshot = { claude: Session[] | null; codex: Session[] | null };

const snapshotOf = (list: NativeSessionList): NativePartitionSnapshot => ({
  claude: list.backends.claude.status === 'ok' ? list.backends.claude.sessions : null,
  codex: list.backends.codex.status === 'ok' ? list.backends.codex.sessions : null,
});

const FAILED_SNAPSHOT: NativePartitionSnapshot = { claude: null, codex: null };

/** Reads one directory; a request failure fails every backend of it. */
export const fetchNativePartition = async (api: NativeAgentsAPI, directory: string): Promise<NativePartitionSnapshot> => {
  try {
    return snapshotOf(await api.listSessions(directory));
  } catch (error) {
    console.warn('[native-sessions] failed to list native sessions for', directory, error);
    return FAILED_SNAPSHOT;
  }
};

/** Reads several directories with bounded concurrency. */
export const fetchNativePartitions = async (
  api: NativeAgentsAPI,
  directories: Iterable<string>,
): Promise<Map<string, NativePartitionSnapshot>> => {
  const pending = Array.from(new Set(Array.from(directories, (directory) => normalizePath(directory) ?? '').filter((directory) => directory !== '')));
  const results = new Map<string, NativePartitionSnapshot>();
  const worker = async () => {
    for (let directory = pending.shift(); directory !== undefined; directory = pending.shift()) {
      results.set(directory, await fetchNativePartition(api, directory));
    }
  };
  await Promise.all(Array.from({ length: Math.min(NATIVE_LIST_CONCURRENCY, pending.length) }, worker));
  return results;
};

const directoryOf = (session: Session) => normalizePath(session.directory) ?? '';

/**
 * The native sessions to hold after reading `partitions`: fresh roots of the
 * backends that answered, the previous sessions of the backends that did not,
 * native sessions of directories that were not read, and subagent sessions
 * whose parent is still held.
 */
export const resolveNativeSessions = (
  existing: readonly Session[],
  partitions: ReadonlyMap<string, NativePartitionSnapshot>,
): Session[] => {
  const byId = new Map<string, Session>();
  for (const session of existing) {
    if (!isNativeSessionId(session.id) || session.parentID) continue;
    const backend = nativeBackendOfSessionId(session.id);
    const partition = partitions.get(directoryOf(session));
    if (!backend || (partition && partition[backend] !== null)) continue;
    byId.set(session.id, session);
  }
  for (const partition of partitions.values()) {
    for (const backend of BACKENDS) {
      for (const session of partition[backend] ?? []) byId.set(session.id, session);
    }
  }
  // Subagents can nest, so keep adding children until no parent is new.
  const children = existing.filter((session) => isNativeSessionId(session.id) && session.parentID);
  for (let added = true; added;) {
    added = false;
    for (const session of children) {
      if (byId.has(session.id) || !session.parentID || !byId.has(session.parentID)) continue;
      byId.set(session.id, session);
      added = true;
    }
  }
  return Array.from(byId.values());
};
