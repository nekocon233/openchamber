import type { Session } from '@opencode-ai/sdk/v2';

export const RECENT_SESSION_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const EMPTY_MESSAGE_ACTIVITY = new Map<string, number>();

const isSubtaskSession = (session: Session): boolean => {
  return Boolean((session as Session & { parentID?: string | null }).parentID);
};

const isArchivedSession = (session: Session): boolean => {
  return Boolean(session.time?.archived);
};

const getSessionUpdatedAt = (session: Session): number => {
  const updated = session.time?.updated;
  const created = session.time?.created;
  if (typeof updated === 'number' && Number.isFinite(updated)) {
    return updated;
  }
  if (typeof created === 'number' && Number.isFinite(created)) {
    return created;
  }
  return 0;
};

export const getSessionActivityTimestamp = (
  session: Session,
  messageActivityBySessionId: ReadonlyMap<string, number> = EMPTY_MESSAGE_ACTIVITY,
): number => {
  const messageActivity = messageActivityBySessionId.get(session.id);
  return typeof messageActivity === 'number' && Number.isFinite(messageActivity) && messageActivity > 0
    ? messageActivity
    : getSessionUpdatedAt(session);
};

export const sortSessionsByActivity = (
  sessions: Session[],
  messageActivityBySessionId: ReadonlyMap<string, number> = EMPTY_MESSAGE_ACTIVITY,
): Session[] => {
  return [...sessions].sort((a, b) => (
    getSessionActivityTimestamp(b, messageActivityBySessionId)
    - getSessionActivityTimestamp(a, messageActivityBySessionId)
  ));
};

// Recent sessions are every non-archived, top-level session with effective
// message/session activity inside the window. Missing message activity falls
// back to session timestamps; live busy state does not affect membership.
export const deriveRecentSessions = (
  sessions: Session[],
  now = Date.now(),
  messageActivityBySessionId: ReadonlyMap<string, number> = EMPTY_MESSAGE_ACTIVITY,
): Session[] => {
  const minUpdatedAt = now - RECENT_SESSION_MAX_AGE_MS;
  const recent = sessions.filter((session) => {
    if (isArchivedSession(session) || isSubtaskSession(session)) {
      return false;
    }
    return getSessionActivityTimestamp(session, messageActivityBySessionId) >= minUpdatedAt;
  });
  return sortSessionsByActivity(recent, messageActivityBySessionId);
};
