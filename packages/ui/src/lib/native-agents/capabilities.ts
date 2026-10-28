import { isNativeSessionId, isUnifiedNativeSessionId, nativeBackendOfSessionId } from './ids';
import { z } from 'zod';
import type { Session } from '@/lib/opencode/model';

const deepseekActions = z.object({ openchamber: z.object({ native: z.object({
  actions: z.object({ revert: z.boolean(), delete: z.boolean() }),
}) }) });

/** Session actions that depend on OpenCode owning the session. */
type SessionActionSupport = { share: boolean; moveToWorktree: boolean; revert: boolean; delete: boolean };

/**
 * A native CLI session lives in its CLI's store, tied to its directory: it has
 * no OpenCode share link and it cannot move to another worktree. The server
 * refuses those OpenCode routes for native ids; the menus leave them out.
 */
export const sessionActionSupport = (sessionId: string, metadata?: Session['metadata']): SessionActionSupport => {
  const native = isNativeSessionId(sessionId);
  const deepseek = nativeBackendOfSessionId(sessionId) === 'deepseek';
  const guarded = deepseek || isUnifiedNativeSessionId(sessionId);
  const actions = guarded ? deepseekActions.safeParse(metadata).data?.openchamber.native.actions : null;
  return { share: !native, moveToWorktree: !native, revert: guarded ? actions?.revert === true : true, delete: guarded ? actions?.delete === true : true };
};
