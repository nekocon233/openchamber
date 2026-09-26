import type { FormRequest, Session, SessionStatus } from '@/lib/opencode/model';

import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { NativeAgentsUnsupportedError } from '@/lib/native-agents/errors';
import { isNativeSessionId } from '@/lib/native-agents/ids';
import { opencodeClient } from '@/lib/opencode/client';
import { projectNativeQuestion } from '@/lib/native-agents/forms';

// Directory snapshots of statuses and pending questions come from OpenCode,
// which has never heard of native CLI sessions; these readers add the native
// half. A native read that fails must not settle native sessions: treating a
// running native turn as idle because its status could not be read would mark
// it interrupted. The readers return `null` for a failed read, and callers
// either keep what they hold for native sessions or leave native sessions out
// of what the snapshot decides.

type StatusMap = Record<string, SessionStatus>;
type ReadOptions = { signal?: AbortSignal };

/** Statuses of the directory's native sessions: `{}` where this runtime has none, `null` when the read failed. */
export const readNativeStatuses = async (directory: string, options?: ReadOptions): Promise<StatusMap | null> => {
  const nativeAgents = getRegisteredRuntimeAPIs()?.nativeAgents;
  if (!nativeAgents?.supported) return {};
  try {
    return await nativeAgents.statuses(directory, options);
  } catch (error) {
    if (!options?.signal?.aborted) {
      console.warn('[native-sessions] failed to read native session statuses for', directory, error);
    }
    return null;
  }
};

/** Questions the directory's native sessions wait on: `[]` where this runtime has none, `null` when the read failed. */
export const readNativeForms = async (directory: string, options?: ReadOptions): Promise<FormRequest[] | null> => {
  const nativeAgents = getRegisteredRuntimeAPIs()?.nativeAgents;
  if (!nativeAgents?.supported) return [];
  try {
    const questions = await nativeAgents.questions(directory, options);
    return questions.flatMap((question) => {
      const form = projectNativeQuestion(question);
      return form ? [form] : [];
    });
  } catch (error) {
    if (!options?.signal?.aborted) {
      console.warn('[native-sessions] failed to read native session questions for', directory, error);
    }
    return null;
  }
};

/** The native sessions' entries of a held status map. */
export const heldNativeStatuses = (held: Readonly<StatusMap>): StatusMap => (
  Object.fromEntries(Object.entries(held).filter(([sessionId]) => isNativeSessionId(sessionId)))
);

/** The native sessions' questions of held question groups. */
export const heldNativeForms = (held: Readonly<Record<string, FormRequest[]>>): FormRequest[] => (
  Object.entries(held)
    .filter(([sessionId]) => isNativeSessionId(sessionId))
    .flatMap(([, questions]) => questions)
);

/**
 * A directory's statuses from every source, with the sessions they decide. A
 * session the snapshot does not cover belongs to a source that could not be
 * read: callers keep its state instead of reading its absence as idle.
 */
export type DirectoryStatusSnapshot = {
  statuses: StatusMap;
  covers: (sessionId: string) => boolean;
};

const coversEverySession = () => true;
const coversOpenCodeSessions = (sessionId: string) => !isNativeSessionId(sessionId);

// Same budget as OpenCode's status read: status snapshots gate reconnect and
// watchdog passes, which must not wait on the general read deadline.
const STATUS_READ_TIMEOUT_MS = 4_000;

/**
 * OpenCode's status snapshot merged with the native one. `null` when
 * OpenCode's read failed, which keeps every session as held.
 */
export const readDirectoryStatuses = async (
  directory: string,
  options?: ReadOptions,
): Promise<DirectoryStatusSnapshot | null> => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options?.signal?.aborted) abort();
  else options?.signal?.addEventListener('abort', abort, { once: true });
  const deadline = setTimeout(abort, STATUS_READ_TIMEOUT_MS);
  try {
    const [openCode, native] = await Promise.all([
      opencodeClient.getActiveSessionStatuses(directory, { signal: controller.signal }),
      readNativeStatuses(directory, { signal: controller.signal }),
    ]);
    if (openCode === null) return null;
    if (native === null) return { statuses: openCode, covers: coversOpenCodeSessions };
    return { statuses: { ...openCode, ...native }, covers: coversEverySession };
  } finally {
    clearTimeout(deadline);
    options?.signal?.removeEventListener('abort', abort);
  }
};

/**
 * A native session's record. OpenCode has never heard of these sessions, so
 * every read of one goes through the native API. Throws when it cannot be read.
 */
export const readNativeSession = async (sessionId: string, directory: string): Promise<Session> => {
  const nativeAgents = getRegisteredRuntimeAPIs()?.nativeAgents;
  if (!nativeAgents?.supported) throw new NativeAgentsUnsupportedError();
  return nativeAgents.getSession(sessionId, directory);
};
