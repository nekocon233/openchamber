import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionStatus, useSessionMessages, useSessionPermissions, useSessionQuestions } from '@/sync/sync-context';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { normalizeProjectPath } from '@/lib/projectResolution';
import {
  deriveSessionActivity,
  IDLE_SESSION_ACTIVITY,
  type SessionActivityPhase,
  type SessionActivityResult,
} from './sessionActivity';

const IDLE_RESULT: SessionActivityResult = IDLE_SESSION_ACTIVITY;

/**
 * Determines if a session is actively working.
 * Checks session_status and, only when no authoritative status snapshot exists,
 * falls back to the trailing assistant message when its completion update has
 * not landed yet. Returns idle when permissions or questions are pending (the
 * permission / question indicator takes priority, and the send button must stay
 * available so the user can supersede the prompt with a new message).
 */
function useSessionActivity(sessionId: string | null | undefined, directory?: string): SessionActivityResult {
  const status = useSessionStatus(sessionId ?? '', directory);
  const globalResolvedStatus = useGlobalSessionStatusStore(
    React.useCallback((state) => sessionId ? state.resolvedStatusById.get(sessionId) : undefined, [sessionId]),
  );
  const hasAuthoritativeStatusSnapshot = useGlobalSessionStatusStore(
    React.useCallback((state) => {
      if (!directory) return false;
      return state.statusSnapshotAtByDirectory.has(normalizeProjectPath(directory) ?? directory);
    }, [directory]),
  );
  const messages = useSessionMessages(sessionId ?? '', directory);
  const permissions = useSessionPermissions(sessionId ?? '', directory);
  const questions = useSessionQuestions(sessionId ?? '', directory);

  return React.useMemo<SessionActivityResult>(() => {
    if (!sessionId) return IDLE_RESULT;
    return deriveSessionActivity({
      childStatus: status,
      globalResolvedStatus: globalResolvedStatus as SessionActivityPhase | undefined,
      hasAuthoritativeStatusSnapshot,
      messages,
      pendingPermissions: permissions.length,
      pendingQuestions: questions.length,
    });
  }, [sessionId, status, globalResolvedStatus, hasAuthoritativeStatusSnapshot, messages, permissions, questions]);
}

export function useCurrentSessionActivity(): SessionActivityResult {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
  return useSessionActivity(currentSessionId, currentSessionDirectory ?? undefined);
}
