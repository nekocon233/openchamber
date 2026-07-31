import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = readFileSync(join(
  dirname(fileURLToPath(import.meta.url)),
  'ChatInput.tsx',
), 'utf8');

describe('ChatInput follow-up queue integration', () => {
  test('stages busy queue submissions instead of dispatching them to OpenCode', () => {
    const branchIndex = source.indexOf("if (delivery === 'queue')");
    const sendIndex = source.indexOf('const sendPromise = sendCapturedMessage(');
    expect(branchIndex).toBeGreaterThan(-1);
    expect(sendIndex).toBeGreaterThan(branchIndex);
    expect(source.slice(branchIndex, sendIndex)).toContain('await addToQueue(messageQueueTarget');
    expect(source.slice(branchIndex, sendIndex)).toContain("status: 'staged'");
    expect(source.slice(branchIndex, sendIndex)).toContain('additionalParts: additionalParts.map');
    expect(source.slice(branchIndex, sendIndex)).toContain('agentMentionName');
    expect(source.slice(branchIndex, sendIndex)).not.toContain('sendCapturedMessage(');
  });

  test('checks authoritative activity before treating an existing idle session as directly sendable', () => {
    const statusIndex = source.indexOf('await opencodeClient.getSessionStatusForDirectory(statusDirectory)');
    const deliveryIndex = source.indexOf('const useFollowUpDelivery = shouldUseFollowUpDelivery({');
    const sendIndex = source.indexOf('const sendPromise = sendCapturedMessage(');

    expect(statusIndex).toBeGreaterThan(-1);
    expect(deliveryIndex).toBeGreaterThan(statusIndex);
    expect(sendIndex).toBeGreaterThan(deliveryIndex);
    expect(source.slice(statusIndex, deliveryIndex)).toContain("statusSnapshot === null");
  });

  test('restores the explicit queue action and drains only unclaimed queued entries at idle', () => {
    expect(source).toContain('onQueueMessage={handleQueueMessage}');
    expect(source).toContain("void handleSubmitRef.current({ forceQueue: true });");
    expect(source).toContain("entry.status === 'queued' && isFollowUpQueueClaimAvailable(entry, now)");
    expect(source).toContain('nextExpiry - now + 1');
    expect(source).toContain("sendQueuedMessage(next.id, 'auto')");
    expect(source).toContain('hasPendingBlockingRequests');
    expect(source).toContain("claim.claimId, 'staged', claim.context");
    expect(source).not.toContain('QueuedMessagesDock');
  });

  test('drains the claimed payload through a post-claim runtime guard', () => {
    const drainStart = source.indexOf('const sendQueuedMessage = React.useCallback');
    const claimIndex = source.indexOf('await claimQueuedMessage(', drainStart);
    const runtimeCaptureIndex = source.indexOf('const expectedRuntime = {', claimIndex);
    const sendIndex = source.indexOf('await sendMessage(', runtimeCaptureIndex);
    const drainSource = source.slice(drainStart, source.indexOf('const handleQueuedMessageSend', drainStart));

    expect(claimIndex).toBeGreaterThan(drainStart);
    expect(runtimeCaptureIndex).toBeGreaterThan(claimIndex);
    expect(sendIndex).toBeGreaterThan(runtimeCaptureIndex);
    expect(drainSource).toContain('const queuedItem = claim.item');
    expect(drainSource).toContain('queuedItem.agentMentionName');
    expect(drainSource).toContain('queuedItem.additionalParts');
    expect(drainSource).toContain('expectedRuntime.runtimeKey !== messageQueueTarget.runtimeKey');
    expect(drainSource).toContain('expectedRuntime,');
    expect(drainSource).toContain("releaseQueuedMessage(messageQueueTarget, messageId, claim.claimId, 'staged', claim.context)");
  });

  test('restores extended queue payload when editing an item back into the composer', () => {
    const editStart = source.indexOf('const handleQueuedMessageEdit = React.useCallback');
    const editEnd = source.indexOf('const [queueLeaseEpoch', editStart);
    const editSource = source.slice(editStart, editEnd);

    expect(editSource).toContain('queuedMessage.agentMentionName');
    expect(editSource).toContain('queuedMessage.additionalParts');
    expect(editSource).toContain('queuedMessage.attachments');
    expect(editSource).toContain('setPendingSyntheticParts');
  });
});
