// Reverting native turns, the way OpenCode reverts its own: files go back at
// once and can be put back (unrevert); the conversation rewinds only when the
// next prompt commits the revert.
//
// Files: before every OpenChamber prompt the work tree is snapshotted, and
// again when the session goes idle. A revert restores only the files the
// reverted turns changed, to their state before the first reverted prompt, so
// edits the user made between turns stay. Turns typed in a terminal have no
// snapshots; what they changed on disk stays, and a revert whose first prompt
// has no snapshot rewinds the conversation only.
//
// Conversation: the backend decides how (Claude resumes at the kept turn's last
// chain entry, Codex reverts the thread before a turn); this module keeps what
// the commit needs until the backend confirms it.
//
// Changes to one session run one at a time, in call order: a snapshot taken
// when a turn ends lands before a revert requested after it.

/**
 * @typedef {{ resumeAt: string } | { beforeTurnId: string }} ConversationRewind
 * @typedef {{
 *   messageId: string,
 *   messageIds: string[],
 *   phase: 'pending' | 'committed',
 *   root?: string,
 *   preRevert?: string,
 *   files: string[],
 *   resumeAt?: string,
 *   beforeTurnId?: string,
 * }} PendingRevert
 */

/**
 * @param {object} options
 * @param {ReturnType<typeof import('./registry.js').createNativeRegistry>} options.registry
 * @param {ReturnType<typeof import('./snapshots.js').createSnapshotStore>} options.snapshots
 */
export const createNativeReverts = ({ registry, snapshots }) => {
  /** @type {Map<string, Promise<unknown>>} session id → last queued operation */
  const queues = new Map();

  const serialized = (sessionId, work) => {
    const previous = queues.get(sessionId) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(work);
    queues.set(sessionId, run);
    run.finally(() => {
      if (queues.get(sessionId) === run) queues.delete(sessionId);
    }).catch(() => {});
    return run;
  };

  const warn = (what, sessionId, error) => {
    console.warn(`[native-agents] ${what} for ${sessionId}:`, error instanceof Error ? error.message : error);
  };

  // Puts the files of a pending revert back the way they were before it.
  const undo = async (pending) => {
    if (pending.root && pending.preRevert) await snapshots.restoreFiles(pending.root, pending.preRevert, pending.files);
  };

  return {
    /**
     * Snapshots the work tree before a prompt's turn. A directory outside git,
     * or a snapshot that fails, leaves the prompt without one.
     */
    beforePrompt(sessionId, directory, messageId) {
      return serialized(sessionId, async () => {
        try {
          const root = await snapshots.repositoryRoot(directory);
          if (!root) return;
          const before = await snapshots.capture(root);
          await registry.recordTurnStart(sessionId, { messageId, root, before });
        } catch (error) {
          warn('could not snapshot the work tree before a prompt', sessionId, error);
        }
      });
    },

    /** Snapshots the work tree once the session is idle, for the prompts it answered. */
    afterTurn(sessionId) {
      return serialized(sessionId, async () => {
        try {
          const open = (await registry.turnSnapshots(sessionId)).filter((record) => record.after === undefined);
          if (open.length === 0) return;
          const after = await snapshots.capture(open[0].root);
          await registry.recordTurnEnd(sessionId, after);
        } catch (error) {
          warn('could not snapshot the work tree after a turn', sessionId, error);
        }
      });
    },

    /**
     * Reverts the prompt `messageId` and everything after it. A revert still
     * pending is undone first, so moving the revert point either way starts
     * from the latest state. A committed revert the backend has not confirmed
     * yet is replaced; its dropped messages stay dropped.
     * @param {object} input
     * @param {string} input.sessionId
     * @param {string} input.messageId first reverted user message
     * @param {string[]} input.messageIds that message and every later user message
     * @param {ConversationRewind} input.rewind
     * @returns {Promise<{ filesRestored: number, conversationOnly: boolean }>}
     */
    revert({ sessionId, messageId, messageIds, rewind }) {
      return serialized(sessionId, async () => {
        const previous = await registry.pendingRevert(sessionId);
        const dropped = new Set(messageIds);
        if (previous?.phase === 'pending') await undo(previous);
        if (previous?.phase === 'committed') for (const id of previous.messageIds) dropped.add(id);

        const base = { messageId, messageIds: [...dropped], phase: 'pending', ...rewind };
        const reverted = new Set(messageIds);
        const turns = (await registry.turnSnapshots(sessionId)).filter((record) => reverted.has(record.messageId));
        const first = turns.find((record) => record.messageId === messageId);
        if (!first) {
          await registry.setPendingRevert(sessionId, { ...base, files: [] });
          return { filesRestored: 0, conversationOnly: true };
        }
        const { root } = first;
        const now = await snapshots.capture(root);
        const files = new Set();
        for (const turn of turns) {
          if (turn.root !== root) continue;
          for (const file of await snapshots.changedFiles(root, turn.before, turn.after ?? now)) files.add(file);
        }
        const list = [...files].sort();
        await snapshots.restoreFiles(root, first.before, list);
        await registry.setPendingRevert(sessionId, { ...base, root, preRevert: now, files: list });
        return { filesRestored: list.length, conversationOnly: false };
      });
    },

    /** Puts back what a pending revert restored; false when none is pending. */
    unrevert(sessionId) {
      return serialized(sessionId, async () => {
        const pending = await registry.pendingRevert(sessionId);
        if (pending?.phase !== 'pending') return false;
        await undo(pending);
        await registry.setPendingRevert(sessionId, null);
        return true;
      });
    },

    /**
     * The revert in effect, as last written. Reads do not wait for a revert
     * in progress; it announces its result when done.
     * @returns {Promise<PendingRevert | null>}
     */
    pending(sessionId) {
      return registry.pendingRevert(sessionId);
    },

    /**
     * A prompt is going out that rewinds the conversation. From now on
     * history reads leave the reverted messages out, the files stay as the
     * revert left them, and the revert can no longer be undone.
     */
    beginCommit(sessionId) {
      return serialized(sessionId, async () => {
        const pending = await registry.pendingRevert(sessionId);
        if (pending?.phase === 'pending') await registry.setPendingRevert(sessionId, { ...pending, phase: 'committed' });
      });
    },

    /** The prompt never reached the CLI: the revert can be undone again. */
    cancelCommit(sessionId) {
      return serialized(sessionId, async () => {
        const pending = await registry.pendingRevert(sessionId);
        if (pending?.phase === 'committed') await registry.setPendingRevert(sessionId, { ...pending, phase: 'pending' });
      });
    },

    /** The backend rewound the conversation: forget the revert and its dropped prompts' snapshots. */
    finishCommit(sessionId) {
      return serialized(sessionId, async () => {
        const pending = await registry.pendingRevert(sessionId);
        if (!pending) return;
        await registry.dropTurns(sessionId, pending.messageIds);
        await registry.setPendingRevert(sessionId, null);
      });
    },
  };
};
