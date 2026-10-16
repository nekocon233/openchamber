import React from 'react';
import { getLastConversationMessage, isIncompleteAssistantTurn, type Message } from '@/lib/opencode/model';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionStatus, useSessionMessagesSelector, useSessionPermissions, useSessionForms } from '@/sync/sync-context';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { normalizeProjectPath } from '@/lib/projectResolution';
import { deriveSessionActivity, IDLE_SESSION_ACTIVITY } from './sessionActivity';
import type { SessionActivityResult } from './sessionActivity';

// Only the trailing turn matters, so the subscription re-renders the caller
// when that flag flips rather than on every streamed message update.
// Plumbing roles are transparent here: a synthetic or switch message landing
// after the streaming assistant must not read as the turn ending.
const selectHasPendingAssistant = (messages: Message[]): boolean => (
  isIncompleteAssistantTurn(getLastConversationMessage(messages))
);

const IDLE_RESULT: SessionActivityResult = IDLE_SESSION_ACTIVITY;

/**
 * Determines if a session is actively working.
 * Checks session_status and, only when no authoritative status snapshot exists,
 * falls back to the trailing assistant message when its completion update has
 * not landed yet. Returns idle when permissions or forms are pending (the
 * permission / form indicator takes priority, and the send button must stay
 * available so the user can supersede the prompt with a new message).
 */
export function useSessionActivity(sessionId: string | null | undefined, directory?: string): SessionActivityResult {
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
  const hasPendingAssistant = useSessionMessagesSelector(sessionId ?? '', directory, selectHasPendingAssistant);
  const permissions = useSessionPermissions(sessionId ?? '', directory);
  const forms = useSessionForms(sessionId ?? '', directory);

  return React.useMemo<SessionActivityResult>(() => {
    if (!sessionId) return IDLE_RESULT;
    return deriveSessionActivity({
      childStatus: status,
      globalResolvedStatus,
      hasAuthoritativeStatusSnapshot,
      hasPendingAssistant,
      pendingPermissions: permissions.length,
      pendingQuestions: forms.length,
    });
  }, [sessionId, status, globalResolvedStatus, hasAuthoritativeStatusSnapshot, hasPendingAssistant, permissions, forms]);
}

export function useCurrentSessionActivity(): SessionActivityResult {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
  return useSessionActivity(currentSessionId, currentSessionDirectory ?? undefined);
}
