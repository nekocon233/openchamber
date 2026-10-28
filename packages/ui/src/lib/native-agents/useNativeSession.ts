import { useCallback } from 'react';
import type { Session } from '@/lib/opencode/model';
import { useSessionSelector } from '@/sync/sync-context';
import { nativeBackendOfSession, nativeBackendOfSessionId, unifiedNativeSessionState } from './ids';

const selectBackend = (session: Session | undefined) => nativeBackendOfSession(session);

/** Native task controls follow the executing source, not the next selected model. */
export const useNativeSessionBackend = (sessionId: string | null, directory?: string | null) => (
  useSessionSelector(sessionId, directory ?? undefined, selectBackend)
    ?? (sessionId ? nativeBackendOfSessionId(sessionId) : null)
);

type UnifiedState = ReturnType<typeof unifiedNativeSessionState>;
const equalState = (left: UnifiedState, right: UnifiedState): boolean => left === right || Boolean(left && right
  && left.backend === right.backend && left.revision === right.revision && left.historyRevision === right.historyRevision
  && left.recordRevision === right.recordRevision
  && left.sourceSessionID === right.sourceSessionID && left.switchReady === right.switchReady && left.preparing === right.preparing);

export const useUnifiedNativeState = (sessionId: string | null, directory?: string | null): UnifiedState => {
  const select = useCallback((session: Session | undefined) => unifiedNativeSessionState(session?.metadata), []);
  return useSessionSelector(sessionId, directory ?? undefined, select, equalState);
};
