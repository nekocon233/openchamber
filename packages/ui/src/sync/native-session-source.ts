import { nativeBackendOfSession, nativeBackendOfSessionId } from '@/lib/native-agents/ids';
import { getDirectoryState } from './sync-refs';

/** Resolve the active CLI of a logical conversation from its authoritative record. */
export const nativeSessionBackend = (sessionId: string, directory: string) => (
  nativeBackendOfSessionId(sessionId)
    ?? nativeBackendOfSession(getDirectoryState(directory)?.session.find((session) => session.id === sessionId))
);
