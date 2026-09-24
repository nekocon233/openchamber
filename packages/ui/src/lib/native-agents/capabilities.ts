import { isNativeSessionId } from './ids';

/** Session actions that depend on OpenCode owning the session. */
type SessionActionSupport = { share: boolean; moveToWorktree: boolean };

/**
 * A native CLI session lives in its CLI's store, tied to its directory: it has
 * no OpenCode share link and it cannot move to another worktree. The server
 * refuses those OpenCode routes for native ids; the menus leave them out.
 */
export const sessionActionSupport = (sessionId: string): SessionActionSupport => {
  const native = isNativeSessionId(sessionId);
  return { share: !native, moveToWorktree: !native };
};
