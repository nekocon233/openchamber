import type { Session } from '@/lib/opencode/model';
import { isChatDirectoryPath } from '@/lib/chatDirectories';
import type { MultiRunIndex } from '@/lib/multirun/runs';
import type { SessionNode } from '@/components/session/sidebar/types';
import type { TimelineEntry, TimelineProject } from './MobileTimelineList';

/** Preserve chats without a project and collapse a run at its first lane. */
export function buildMobileTimelineEntries(
  sessions: readonly Session[],
  contexts: ReadonlyMap<string, { project: TimelineProject; branch: string | null; inSpace: boolean }>,
  runIndex: MultiRunIndex,
  runLaneNodesByKey: ReadonlyMap<string, readonly SessionNode[]>,
): TimelineEntry[] {
  const listedRuns = new Set<string>();
  return sessions.flatMap((session): TimelineEntry[] => {
    if (isChatDirectoryPath(session.directory)) {
      return [{ kind: 'session', session, project: null, branch: null, inSpace: false }];
    }
    const context = contexts.get(session.id);
    if (!context) return [];
    const runKey = runIndex.runKeyBySessionId.get(session.id);
    const run = runKey ? runIndex.runs.get(runKey) : undefined;
    if (!run) return [{ kind: 'session', session, ...context }];
    if (listedRuns.has(run.key)) return [];
    listedRuns.add(run.key);
    return [{ kind: 'run', run, laneNodes: runLaneNodesByKey.get(run.key) ?? [], project: context.project }];
  });
}
