import { describe, expect, test } from 'bun:test';

import type { FollowUpQueueSnapshot } from '@/lib/api/types';
import {
  FOLLOW_UP_QUEUE_CLAIM_TTL_MS,
  applyFollowUpQueueOperation,
  parseFollowUpQueueMutationResult,
  parseFollowUpQueueSnapshot,
} from './followUpQueue';

const snapshot = (): FollowUpQueueSnapshot => ({
  scopeToken: 'a'.repeat(64),
  revision: 1,
  items: [{
    id: 'item-one',
    messageId: 'msg_000000000001ABCDEFGHIJKLMN',
    content: 'follow up',
    attachments: [{
      id: 'attachment-one',
      dataUrl: 'data:text/plain;base64,dGVzdA==',
      mimeType: 'text/plain',
      filename: 'a.txt',
      size: 4,
      source: 'local',
    }],
    createdAt: 10,
    status: 'queued',
  }],
});

describe('follow-up queue protocol parsing', () => {
  test('round-trips the strict snapshot and mutation result', () => {
    const parsed = parseFollowUpQueueSnapshot(snapshot());
    expect(parsed).toEqual(snapshot());
    expect(parseFollowUpQueueMutationResult({
      snapshot: parsed,
      applied: true,
      deduplicated: false,
      mutationRevision: 2,
    }).snapshot.items[0].attachments?.[0].filename).toBe('a.txt');
  });

  test('rejects browser File fields, unknown fields, and duplicate identities', () => {
    const withFile = snapshot();
    (withFile.items[0].attachments?.[0] as unknown as Record<string, unknown>).file = {};
    expect(() => parseFollowUpQueueSnapshot(withFile)).toThrow();

    const withUnknown = { ...snapshot(), unexpected: true };
    expect(() => parseFollowUpQueueSnapshot(withUnknown)).toThrow();

    const duplicate = snapshot();
    duplicate.items.push({ ...duplicate.items[0] });
    expect(() => parseFollowUpQueueSnapshot(duplicate)).toThrow();
  });
});

describe('follow-up queue semantic replay', () => {
  test('applies status, move, remove, and add intents without changing the authoritative revision', () => {
    let current = snapshot();
    current = applyFollowUpQueueOperation(current, {
      type: 'add',
      item: {
        id: 'item-two',
        messageId: 'msg_000000000002ABCDEFGHIJKLMN',
        content: 'second',
        createdAt: 11,
        status: 'staged',
      },
    }).snapshot;
    current = applyFollowUpQueueOperation(current, {
      type: 'set-status',
      itemId: 'item-two',
      status: 'queued',
    }).snapshot;
    current = applyFollowUpQueueOperation(current, {
      type: 'move',
      itemId: 'item-two',
      beforeId: 'item-one',
    }).snapshot;
    current = applyFollowUpQueueOperation(current, { type: 'remove', itemId: 'item-one' }).snapshot;

    expect(current.revision).toBe(1);
    expect(current.items.map((item) => `${item.id}:${item.status}`)).toEqual(['item-two:queued']);
  });

  test('blocks an unexpired competing claim and permits replacement after expiry', () => {
    const first = applyFollowUpQueueOperation(snapshot(), {
      type: 'claim',
      itemId: 'item-one',
      claimId: 'claim-one',
      mode: 'auto',
    }, { now: 100, claimExpiresAt: 100 + FOLLOW_UP_QUEUE_CLAIM_TTL_MS }).snapshot;
    const blocked = applyFollowUpQueueOperation(first, {
      type: 'claim',
      itemId: 'item-one',
      claimId: 'claim-two',
      mode: 'manual',
    }, { now: 101, claimExpiresAt: 101 + FOLLOW_UP_QUEUE_CLAIM_TTL_MS });
    expect(blocked.applied).toBe(false);
    expect(blocked.snapshot.items[0].claim?.id).toBe('claim-one');

    const replaced = applyFollowUpQueueOperation(first, {
      type: 'claim',
      itemId: 'item-one',
      claimId: 'claim-two',
      mode: 'manual',
    }, {
      now: 100 + FOLLOW_UP_QUEUE_CLAIM_TTL_MS + 1,
      claimExpiresAt: 100 + (2 * FOLLOW_UP_QUEUE_CLAIM_TTL_MS) + 1,
    });
    expect(replaced.applied).toBe(true);
    expect(replaced.snapshot.items[0].claim?.id).toBe('claim-two');
  });
});
