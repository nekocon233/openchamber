import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFollowUpQueueServerRuntime } from './index.js';

const temporaryRoots = new Set();

afterEach(async () => {
  const roots = [...temporaryRoots];
  temporaryRoots.clear();
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
});

const createRoot = async (prefix) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.add(root);
  return root;
};

const createItem = (suffix = 'a') => ({
  id: `item-${suffix}`,
  messageId: `message-${suffix}`,
  content: `content-${suffix}`,
  attachments: [{
    id: `attachment-${suffix}`,
    dataUrl: 'data:text/plain;base64,YQ==',
    mimeType: 'text/plain',
    filename: 'fixture.txt',
    size: 1,
    source: 'server',
    serverPath: '/synthetic/private/path',
  }],
  createdAt: 1_000,
  status: 'queued',
});

describe('follow-up queue server runtime', () => {
  it('broadcasts only opaque applied and dedupe-recovery revision hints', async () => {
    const root = await createRoot('openchamber-follow-up-events-');
    const broadcastGlobalUiEvent = vi.fn();
    const runtime = createFollowUpQueueServerRuntime({
      fsPromises: fs,
      path,
      rootDirectory: path.join(root, 'follow-up-queue'),
      broadcastGlobalUiEvent,
      now: () => 1_000,
    });
    const sessionId = 'session-event-fixture';
    const item = createItem('opaque');
    const initialRequest = {
      sessionId,
      baseRevision: 0,
      clientMutationId: 'event-initial',
      operation: { type: 'add', item },
    };

    const initial = await runtime.applyMutation(initialRequest);
    await runtime.applyMutation({
      sessionId,
      baseRevision: 1,
      clientMutationId: 'event-noop',
      operation: { type: 'remove', itemId: 'missing-item' },
    });
    const claimed = await runtime.applyMutation({
      sessionId,
      baseRevision: 1,
      clientMutationId: 'event-claim',
      operation: { type: 'claim', itemId: item.id, claimId: 'claim-event', mode: 'auto' },
    });
    await runtime.applyMutation(initialRequest);

    expect(claimed.snapshot.revision).toBe(2);
    expect(broadcastGlobalUiEvent.mock.calls.map(([event]) => event)).toEqual([
      {
        type: 'openchamber:follow-up-queue.changed',
        properties: { scopeToken: initial.snapshot.scopeToken, revision: 1 },
      },
      {
        type: 'openchamber:follow-up-queue.changed',
        properties: { scopeToken: initial.snapshot.scopeToken, revision: 2 },
      },
      {
        type: 'openchamber:follow-up-queue.changed',
        properties: { scopeToken: initial.snapshot.scopeToken, revision: 2 },
      },
    ]);

    const serializedEvents = JSON.stringify(broadcastGlobalUiEvent.mock.calls);
    for (const forbidden of [
      sessionId,
      item.id,
      item.messageId,
      item.content,
      item.attachments[0].dataUrl,
      item.attachments[0].serverPath,
      'claim-event',
    ]) {
      expect(serializedEvents).not.toContain(forbidden);
    }
  });

  it('terminalizes both authoritative deletion event shapes and cannot be revived publicly', async () => {
    const root = await createRoot('openchamber-follow-up-terminal-');
    const runtime = createFollowUpQueueServerRuntime({
      fsPromises: fs,
      path,
      rootDirectory: path.join(root, 'follow-up-queue'),
      broadcastGlobalUiEvent: vi.fn(),
      now: () => 1_000,
    });

    expect(runtime.terminalizeSessionFromEvent({ type: 'session.updated' })).toBeNull();
    expect(runtime.terminalizeSessionFromEvent({ type: 'session.deleted', properties: {} })).toBeNull();
    await runtime.terminalizeSessionFromEvent({
      type: 'session.deleted',
      properties: { sessionID: 'session-deleted-direct' },
    });
    await runtime.terminalizeSessionFromEvent({
      type: 'session.deleted',
      properties: { info: { id: 'session-deleted-info' } },
    });

    await expect(runtime.load('session-deleted-direct')).resolves.toMatchObject({ revision: 1, items: [] });
    await expect(runtime.load('session-deleted-info')).resolves.toMatchObject({ revision: 1, items: [] });
    const delayed = await runtime.applyMutation({
      sessionId: 'session-deleted-direct',
      baseRevision: 1,
      clientMutationId: 'delayed-after-delete',
      operation: { type: 'add', item: createItem('delayed') },
    });
    expect(delayed).toMatchObject({
      applied: false,
      mutationRevision: null,
      snapshot: { revision: 1, items: [] },
    });
  });

  it('reconciles every readable non-terminal queue without treating check failures as deletion', async () => {
    const root = await createRoot('openchamber-follow-up-reconcile-');
    const rootDirectory = path.join(root, 'follow-up-queue');
    const runtime = createFollowUpQueueServerRuntime({
      fsPromises: fs,
      path,
      rootDirectory,
      broadcastGlobalUiEvent: vi.fn(),
      now: () => 1_000,
    });
    for (const sessionId of ['session-live', 'session-missing', 'session-unavailable', 'session-terminal']) {
      await runtime.applyMutation({
        sessionId,
        baseRevision: 0,
        clientMutationId: `add-${sessionId}`,
        operation: { type: 'add', item: createItem(sessionId) },
      });
    }
    await runtime.terminalizeSession('session-terminal');
    await fs.writeFile(path.join(rootDirectory, `${'f'.repeat(64)}.json`), '{', 'utf8');

    const result = await runtime.reconcileStoredSessions(async (sessionId) => {
      if (sessionId === 'session-live') return true;
      if (sessionId === 'session-missing') return false;
      throw new Error('authoritative session lookup failed');
    });

    expect(result).toEqual({ checked: 3, terminalized: 1, failed: 2 });
    await expect(runtime.load('session-live')).resolves.toMatchObject({ items: [{ id: 'item-session-live' }] });
    await expect(runtime.load('session-missing')).resolves.toMatchObject({ items: [], revision: 2 });
    await expect(runtime.load('session-unavailable')).resolves.toMatchObject({
      items: [{ id: 'item-session-unavailable' }],
      revision: 1,
    });
    await expect(runtime.load('session-terminal')).resolves.toMatchObject({ items: [], revision: 2 });
  });

  it('persists a deletion fence that blocks other host processes until startup recovery', async () => {
    const root = await createRoot('openchamber-follow-up-terminal-fence-');
    const rootDirectory = path.join(root, 'follow-up-queue');
    const stable = createFollowUpQueueServerRuntime({
      fsPromises: fs,
      path,
      rootDirectory,
      broadcastGlobalUiEvent: vi.fn(),
      now: () => 1_000,
    });
    const sessionId = 'session-terminal-fence';
    await stable.applyMutation({
      sessionId,
      baseRevision: 0,
      clientMutationId: 'fence-add',
      operation: { type: 'add', item: createItem('fence') },
    });
    const snapshot = await stable.load(sessionId);
    const failing = createFollowUpQueueServerRuntime({
      fsPromises: {
        ...fs,
        rename: async (source, target) => {
          if (target === path.join(rootDirectory, `${snapshot.scopeToken}.json`)) {
            const error = new Error('injected authority write failure');
            error.code = 'EIO';
            throw error;
          }
          return fs.rename(source, target);
        },
      },
      path,
      rootDirectory,
      broadcastGlobalUiEvent: vi.fn(),
    });

    await expect(failing.terminalizeSession(sessionId)).rejects.toMatchObject({
      code: 'FOLLOW_UP_QUEUE_WRITE_FAILED',
    });
    await expect(stable.load(sessionId)).rejects.toMatchObject({
      code: 'FOLLOW_UP_QUEUE_READ_FAILED',
    });
    await expect(stable.applyMutation({
      sessionId,
      baseRevision: 1,
      clientMutationId: 'fence-delayed-claim',
      operation: { type: 'claim', itemId: 'item-fence', claimId: 'claim-fence', mode: 'auto' },
    })).rejects.toMatchObject({ code: 'FOLLOW_UP_QUEUE_READ_FAILED' });

    await expect(stable.recoverTerminalFences()).resolves.toEqual({
      recovered: 1,
      failed: 0,
    });
    await expect(stable.load(sessionId)).resolves.toMatchObject({ items: [], revision: 2 });
  });

  it('retries terminal writes with one mutation identity and bounded exponential delays', async () => {
    const root = await createRoot('openchamber-follow-up-retry-');
    let renameAttempts = 0;
    const persistedMutationIds = [];
    const waitForTerminalRetry = vi.fn(async () => {});
    const runtime = createFollowUpQueueServerRuntime({
      fsPromises: {
        stat: (...args) => fs.stat(...args),
        readFile: (...args) => fs.readFile(...args),
        writeFile: async (...args) => {
          const parsed = JSON.parse(String(args[1]));
          if (Array.isArray(parsed.recentMutations)) {
            persistedMutationIds.push(parsed.recentMutations.at(-1).clientMutationId);
          }
          return fs.writeFile(...args);
        },
        mkdir: (...args) => fs.mkdir(...args),
        rename: (...args) => {
          if (String(args[1]).endsWith('.json')) renameAttempts += 1;
          if (String(args[1]).endsWith('.json') && renameAttempts <= 9) {
            const error = new Error('injected failure');
            error.code = 'EIO';
            throw error;
          }
          return fs.rename(...args);
        },
        unlink: (...args) => fs.unlink(...args),
        rmdir: (...args) => fs.rmdir(...args),
      },
      path,
      rootDirectory: path.join(root, 'follow-up-queue'),
      broadcastGlobalUiEvent: vi.fn(),
      waitForTerminalRetry,
    });

    await runtime.terminalizeSessionFromEvent({
      type: 'session.deleted',
      properties: { sessionID: 'session-retry' },
    });

    expect(renameAttempts).toBe(10);
    expect(waitForTerminalRetry.mock.calls.map(([delay]) => delay)).toEqual([
      250,
      500,
      1_000,
      2_000,
      4_000,
      8_000,
      16_000,
      30_000,
      30_000,
    ]);
    expect(new Set(persistedMutationIds).size).toBe(1);
    await expect(runtime.load('session-retry')).resolves.toMatchObject({ revision: 1, items: [] });
  });

  it('rebroadcasts a deduplicated terminal revision after an ambiguous directory sync failure', async () => {
    const root = await createRoot('openchamber-follow-up-sync-');
    let failSync = true;
    const broadcastGlobalUiEvent = vi.fn();
    const runtime = createFollowUpQueueServerRuntime({
      fsPromises: {
        stat: (...args) => fs.stat(...args),
        readFile: (...args) => fs.readFile(...args),
        writeFile: (...args) => fs.writeFile(...args),
        mkdir: (...args) => fs.mkdir(...args),
        rename: (...args) => fs.rename(...args),
        unlink: (...args) => fs.unlink(...args),
        rmdir: (...args) => fs.rmdir(...args),
        open: async (...args) => {
          const handle = await fs.open(...args);
          return {
            close: () => handle.close(),
            sync: async () => {
              if (failSync) {
                failSync = false;
                throw new Error('injected failure');
              }
              return handle.sync();
            },
          };
        },
      },
      path,
      rootDirectory: path.join(root, 'follow-up-queue'),
      broadcastGlobalUiEvent,
      waitForTerminalRetry: async () => {},
    });

    await runtime.terminalizeSessionFromEvent({
      type: 'session.deleted',
      properties: { sessionID: 'session-sync-recovery' },
    });

    expect(broadcastGlobalUiEvent).toHaveBeenCalledTimes(1);
    expect(broadcastGlobalUiEvent.mock.calls[0][0]).toMatchObject({
      type: 'openchamber:follow-up-queue.changed',
      properties: { revision: 1, reset: true },
    });
  });
});
