import type { SnapshotStore } from './snapshots.js';

export type ConversationRewind = {
  resumeAt?: string | undefined;
  beforeTurnId?: string | undefined;
  deepseek?: { nativeId: string; seq: number } | undefined;
};

export type PendingRevert = {
  messageId: string;
  messageIds: string[];
  phase: 'pending' | 'committed';
  root?: string | undefined;
  preRevert?: string | undefined;
  files: string[];
  resumeAt?: string | undefined;
  beforeTurnId?: string | undefined;
  deepseek?: { nativeId: string; seq: number } | undefined;
};

export type TurnSnapshotRecord = {
  messageId: string;
  root: string;
  before: string;
  after?: string | undefined;
};

export interface NativeRevertRegistry {
  recordTurnStart: (sessionId: string, record: { messageId: string; root: string; before: string }) => Promise<void>;
  turnSnapshots: (sessionId: string) => Promise<TurnSnapshotRecord[]>;
  recordTurnEnd: (sessionId: string, after: string) => Promise<void>;
  pendingRevert: (sessionId: string) => Promise<PendingRevert | null>;
  setPendingRevert: (sessionId: string, pending: PendingRevert | null) => Promise<void>;
  dropTurns: (sessionId: string, messageIds: string[]) => Promise<void>;
}

export interface NativeRevertsOptions {
  registry: NativeRevertRegistry;
  snapshots: SnapshotStore;
}

export interface RevertTurnInput {
  sessionId: string;
  messageId: string;
  messageIds: string[];
  rewind: ConversationRewind;
  restoreFiles?: boolean | undefined;
}

export type RevertResult = {
  filesRestored: number;
  conversationOnly: boolean;
};

export interface NativeReverts {
  beforePrompt: (sessionId: string, directory: string, messageId: string) => Promise<void>;
  afterTurn: (sessionId: string) => Promise<void>;
  revert: (input: RevertTurnInput) => Promise<RevertResult>;
  unrevert: (sessionId: string) => Promise<boolean>;
  pending: (sessionId: string) => Promise<PendingRevert | null>;
  beginCommit: (sessionId: string) => Promise<void>;
  cancelCommit: (sessionId: string) => Promise<void>;
  finishCommit: (sessionId: string) => Promise<void>;
}

export const createNativeReverts = ({ registry, snapshots }: NativeRevertsOptions): NativeReverts => {
  const queues = new Map<string, Promise<void>>();

  const serialized = <Result>(sessionId: string, work: () => Promise<Result>): Promise<Result> => {
    const previous = queues.get(sessionId) ?? Promise.resolve();
    const run = previous.then(work);
    const settled = run.then(() => undefined, () => undefined);
    queues.set(sessionId, settled);
    void settled.finally(() => {
      if (queues.get(sessionId) === settled) queues.delete(sessionId);
    });
    return run;
  };

  const warn = (what: string, sessionId: string, cause: unknown): void => {
    console.warn(`[native-agents] ${what} for ${sessionId}:`, cause instanceof Error ? cause.message : cause);
  };

  const undo = async (pending: PendingRevert): Promise<void> => {
    if (pending.root && pending.preRevert) await snapshots.restoreFiles(pending.root, pending.preRevert, pending.files);
  };

  return {
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

    afterTurn(sessionId) {
      return serialized(sessionId, async () => {
        try {
          const open = (await registry.turnSnapshots(sessionId)).filter((record) => record.after === undefined);
          const firstOpen = open[0];
          if (!firstOpen) return;
          const after = await snapshots.capture(firstOpen.root);
          await registry.recordTurnEnd(sessionId, after);
        } catch (error) {
          warn('could not snapshot the work tree after a turn', sessionId, error);
        }
      });
    },

    revert({ sessionId, messageId, messageIds, rewind, restoreFiles = true }) {
      return serialized(sessionId, async () => {
        const previous = await registry.pendingRevert(sessionId);
        const dropped = new Set(messageIds);
        if (previous?.phase === 'pending') await undo(previous);
        if (previous?.phase === 'committed') for (const id of previous.messageIds) dropped.add(id);

        const base = { messageId, messageIds: [...dropped], phase: 'pending' as const, ...rewind };
        if (!restoreFiles) {
          await registry.setPendingRevert(sessionId, { ...base, files: [] });
          return { filesRestored: 0, conversationOnly: true };
        }
        const reverted = new Set(messageIds);
        const turns = (await registry.turnSnapshots(sessionId)).filter((record) => reverted.has(record.messageId));
        const first = turns.find((record) => record.messageId === messageId);
        if (!first) {
          await registry.setPendingRevert(sessionId, { ...base, files: [] });
          return { filesRestored: 0, conversationOnly: true };
        }
        const { root } = first;
        const now = await snapshots.capture(root);
        const files = new Set<string>();
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

    unrevert(sessionId) {
      return serialized(sessionId, async () => {
        const pending = await registry.pendingRevert(sessionId);
        if (pending?.phase !== 'pending') return false;
        await undo(pending);
        await registry.setPendingRevert(sessionId, null);
        return true;
      });
    },

    pending(sessionId) {
      return registry.pendingRevert(sessionId);
    },

    beginCommit(sessionId) {
      return serialized(sessionId, async () => {
        const pending = await registry.pendingRevert(sessionId);
        if (pending?.phase === 'pending') await registry.setPendingRevert(sessionId, { ...pending, phase: 'committed' });
      });
    },

    cancelCommit(sessionId) {
      return serialized(sessionId, async () => {
        const pending = await registry.pendingRevert(sessionId);
        if (pending?.phase === 'committed') await registry.setPendingRevert(sessionId, { ...pending, phase: 'pending' });
      });
    },

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
