import type { Message, SessionStatus } from '@opencode-ai/sdk/v2/client';

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
  messages: readonly Message[];
  pendingPermissions: number;
  pendingQuestions: number;
}): SessionActivityResult {
  if (input.pendingPermissions > 0 || input.pendingQuestions > 0) return IDLE_SESSION_ACTIVITY;

  const phase = input.globalResolvedStatus ?? input.childStatus?.type ?? 'idle';
  const hasAuthoritativeStatus = input.childStatus !== undefined
    || input.globalResolvedStatus !== undefined
    || input.hasAuthoritativeStatusSnapshot;
  const lastMessage = input.messages[input.messages.length - 1];
  const hasPendingAssistant = Boolean(
    lastMessage
    && lastMessage.role === 'assistant'
    && typeof (lastMessage as { time?: { completed?: number } }).time?.completed !== 'number',
  );
  const statusWorking = hasAuthoritativeStatus && phase !== 'idle';
  const isWorking = statusWorking || (hasPendingAssistant && !hasAuthoritativeStatus);

  if (hasAuthoritativeStatus && !statusWorking) return IDLE_SESSION_ACTIVITY;
  if (!isWorking) return IDLE_SESSION_ACTIVITY;

  return {
    phase: statusWorking ? phase as SessionActivityPhase : 'busy',
    isWorking: true,
    isBusy: phase === 'busy' || (!statusWorking && hasPendingAssistant),
    isCooldown: false,
  };
}
