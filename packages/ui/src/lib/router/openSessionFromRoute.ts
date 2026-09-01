import { ensureGlobalSessionsLoaded, resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

/**
 * Select a session named by `/?session=`. Cold loads often do not know the
 * owning directory yet, so a first selection may guess the active project.
 * An explicit directory is applied immediately. Otherwise, re-select with the
 * global session directory once it is available unless the user moved away.
 */
export async function openSessionFromRoute(
  sessionId: string,
  directoryHint?: string | null,
): Promise<void> {
  const id = sessionId.trim();
  if (!id) return;
  const directory = directoryHint?.trim() || null;

  const initial = useSessionUIStore.getState();
  if (initial.currentSessionId !== id || (directory && initial.currentSessionDirectory !== directory)) {
    initial.setCurrentSession(id, directory || initial.getDirectoryForSession(id));
  }
  if (directory) return;

  const snapshot = await ensureGlobalSessionsLoaded().catch(() => null);
  if (!snapshot) return;

  const latest = useSessionUIStore.getState();
  if (latest.currentSessionId !== id) return;

  const session = [...snapshot.activeSessions, ...snapshot.archivedSessions]
    .find((entry) => entry.id === id);
  if (!session) return;

  const resolvedDirectory = resolveGlobalSessionDirectory(session);
  if (!resolvedDirectory || resolvedDirectory === latest.currentSessionDirectory) return;

  latest.setCurrentSession(id, resolvedDirectory);
}
