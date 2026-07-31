import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  FollowUpQueueConflictError,
  FollowUpQueueCorruptError,
  FollowUpQueueIdempotencyError,
  FollowUpQueueItemConflictError,
  FollowUpQueueValidationError,
  FollowUpQueueWriteError,
  createFollowUpQueueCore,
} from './index.js';

const temporaryRoots = new Set();

afterEach(async () => {
  const roots = [...temporaryRoots];
  temporaryRoots.clear();
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
});

const createFileSystem = (overrides = {}) => ({
  stat: (...args) => fs.stat(...args),
  readFile: (...args) => fs.readFile(...args),
  writeFile: (...args) => fs.writeFile(...args),
  mkdir: (...args) => fs.mkdir(...args),
  rename: (...args) => fs.rename(...args),
  readdir: (...args) => fs.readdir(...args),
  unlink: (...args) => fs.unlink(...args),
  rmdir: (...args) => fs.rmdir(...args),
  open: (...args) => fs.open(...args),
  ...overrides,
});

const createHarness = async (options = {}) => {
  const root = options.root ?? await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-follow-up-queue-'));
  temporaryRoots.add(root);
  const rootDirectory = options.rootDirectory ?? path.join(root, 'follow-up-queue');
  let tempId = 0;
  const core = createFollowUpQueueCore({
    fsPromises: options.fsPromises ?? createFileSystem(),
    path,
    rootDirectory,
    dedupeLimit: options.dedupeLimit,
    createTempId: options.createTempId ?? (() => `test-${tempId += 1}`),
    createLockId: options.createLockId,
    createMessageId: options.createMessageId,
    now: options.now ?? (() => 1_000),
    waitForLock: options.waitForLock,
  });
  return { core, root, rootDirectory };
};

const createItem = (suffix = 'a', overrides = {}) => ({
  id: `item-${suffix}`,
  messageId: `message-${suffix}`,
  content: `content-${suffix}`,
  createdAt: 1_000,
  status: 'staged',
  ...overrides,
});

const mutate = (core, sessionId, baseRevision, clientMutationId, operation) => core.applyMutation({
  sessionId,
  baseRevision,
  clientMutationId,
  operation,
});

describe('follow-up queue core', () => {
  it('serializes claims and terminalization across cores sharing one authority directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-follow-up-multiprocess-'));
    temporaryRoots.add(root);
    const rootDirectory = path.join(root, 'follow-up-queue');
    const createCore = () => createFollowUpQueueCore({
      fsPromises: createFileSystem(),
      path,
      rootDirectory,
      now: () => 1_000,
    });
    const firstCore = createCore();
    const secondCore = createCore();
    const sessionId = 'session-shared-authority';
    await mutate(firstCore, sessionId, 0, 'shared-add', {
      type: 'add',
      item: createItem('shared', { status: 'queued' }),
    });

    const claims = await Promise.allSettled([
      mutate(firstCore, sessionId, 1, 'shared-claim-a', {
        type: 'claim', itemId: 'item-shared', claimId: 'claim-a', mode: 'auto',
      }),
      mutate(secondCore, sessionId, 1, 'shared-claim-b', {
        type: 'claim', itemId: 'item-shared', claimId: 'claim-b', mode: 'auto',
      }),
    ]);
    expect(claims.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(claims.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(claims.find((result) => result.status === 'rejected').reason)
      .toBeInstanceOf(FollowUpQueueConflictError);
    const claimed = await firstCore.load(sessionId);
    expect(['claim-a', 'claim-b']).toContain(claimed.items[0].claim.id);

    await Promise.allSettled([
      firstCore.terminalizeSession(sessionId, 'shared-terminal'),
      mutate(secondCore, sessionId, claimed.revision, 'shared-status', {
        type: 'set-status', itemId: 'item-shared', status: 'staged',
      }),
    ]);
    const terminal = await secondCore.load(sessionId);
    expect(terminal.items).toEqual([]);
    const delayed = await mutate(secondCore, sessionId, terminal.revision, 'shared-delayed-add', {
      type: 'add',
      item: createItem('delayed'),
    });
    expect(delayed.applied).toBe(false);
    expect(delayed.snapshot.items).toEqual([]);
  });

  it('does not let a delayed stale-lock reaper move a successor lock', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-follow-up-lock-aba-'));
    temporaryRoots.add(root);
    const rootDirectory = path.join(root, 'follow-up-queue');
    const sessionId = 'session-lock-aba';
    const scopeToken = createHash('sha256')
      .update(JSON.stringify({ kind: 'session', sessionId }))
      .digest('hex');
    const lockDirectory = path.join(rootDirectory, `.lock-${scopeToken}`);
    const staleDirectory = `${lockDirectory}.stale-dead-owner`;
    const authorityFile = path.join(rootDirectory, `${scopeToken}.json`);
    await fs.mkdir(lockDirectory, { recursive: true });
    await fs.writeFile(
      path.join(lockDirectory, 'owner.json'),
      JSON.stringify({ pid: 2_147_483_647, token: 'dead-owner' }),
      'utf8',
    );

    let markFirstStaleAttempt;
    let releaseFirstStaleAttempt;
    let markFirstStaleAttemptFinished;
    let markSecondAuthorityWrite;
    let releaseSecondAuthorityWrite;
    const firstStaleAttempt = new Promise((resolve) => { markFirstStaleAttempt = resolve; });
    const allowFirstStaleAttempt = new Promise((resolve) => { releaseFirstStaleAttempt = resolve; });
    const firstStaleAttemptFinished = new Promise((resolve) => { markFirstStaleAttemptFinished = resolve; });
    const secondAuthorityWrite = new Promise((resolve) => { markSecondAuthorityWrite = resolve; });
    const allowSecondAuthorityWrite = new Promise((resolve) => { releaseSecondAuthorityWrite = resolve; });
    let delayFirstReaper = true;
    const firstCore = createFollowUpQueueCore({
      fsPromises: createFileSystem({
        rename: async (source, target) => {
          if (delayFirstReaper && source === lockDirectory && target === staleDirectory) {
            delayFirstReaper = false;
            markFirstStaleAttempt();
            await allowFirstStaleAttempt;
            try {
              return await fs.rename(source, target);
            } finally {
              markFirstStaleAttemptFinished();
            }
          }
          return fs.rename(source, target);
        },
      }),
      path,
      rootDirectory,
      createLockId: () => 'first-lock',
      waitForLock: () => new Promise((resolve) => setTimeout(resolve, 1)),
    });
    const secondCore = createFollowUpQueueCore({
      fsPromises: createFileSystem({
        rename: async (source, target) => {
          if (target === authorityFile) {
            markSecondAuthorityWrite();
            await allowSecondAuthorityWrite;
          }
          return fs.rename(source, target);
        },
      }),
      path,
      rootDirectory,
      createLockId: () => 'second-lock',
      waitForLock: () => new Promise((resolve) => setTimeout(resolve, 1)),
    });

    const firstMutation = mutate(firstCore, sessionId, 0, 'aba-first', {
      type: 'add', item: createItem('aba-first'),
    });
    await firstStaleAttempt;
    const secondMutation = mutate(secondCore, sessionId, 0, 'aba-second', {
      type: 'add', item: createItem('aba-second'),
    });
    await secondAuthorityWrite;
    releaseFirstStaleAttempt();
    await firstStaleAttemptFinished;
    releaseSecondAuthorityWrite();

    await expect(secondMutation).resolves.toMatchObject({ mutationRevision: 1 });
    await expect(firstMutation).rejects.toBeInstanceOf(FollowUpQueueConflictError);
    await expect(firstCore.load(sessionId)).resolves.toMatchObject({
      revision: 1,
      items: [{ id: 'item-aba-second' }],
    });
  });

  it('keeps later mutations available when released-lock cleanup fails', async () => {
    let failReleasedOwnerCleanup = true;
    const fsPromises = createFileSystem({
      unlink: async (target) => {
        if (failReleasedOwnerCleanup && String(target).includes('.released-')) {
          failReleasedOwnerCleanup = false;
          const error = new Error('injected cleanup failure');
          error.code = 'EIO';
          throw error;
        }
        return fs.unlink(target);
      },
    });
    const { core } = await createHarness({ fsPromises });
    const sessionId = 'session-release-cleanup';

    await expect(mutate(core, sessionId, 0, 'cleanup-first', {
      type: 'add', item: createItem('cleanup-first'),
    })).resolves.toMatchObject({ mutationRevision: 1 });
    await expect(mutate(core, sessionId, 1, 'cleanup-second', {
      type: 'add', item: createItem('cleanup-second'),
    })).resolves.toMatchObject({ mutationRevision: 2 });
  });

  it('fails closed when an existing lock owner cannot be read', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-follow-up-lock-read-'));
    temporaryRoots.add(root);
    const rootDirectory = path.join(root, 'follow-up-queue');
    const sessionId = 'session-lock-read-error';
    const scopeToken = createHash('sha256')
      .update(JSON.stringify({ kind: 'session', sessionId }))
      .digest('hex');
    const lockDirectory = path.join(rootDirectory, `.lock-${scopeToken}`);
    const ownerFile = path.join(lockDirectory, 'owner.json');
    await fs.mkdir(lockDirectory, { recursive: true });
    await fs.writeFile(ownerFile, JSON.stringify({ pid: process.pid, token: 'active-owner' }), 'utf8');
    let failOwnerRead = true;
    const core = createFollowUpQueueCore({
      fsPromises: createFileSystem({
        readFile: async (target, ...args) => {
          if (failOwnerRead && target === ownerFile) {
            failOwnerRead = false;
            const error = new Error('injected owner read failure');
            error.code = 'EIO';
            throw error;
          }
          return fs.readFile(target, ...args);
        },
      }),
      path,
      rootDirectory,
    });

    await expect(mutate(core, sessionId, 0, 'owner-read-failure', {
      type: 'add', item: createItem('owner-read-failure'),
    })).rejects.toBeInstanceOf(FollowUpQueueWriteError);
    expect(JSON.parse(await fs.readFile(ownerFile, 'utf8'))).toEqual({
      pid: process.pid,
      token: 'active-owner',
    });
  });

  it('retries release before giving up canonical lock ownership', async () => {
    let failReleaseRename = true;
    const fsPromises = createFileSystem({
      rename: async (source, target) => {
        if (failReleaseRename && String(target).includes('.released-')) {
          failReleaseRename = false;
          const error = new Error('injected release failure');
          error.code = 'EIO';
          throw error;
        }
        return fs.rename(source, target);
      },
    });
    const { core } = await createHarness({
      fsPromises,
      waitForLock: () => Promise.resolve(),
    });

    await expect(mutate(core, 'session-release-retry', 0, 'release-retry-first', {
      type: 'add', item: createItem('release-retry-first'),
    })).resolves.toMatchObject({ mutationRevision: 1 });
    await expect(mutate(core, 'session-release-retry', 1, 'release-retry-second', {
      type: 'add', item: createItem('release-retry-second'),
    })).resolves.toMatchObject({ mutationRevision: 2 });
  });

  it('uses a canonical opaque scope path and strictly validates item schemas and limits', async () => {
    const { core, rootDirectory } = await createHarness();
    const sessionId = 'session-canonical-alpha';
    const missing = await core.load(sessionId);
    const expectedToken = createHash('sha256')
      .update(JSON.stringify({ kind: 'session', sessionId }))
      .digest('hex');

    expect(missing).toEqual({ scopeToken: expectedToken, revision: 0, items: [] });
    await expect(fs.stat(rootDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    for (const invalid of ['.', '..', '../escape', 'folder/session', 'folder\\session', 'line\nbreak']) {
      await expect(core.load(invalid)).rejects.toBeInstanceOf(FollowUpQueueValidationError);
    }

    const attachment = {
      id: 'attachment-a',
      dataUrl: 'data:text/plain;base64,YQ==',
      mimeType: 'text/plain',
      filename: 'fixture.txt',
      size: 1,
      source: 'vscode',
      serverPath: '/synthetic/server/path',
      vscodePath: '/synthetic/workspace/path',
      vscodeSource: 'selection',
    };
    const validItem = createItem('valid', {
      attachments: [attachment],
      additionalParts: [
        { text: 'private synthetic context', synthetic: true },
        { text: 'plain additional text' },
      ],
      agentMentionName: 'review-agent',
      sendConfig: {
        providerID: 'provider-a',
        modelID: 'model-a',
        agent: 'agent-a',
        variant: 'variant-a',
      },
    });
    const added = await mutate(core, sessionId, 0, 'schema-valid', { type: 'add', item: validItem });
    expect(added.snapshot.items).toEqual([validItem]);
    expect(await fs.readdir(rootDirectory)).toEqual([`${expectedToken}.json`]);
    expect((await fs.readdir(rootDirectory))[0]).not.toContain(sessionId);

    await expect(mutate(core, sessionId, 1, 'schema-file-field', {
      type: 'add',
      item: createItem('file-field', { attachments: [{ ...attachment, id: 'attachment-file', file: {} }] }),
    })).rejects.toBeInstanceOf(FollowUpQueueValidationError);
    await expect(mutate(core, sessionId, 1, 'schema-client-claim', {
      type: 'add',
      item: createItem('claim', { claim: { id: 'claim-a', expiresAt: 1 } }),
    })).rejects.toBeInstanceOf(FollowUpQueueValidationError);
    await expect(mutate(core, sessionId, 1, 'schema-extra', {
      type: 'add',
      item: { ...createItem('extra'), unsupported: true },
    })).rejects.toBeInstanceOf(FollowUpQueueValidationError);
    await expect(mutate(core, sessionId, 1, 'schema-additional-extra', {
      type: 'add',
      item: createItem('additional-extra', {
        additionalParts: [{ text: 'context', synthetic: true, unsupported: true }],
      }),
    })).rejects.toBeInstanceOf(FollowUpQueueValidationError);
    await expect(mutate(core, sessionId, 1, 'schema-additional-synthetic', {
      type: 'add',
      item: createItem('additional-synthetic', {
        additionalParts: [{ text: 'context', synthetic: 'yes' }],
      }),
    })).rejects.toBeInstanceOf(FollowUpQueueValidationError);
    await expect(mutate(core, sessionId, 1, 'schema-agent-mention-limit', {
      type: 'add',
      item: createItem('agent-mention-limit', { agentMentionName: 'a'.repeat(1025) }),
    })).rejects.toBeInstanceOf(FollowUpQueueValidationError);
    await expect(mutate(core, sessionId, 1, 'schema-content-limit', {
      type: 'add',
      item: createItem('large', { content: 'x'.repeat((1024 * 1024) + 1) }),
    })).rejects.toBeInstanceOf(FollowUpQueueValidationError);
    await expect(mutate(core, sessionId, 1, 'schema-combined-content-limit', {
      type: 'add',
      item: createItem('combined-large', {
        content: 'x'.repeat(512 * 1024),
        additionalParts: [{ text: 'y'.repeat((512 * 1024) + 1), synthetic: true }],
      }),
    })).rejects.toBeInstanceOf(FollowUpQueueValidationError);
    await expect(mutate(core, sessionId, 1, 'schema-attachment-count', {
      type: 'add',
      item: createItem('attachments', {
        attachments: Array.from({ length: 33 }, (_, index) => ({
          ...attachment,
          id: `attachment-${index}`,
        })),
      }),
    })).rejects.toBeInstanceOf(FollowUpQueueValidationError);
    await expect(mutate(core, sessionId, 1, 'schema-additional-count', {
      type: 'add',
      item: createItem('additional-parts', {
        additionalParts: Array.from({ length: 65 }, (_, index) => ({
          text: `part-${index}`,
          synthetic: true,
        })),
      }),
    })).rejects.toBeInstanceOf(FollowUpQueueValidationError);
  });

  it('keeps stored v1 items without extended payload fields readable', async () => {
    const { core } = await createHarness();
    const legacyItem = createItem('legacy-payload');
    await mutate(core, 'session-legacy-payload', 0, 'legacy-payload-add', {
      type: 'add', item: legacyItem,
    });

    await expect(core.load('session-legacy-payload')).resolves.toMatchObject({
      revision: 1,
      items: [legacyItem],
    });
  });

  it('counts additional-part text toward the aggregate queue content limit', async () => {
    const { core } = await createHarness();
    const sessionId = 'session-additional-content-limit';
    const additionalText = 'x'.repeat(1024 * 1024);
    let revision = 0;
    for (let index = 0; index < 4; index += 1) {
      const result = await mutate(core, sessionId, revision, `aggregate-add-${index}`, {
        type: 'add',
        item: createItem(`aggregate-${index}`, {
          content: '',
          additionalParts: [{ text: additionalText, synthetic: true }],
        }),
      });
      revision = result.snapshot.revision;
    }

    await expect(mutate(core, sessionId, revision, 'aggregate-add-overflow', {
      type: 'add',
      item: createItem('aggregate-overflow', {
        content: '',
        additionalParts: [{ text: 'overflow', synthetic: true }],
      }),
    })).rejects.toBeInstanceOf(FollowUpQueueValidationError);
  });

  it('increments revisions only for semantic changes and preserves FIFO move semantics', async () => {
    const { core } = await createHarness();
    const sessionId = 'session-revisions';
    const itemA = createItem('a');

    const missingRemove = await mutate(core, sessionId, 0, 'remove-missing', {
      type: 'remove', itemId: 'missing-item',
    });
    expect(missingRemove).toMatchObject({ applied: false, mutationRevision: null });
    expect(missingRemove.snapshot).toMatchObject({ revision: 0, items: [] });

    const addedA = await mutate(core, sessionId, 0, 'add-a', { type: 'add', item: itemA });
    expect(addedA).toMatchObject({ applied: true, mutationRevision: 1 });
    const sameAdd = await mutate(core, sessionId, 1, 'add-a-same', { type: 'add', item: itemA });
    expect(sameAdd).toMatchObject({ applied: false, mutationRevision: null });
    expect(sameAdd.snapshot.revision).toBe(1);

    const sameStatus = await mutate(core, sessionId, 1, 'status-same', {
      type: 'set-status', itemId: itemA.id, status: 'staged',
    });
    expect(sameStatus).toMatchObject({ applied: false, mutationRevision: null });
    const queued = await mutate(core, sessionId, 1, 'status-queued', {
      type: 'set-status', itemId: itemA.id, status: 'queued',
    });
    expect(queued).toMatchObject({ applied: true, mutationRevision: 2 });

    await mutate(core, sessionId, 2, 'add-b', { type: 'add', item: createItem('b') });
    await mutate(core, sessionId, 3, 'add-c', { type: 'add', item: createItem('c') });
    const alreadyBefore = await mutate(core, sessionId, 4, 'move-a-before-b', {
      type: 'move', itemId: 'item-a', beforeId: 'item-b',
    });
    expect(alreadyBefore).toMatchObject({ applied: false, mutationRevision: null });
    const missingAnchor = await mutate(core, sessionId, 4, 'move-missing-anchor', {
      type: 'move', itemId: 'item-a', beforeId: 'missing-item',
    });
    expect(missingAnchor).toMatchObject({ applied: false, mutationRevision: null });

    const moved = await mutate(core, sessionId, 4, 'move-c-before-b', {
      type: 'move', itemId: 'item-c', beforeId: 'item-b',
    });
    expect(moved.mutationRevision).toBe(5);
    expect(moved.snapshot.items.map((item) => item.id)).toEqual(['item-a', 'item-c', 'item-b']);
    const movedToEnd = await mutate(core, sessionId, 5, 'move-a-end', {
      type: 'move', itemId: 'item-a', beforeId: null,
    });
    expect(movedToEnd.snapshot.items.map((item) => item.id)).toEqual(['item-c', 'item-b', 'item-a']);
    expect(movedToEnd.snapshot.revision).toBe(6);

    await expect(mutate(core, sessionId, 6, 'duplicate-item-id', {
      type: 'add', item: createItem('other', { id: 'item-a' }),
    })).rejects.toBeInstanceOf(FollowUpQueueItemConflictError);
    await expect(mutate(core, sessionId, 6, 'duplicate-message-id', {
      type: 'add', item: createItem('other', { messageId: 'message-a' }),
    })).rejects.toBeInstanceOf(FollowUpQueueItemConflictError);
  });

  it('deduplicates normalized operations before exact revision conflict checks', async () => {
    const { core } = await createHarness();
    const sessionId = 'session-idempotency';
    const originalRequest = {
      sessionId,
      baseRevision: 0,
      clientMutationId: 'response-lost-add',
      operation: { type: 'add', item: createItem('idempotent') },
    };
    const original = await core.applyMutation(originalRequest);
    await mutate(core, sessionId, 1, 'later-status', {
      type: 'set-status', itemId: 'item-idempotent', status: 'queued',
    });

    const retry = await core.applyMutation(originalRequest);
    expect(retry).toMatchObject({
      applied: false,
      deduplicated: true,
      mutationRevision: original.mutationRevision,
      snapshot: { revision: 2 },
    });
    await expect(core.applyMutation({
      ...originalRequest,
      operation: { type: 'remove', itemId: 'item-idempotent' },
    })).rejects.toBeInstanceOf(FollowUpQueueIdempotencyError);

    let conflict;
    try {
      await mutate(core, sessionId, 0, 'stale-first-seen', {
        type: 'remove', itemId: 'item-idempotent',
      });
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(FollowUpQueueConflictError);
    expect(conflict.latestSnapshot).toMatchObject({ revision: 2 });
    expect(conflict.latestSnapshot.items[0]).toMatchObject({ status: 'queued' });
  });

  it('serializes each scope independently and does not block an unrelated session', async () => {
    let blockedTarget = null;
    let markBlocked;
    let releaseBlocked;
    const blocked = new Promise((resolve) => { markBlocked = resolve; });
    const release = new Promise((resolve) => { releaseBlocked = resolve; });
    const fsPromises = createFileSystem({
      rename: async (source, target) => {
        if (target === blockedTarget) {
          markBlocked();
          await release;
          const error = new Error('injected failure');
          error.code = 'EIO';
          throw error;
        }
        return fs.rename(source, target);
      },
    });
    const { core, rootDirectory } = await createHarness({ fsPromises });
    const firstSession = 'session-blocked';
    const secondSession = 'session-independent';
    const firstToken = (await core.load(firstSession)).scopeToken;
    blockedTarget = path.join(rootDirectory, `${firstToken}.json`);

    const failingMutation = mutate(core, firstSession, 0, 'blocked-write', {
      type: 'add', item: createItem('blocked'),
    });
    await blocked;
    const independentMutation = mutate(core, secondSession, 0, 'independent-write', {
      type: 'add', item: createItem('independent'),
    });
    const earlyOutcome = await Promise.race([
      independentMutation.then(() => 'fulfilled'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 500)),
    ]);
    releaseBlocked();

    await expect(failingMutation).rejects.toBeInstanceOf(FollowUpQueueWriteError);
    expect(earlyOutcome).toBe('fulfilled');
    await expect(independentMutation).resolves.toMatchObject({
      snapshot: { revision: 1, items: [{ id: 'item-independent' }] },
    });

    const thirdSession = 'session-fifo';
    const [first, second] = await Promise.all([
      mutate(core, thirdSession, 0, 'fifo-first', { type: 'add', item: createItem('first') }),
      mutate(core, thirdSession, 1, 'fifo-second', { type: 'add', item: createItem('second') }),
    ]);
    expect([first.mutationRevision, second.mutationRevision]).toEqual([1, 2]);
  });

  it('preserves the prior authority on atomic rename failure and recovers its FIFO', async () => {
    let failNextRename = false;
    const fsPromises = createFileSystem({
      rename: async (...args) => {
        if (failNextRename) {
          failNextRename = false;
          const error = new Error('injected failure');
          error.code = 'EIO';
          throw error;
        }
        return fs.rename(...args);
      },
    });
    const { core, rootDirectory } = await createHarness({ fsPromises });
    const sessionId = 'session-atomic';
    const initial = await mutate(core, sessionId, 0, 'atomic-initial', {
      type: 'add', item: createItem('initial'),
    });
    const filePath = path.join(rootDirectory, `${initial.snapshot.scopeToken}.json`);
    const authoritativeRaw = await fs.readFile(filePath, 'utf8');

    failNextRename = true;
    await expect(mutate(core, sessionId, 1, 'atomic-failed', {
      type: 'add', item: createItem('failed'),
    })).rejects.toBeInstanceOf(FollowUpQueueWriteError);
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe(authoritativeRaw);
    expect((await fs.readdir(rootDirectory)).filter((name) => name.includes('.tmp-'))).toEqual([]);
    await expect(core.load(sessionId)).resolves.toEqual(initial.snapshot);

    const recovered = await mutate(core, sessionId, 1, 'atomic-recovered', {
      type: 'add', item: createItem('recovered'),
    });
    expect(recovered).toMatchObject({ applied: true, mutationRevision: 2 });
  });

  it('enforces exclusive host claims, expiry replacement, release, and completion', async () => {
    let timestamp = 1_000;
    const { core } = await createHarness({ now: () => timestamp });
    const sessionId = 'session-claims';
    const queuedItem = createItem('claimable', {
      status: 'queued',
      sendConfig: {
        providerID: 'provider-claim',
        modelID: 'model-claim',
        agent: 'agent-claim',
        variant: 'variant-claim',
      },
    });
    await mutate(core, sessionId, 0, 'claim-add', { type: 'add', item: queuedItem });

    const firstClaim = await mutate(core, sessionId, 1, 'claim-first', {
      type: 'claim', itemId: queuedItem.id, claimId: 'claim-client-a', mode: 'auto',
    });
    expect(firstClaim).toMatchObject({ applied: true, mutationRevision: 2 });
    expect(firstClaim.snapshot.items[0]).toMatchObject({
      messageId: queuedItem.messageId,
      claim: { id: 'claim-client-a', expiresAt: 121_000 },
    });

    timestamp = 2_000;
    const blockedClaim = await mutate(core, sessionId, 2, 'claim-blocked', {
      type: 'claim', itemId: queuedItem.id, claimId: 'claim-client-b', mode: 'manual',
    });
    expect(blockedClaim).toMatchObject({ applied: false, mutationRevision: null });
    expect(blockedClaim.snapshot.items[0].claim.id).toBe('claim-client-a');

    timestamp = 121_000;
    const replacement = await mutate(core, sessionId, 2, 'claim-after-expiry', {
      type: 'claim', itemId: queuedItem.id, claimId: 'claim-client-b', mode: 'auto',
    });
    expect(replacement).toMatchObject({ applied: true, mutationRevision: 3 });
    expect(replacement.snapshot.items[0].claim).toEqual({ id: 'claim-client-b', expiresAt: 241_000 });

    const oldComplete = await mutate(core, sessionId, 3, 'complete-old-claim', {
      type: 'complete', itemId: queuedItem.id, claimId: 'claim-client-a',
    });
    expect(oldComplete).toMatchObject({ applied: false, mutationRevision: null });
    const released = await mutate(core, sessionId, 3, 'release-current', {
      type: 'release', itemId: queuedItem.id, claimId: 'claim-client-b', status: 'staged',
    });
    expect(released).toMatchObject({ applied: true, mutationRevision: 4 });
    expect(released.snapshot.items[0]).not.toHaveProperty('claim');
    expect(released.snapshot.items[0]).toMatchObject({
      messageId: queuedItem.messageId,
      status: 'staged',
      sendConfig: queuedItem.sendConfig,
    });

    const ineligibleAuto = await mutate(core, sessionId, 4, 'claim-auto-staged', {
      type: 'claim', itemId: queuedItem.id, claimId: 'claim-client-c', mode: 'auto',
    });
    expect(ineligibleAuto).toMatchObject({ applied: false, mutationRevision: null });
    const manualClaim = await mutate(core, sessionId, 4, 'claim-manual-staged', {
      type: 'claim', itemId: queuedItem.id, claimId: 'claim-client-c', mode: 'manual',
    });
    expect(manualClaim).toMatchObject({ applied: true, mutationRevision: 5 });
    const completed = await mutate(core, sessionId, 5, 'complete-current', {
      type: 'complete', itemId: queuedItem.id, claimId: 'claim-client-c',
    });
    expect(completed).toMatchObject({ applied: true, mutationRevision: 6 });
    expect(completed.snapshot.items).toEqual([]);
  });

  it('assigns a durable message ID on first claim and keeps it across response loss and release', async () => {
    let generated = 0;
    const { core } = await createHarness({
      createMessageId: () => `msg_${String(++generated).padStart(12, '0')}${'H'.repeat(14)}`,
    });
    const sessionId = 'session-deferred-message-id';
    const first = createItem('deferred-one', { messageId: null, status: 'queued' });
    const second = createItem('deferred-two', { messageId: null, status: 'queued' });
    await mutate(core, sessionId, 0, 'deferred-add-one', { type: 'add', item: first });
    await mutate(core, sessionId, 1, 'deferred-add-two', { type: 'add', item: second });

    const request = {
      type: 'claim', itemId: first.id, claimId: 'claim-deferred-one', mode: 'auto',
    };
    const claimed = await mutate(core, sessionId, 2, 'deferred-claim', request);
    expect(claimed.snapshot.items[0].messageId).toBe(`msg_${'1'.padStart(12, '0')}${'H'.repeat(14)}`);

    const replayed = await mutate(core, sessionId, 2, 'deferred-claim', request);
    expect(replayed.deduplicated).toBe(true);
    expect(replayed.snapshot.items[0].messageId).toBe(claimed.snapshot.items[0].messageId);
    expect(generated).toBe(1);

    const released = await mutate(core, sessionId, 3, 'deferred-release', {
      type: 'release', itemId: first.id, claimId: 'claim-deferred-one', status: 'staged',
    });
    const reclaimed = await mutate(core, sessionId, 4, 'deferred-reclaim', {
      type: 'claim', itemId: first.id, claimId: 'claim-deferred-two', mode: 'manual',
    });
    expect(released.snapshot.items[0].messageId).toBe(claimed.snapshot.items[0].messageId);
    expect(reclaimed.snapshot.items[0].messageId).toBe(claimed.snapshot.items[0].messageId);
    expect(generated).toBe(1);
  });

  it('writes a terminal tombstone and records later public mutations without revival', async () => {
    const { core, rootDirectory } = await createHarness();
    const sessionId = 'session-terminal';
    await mutate(core, sessionId, 0, 'terminal-add', { type: 'add', item: createItem('terminal') });
    const terminal = await core.terminalizeSession(sessionId, 'host-terminal');
    expect(terminal).toMatchObject({
      applied: true,
      mutationRevision: 2,
      snapshot: { revision: 2, items: [] },
    });

    const delayedRequest = {
      sessionId,
      baseRevision: 2,
      clientMutationId: 'delayed-public-add',
      operation: { type: 'add', item: createItem('delayed') },
    };
    const delayed = await core.applyMutation(delayedRequest);
    expect(delayed).toMatchObject({
      applied: false,
      deduplicated: false,
      mutationRevision: null,
      snapshot: { revision: 2, items: [] },
    });
    await expect(core.applyMutation(delayedRequest)).resolves.toMatchObject({
      applied: false,
      deduplicated: true,
      mutationRevision: null,
    });
    await expect(mutate(core, sessionId, 1, 'terminal-stale-base', {
      type: 'add', item: createItem('stale'),
    })).rejects.toBeInstanceOf(FollowUpQueueConflictError);
    await expect(mutate(core, sessionId, 2, 'untrusted-terminal', {
      type: 'terminalize',
    })).rejects.toBeInstanceOf(FollowUpQueueValidationError);

    const envelope = JSON.parse(await fs.readFile(
      path.join(rootDirectory, `${terminal.snapshot.scopeToken}.json`),
      'utf8',
    ));
    expect(envelope).toMatchObject({ terminal: true, revision: 2, items: [] });

    const restarted = createFollowUpQueueCore({
      fsPromises: createFileSystem(),
      path,
      rootDirectory,
      createTempId: () => 'restart',
    });
    await expect(restarted.load(sessionId)).resolves.toEqual(delayed.snapshot);
  });

  it('replaces a corrupt queue with a terminal tombstone after authoritative deletion', async () => {
    const { core, rootDirectory } = await createHarness();
    const sessionId = 'session-corrupt-delete';
    const token = createHash('sha256')
      .update(JSON.stringify({ kind: 'session', sessionId }))
      .digest('hex');
    await fs.mkdir(rootDirectory, { recursive: true });
    await fs.writeFile(path.join(rootDirectory, `${token}.json`), '{', 'utf8');

    const result = await core.terminalizeSession(sessionId, 'terminal-corrupt');

    expect(result).toMatchObject({ applied: true, snapshot: { revision: 1, items: [] } });
    await expect(core.load(sessionId)).resolves.toMatchObject({ revision: 1, items: [] });

    const parseableSessionId = 'session-parseable-corrupt-delete';
    const first = await mutate(core, parseableSessionId, 0, 'parseable-add-one', {
      type: 'add', item: createItem('parseable-one'),
    });
    await mutate(core, parseableSessionId, 1, 'parseable-add-two', {
      type: 'add', item: createItem('parseable-two'),
    });
    const parseablePath = path.join(rootDirectory, `${first.snapshot.scopeToken}.json`);
    const parseable = JSON.parse(await fs.readFile(parseablePath, 'utf8'));
    parseable.items[1].messageId = parseable.items[0].messageId;
    await fs.writeFile(parseablePath, JSON.stringify(parseable), 'utf8');

    const preserved = await core.terminalizeSession(parseableSessionId, 'terminal-parseable-corrupt');
    expect(preserved).toMatchObject({ applied: true, snapshot: { revision: 3, items: [] } });
  });

  it('rejects malformed authority and bounds the persisted idempotency ledger', async () => {
    const { core, rootDirectory } = await createHarness({ dedupeLimit: 2 });
    const sessionId = 'session-corruption';
    const added = await mutate(core, sessionId, 0, 'ledger-one', {
      type: 'add', item: createItem('one'),
    });
    await mutate(core, sessionId, 1, 'ledger-two', {
      type: 'add', item: createItem('two'),
    });
    await mutate(core, sessionId, 2, 'ledger-three', {
      type: 'remove', itemId: 'missing-item',
    });
    const filePath = path.join(rootDirectory, `${added.snapshot.scopeToken}.json`);
    const stored = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(stored.recentMutations.map((record) => record.clientMutationId)).toEqual([
      'ledger-two',
      'ledger-three',
    ]);

    stored.items[1].messageId = stored.items[0].messageId;
    await fs.writeFile(filePath, JSON.stringify(stored), 'utf8');
    await expect(core.load(sessionId)).rejects.toBeInstanceOf(FollowUpQueueCorruptError);

    const oversizedCore = createFollowUpQueueCore({
      fsPromises: createFileSystem({
        stat: async () => ({ size: (64 * 1024 * 1024) + 1 }),
      }),
      path,
      rootDirectory,
    });
    await expect(oversizedCore.load('session-oversized')).rejects.toBeInstanceOf(FollowUpQueueCorruptError);
  });
});
