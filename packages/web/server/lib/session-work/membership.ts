import path from 'path';
import { z } from 'zod';
import { isPinnedMetadata, readWork } from './state.js';
import { sessionParentId } from '../session-lineage.js';
import type { SessionMetadata } from '../openchamber-sessions/session-metadata-store.js';

export interface WorkSession {
  parentID?: string | null | undefined;
  metadata?: SessionMetadata | undefined;
  time?: { archived?: number | null | undefined; idle?: number | undefined } | undefined;
}

const notWorkSessionSchema = z.object({ openchamber: z.object({ kind: z.enum(['review', 'btw', 'scheduled']) }) });

export const createWorkMembership = ({ chatRoots = [] }: { chatRoots?: string[] } = {}) => {
  const resolvedChatRoots = chatRoots.filter(Boolean).map((root) => path.resolve(root));
  const isChatDirectory = (directory: string | null | undefined) => {
    if (!directory) return false;
    const resolved = path.resolve(directory);
    return resolvedChatRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
  };

  const canBeInWork = (session: WorkSession | null | undefined) => !!session
    && !sessionParentId(session)
    && !notWorkSessionSchema.safeParse(session.metadata).success;

  const isInWork = (session: WorkSession | null | undefined) => !!session
    && !sessionParentId(session)
    && !session.time?.archived
    && !isPinnedMetadata(session.metadata)
    && readWork(session.metadata)?.state === 'open';

  const isDoneSuggested = (session: WorkSession | null | undefined) => {
    const suggestedAt = readWork(session?.metadata)?.suggestDoneAt;
    return isInWork(session) && suggestedAt !== undefined && suggestedAt >= (session?.time?.idle ?? 0);
  };

  return { isChatDirectory, canBeInWork, isInWork, isDoneSuggested };
};
