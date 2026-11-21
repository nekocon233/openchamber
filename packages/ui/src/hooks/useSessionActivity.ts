import React from 'react';
import { getLastConversationMessage, isIncompleteAssistantTurn, type Message } from '@/lib/opencode/model';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { formTurnHold, useRecoverableQuestionsStore } from '@/sync/recoverable-questions';
import { readUnloadedFormToolLinks } from '@/sync/session-actions';
import { useDirectorySync, useSessionStatus, useSessionStatusSnapshotReady, useSessionMessagesSelector, useSessionPermissions } from '@/sync/sync-context';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { normalizeProjectPath } from '@/lib/projectResolution';
import { deriveSessionActivity, IDLE_SESSION_ACTIVITY } from './sessionActivity';
import type { SessionActivityResult } from './sessionActivity';


// Only the trailing turn matters, so the subscription re-renders the caller
// when that flag flips rather than on every streamed message update.
const selectHasPendingAssistant = (messages: Message[]): boolean => (
  isIncompleteAssistantTurn(getLastConversationMessage(messages))
);

const IDLE_RESULT: SessionActivityResult = IDLE_SESSION_ACTIVITY;

export function useSessionActivity(sessionId: string | null | undefined, directory?: string): SessionActivityResult {
  const status = useSessionStatus(sessionId ?? '', directory);
  const statusSnapshotReady = useSessionStatusSnapshotReady(directory, sessionId ?? '');
  const globalResolvedStatus = useGlobalSessionStatusStore(
    React.useCallback((state) => (sessionId ? state.resolvedStatusById.get(sessionId) : undefined), [sessionId]),
  );
  const hasGlobalStatusSnapshot = useGlobalSessionStatusStore(
    React.useCallback((state) => {
      if (!directory) return false;
      return state.statusSnapshotAtByDirectory.has(normalizeProjectPath(directory) ?? directory);
    }, [directory]),
  );
  const hasPendingAssistant = useSessionMessagesSelector(sessionId ?? '', directory, selectHasPendingAssistant);
  const permissions = useSessionPermissions(sessionId ?? '', directory);
  const releasedForms = useRecoverableQuestionsStore((state) => state.releasedForms);
  const formHoldsTurn = useDirectorySync(React.useCallback((state) => (
    state.form[sessionId ?? '']?.some((form) => formTurnHold(form, state.part, releasedForms) !== 'released') ?? false
  ), [sessionId, releasedForms]), directory);
  const unloadedForms = useDirectorySync(React.useCallback((state) => (
    (state.form[sessionId ?? ''] ?? [])
      .filter((form) => formTurnHold(form, state.part, releasedForms) === 'unknown')
      .map((form) => form.id)
      .join('\n')
  ), [sessionId, releasedForms]), directory);
  const sessionForms = useDirectorySync(React.useCallback((state) => state.form[sessionId ?? ''], [sessionId]), directory);
  React.useEffect(() => {
    if (sessionId && unloadedForms) readUnloadedFormToolLinks(sessionId);
  }, [sessionId, unloadedForms, sessionForms]);

  return React.useMemo<SessionActivityResult>(() => {
    if (!sessionId) return IDLE_RESULT;
    return deriveSessionActivity({
      childStatus: status,
      globalResolvedStatus,
      hasAuthoritativeStatusSnapshot: statusSnapshotReady || hasGlobalStatusSnapshot,
      hasPendingAssistant,
      pendingPermissions: permissions.length,
      pendingQuestions: formHoldsTurn ? 1 : 0,
    });
  }, [sessionId, status, statusSnapshotReady, globalResolvedStatus, hasGlobalStatusSnapshot, hasPendingAssistant, permissions.length, formHoldsTurn]);
}

export function useCurrentSessionActivity(): SessionActivityResult {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
  return useSessionActivity(currentSessionId, currentSessionDirectory ?? undefined);
}
