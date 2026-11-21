import { getSessionActivityTime } from '@/sync/session-ordering';
import type { Session } from '@/lib/opencode/model';
import { getChatsRoot, isChatDirectoryPath } from '@/lib/chatDirectories';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { memoizeSessionListProjection } from '@/stores/sessionListProjection';
import type { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';

import { normalizePath } from './mobilePaths';


export const getSessionDirectory = (session: Session): string => {
  const sessionWithDirectory = session as Session & {
    directory?: string | null;
    project?: { worktree?: string | null } | null;
  };
  return normalizePath(sessionWithDirectory.directory ?? sessionWithDirectory.project?.worktree ?? null);
};

const hasChats = memoizeSessionListProjection((sessions: Session[], _root: string | null, _runtime: string) =>
  sessions.some((session) => isChatDirectoryPath(getSessionDirectory(session))));

export const selectHasChats = (state: ReturnType<typeof useGlobalSessionsStore.getState>): boolean =>
  hasChats(state.activeSessions, getChatsRoot(), getRuntimeKey());

export const getSessionTimestamp = (session: Session): number => getSessionActivityTime(session);

export const formatRelativeShort = (timestamp: number): string => {
  if (timestamp <= 0) return '';
  const diffMs = Date.now() - timestamp;
  if (diffMs < 60_000) return 'now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(timestamp));
};
