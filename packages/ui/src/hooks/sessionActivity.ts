import type { SessionStatus } from '@/lib/opencode/model';

export type SessionActivityPhase = 'idle' | 'busy' | 'retry';

export interface SessionActivityResult {
  phase: SessionActivityPhase;
  isWorking: boolean;
  isBusy: boolean;
  isCooldown: boolean;
}

export const IDLE_SESSION_ACTIVITY: SessionActivityResult = {
  phase: 'idle',
  isWorking: false,
  isBusy: false,
  isCooldown: false,
};

export function deriveSessionActivity(input: {
  childStatus?: SessionStatus;
  globalResolvedStatus?: SessionActivityPhase;
  hasAuthoritativeStatusSnapshot: boolean;
  /**
   * Whether the trailing turn is still incomplete. The caller reads it
   * through the leaf message selector, so this owner never holds the message
   * list and never re-renders on an unrelated streamed update.
   */
  hasPendingAssistant: boolean;
  pendingPermissions: number;
  pendingQuestions: number;
}): SessionActivityResult {
  if (input.pendingPermissions > 0 || input.pendingQuestions > 0) return IDLE_SESSION_ACTIVITY;

  const phase = input.globalResolvedStatus ?? input.childStatus?.type ?? 'idle';
  const hasAuthoritativeStatus = input.childStatus !== undefined
    || input.globalResolvedStatus !== undefined
    || input.hasAuthoritativeStatusSnapshot;
  const statusWorking = hasAuthoritativeStatus && phase !== 'idle';
  const isWorking = statusWorking || (input.hasPendingAssistant && !hasAuthoritativeStatus);

  if (hasAuthoritativeStatus && !statusWorking) return IDLE_SESSION_ACTIVITY;
  if (!isWorking) return IDLE_SESSION_ACTIVITY;

  return {
    phase: statusWorking ? phase as SessionActivityPhase : 'busy',
    isWorking: true,
    isBusy: phase === 'busy' || (!statusWorking && input.hasPendingAssistant),
    isCooldown: false,
  };
}
