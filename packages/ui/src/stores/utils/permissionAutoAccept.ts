import type { Session } from "@opencode-ai/sdk/v2/client";

export type PermissionAutoAcceptMap = Record<string, boolean>;

const buildSessionMap = (sessions: Session[]): Map<string, Session> => {
  const map = new Map<string, Session>();
  for (const session of sessions) {
    map.set(session.id, session);
  }
  return map;
};

export const autoRespondsPermission = (input: {
  autoAccept: PermissionAutoAcceptMap;
  defaultEnabled: boolean;
  sessions: Session[];
  sessionById?: ReadonlyMap<string, Session>;
  sessionID: string;
}): boolean => {
  const { autoAccept, defaultEnabled, sessions, sessionById, sessionID } = input;
  if (!sessionID) return false;
  const map = sessionById ?? buildSessionMap(sessions);
  const seen = new Set<string>();
  let current: string | undefined = sessionID;

  while (current) {
    if (seen.has(current)) return false;
    seen.add(current);
    if (Object.prototype.hasOwnProperty.call(autoAccept, current)) {
      return autoAccept[current] === true;
    }
    const session = map.get(current);
    if (!session) return false;
    current = session.parentID;
  }

  return defaultEnabled;
};
