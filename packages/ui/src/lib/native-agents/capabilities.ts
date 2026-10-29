import { isNativeSessionId, isUnifiedNativeSessionId, nativeBackendOfSessionId } from './ids';
import { z } from 'zod';
import type { Session } from '@/lib/opencode/model';

const guardedActions = z.object({ openchamber: z.object({ native: z.object({
  actions: z.object({ revert: z.boolean(), delete: z.boolean(), fork: z.boolean().optional() }),
}) }) });

/** Session actions that depend on OpenCode or a native backend owning the operation. */
type SessionActionSupport = { share: boolean; moveToWorktree: boolean; revert: boolean; delete: boolean; fork: boolean };

/**
 * A native CLI session lives in its CLI's store, tied to its directory: it has
 * no OpenCode share link and it cannot move to another worktree. The server
 * refuses those OpenCode routes for native ids; the menus leave them out.
 * Guarded native backends open actions only when their session metadata
 * advertises them. Antigravity stays closed because its adapter supports none.
 */
export const sessionActionSupport = (sessionId: string, metadata?: Session['metadata']): SessionActionSupport => {
  const native = isNativeSessionId(sessionId);
  const backend = nativeBackendOfSessionId(sessionId);
  if (backend === 'antigravity') return { share: false, moveToWorktree: false, revert: false, delete: false, fork: false };
  const guarded = backend === 'deepseek' || isUnifiedNativeSessionId(sessionId);
  const actions = guarded ? guardedActions.safeParse(metadata).data?.openchamber.native.actions : null;
  return {
    share: !native,
    moveToWorktree: !native,
    revert: guarded ? actions?.revert === true : true,
    delete: guarded ? actions?.delete === true : true,
    fork: guarded ? actions?.fork === true : true,
  };
};
