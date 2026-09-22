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
    expect(source.slice(branchIndex, sendIndex)).toContain('part.attachments');
    expect(source.slice(branchIndex, sendIndex)).toContain('part.metadata');
    expect(source.slice(branchIndex, sendIndex)).toContain('agentMentionName');
    expect(source.slice(branchIndex, sendIndex)).toContain('providerID: providerIdToSend');
    expect(source.slice(branchIndex, sendIndex)).toContain('modelID: modelIdToSend');
    expect(source.slice(branchIndex, sendIndex)).toContain('agent: agentNameToSend');
    expect(source.slice(branchIndex, sendIndex)).toContain('variant: variantToSend');
    expect(source.slice(branchIndex, sendIndex)).not.toContain('sendCapturedMessage(');
  });

  test('ordinary submissions never consume or assemble existing queue items', () => {
    const submitStart = source.indexOf('const handleSubmit = async');
    const submitEnd = source.indexOf('await handledSendPromise;', submitStart);
    expect(submitStart).toBeGreaterThan(-1);
    expect(submitEnd).toBeGreaterThan(submitStart);
    const submitSource = source.slice(submitStart, submitEnd);

    for (const legacyQueueRead of ['takeForSend', 'queuedOnly', 'queuedMessageId', 'queuedProjection', 'queuedMessagesToSend']) {
      expect(submitSource).not.toContain(legacyQueueRead);
    }
    expect(submitSource).not.toContain('claimQueuedMessage(');
    expect(submitSource).not.toContain('queued:');
    expect(submitSource).toContain('composerText: inputSnapshot.message');
    expect(submitSource).toContain('queuedMessages: []');
  });

  test('an empty composer cannot send the waiting queue through the main submit action', () => {
    const canSendSource = source.slice(source.indexOf('const canSend ='), source.indexOf('const canAbort ='));
    expect(canSendSource).toContain('hasContent');
    expect(canSendSource).not.toContain('hasQueuedMessages');
    expect(source).toContain('if (!inputSnapshot.hasContent || (!currentSessionId && !newSessionDraftOpen))');
  });

  test('checks authoritative activity before treating an existing idle session as directly sendable', () => {
    const statusIndex = source.indexOf('await opencodeClient.getSessionStatusForDirectory(statusDirectory)');
    const decisionIndex = source.indexOf('const deliveryDecision = resolveFollowUpDeliveryDecision({');
    const sendIndex = source.indexOf('const sendPromise = sendCapturedMessage(');

    expect(statusIndex).toBeGreaterThan(-1);
    expect(decisionIndex).toBeGreaterThan(statusIndex);
    expect(sendIndex).toBeGreaterThan(decisionIndex);
    expect(source.slice(statusIndex, decisionIndex)).toContain("statusSnapshot === null");
  });

  test('restores input instead of staging when authoritative activity is unavailable', () => {
    const unavailableIndex = source.indexOf('authoritativeSessionPhase === null');
    const consumeIndex = source.indexOf('const syntheticParts = isBtwActive ? [] : consumePendingSyntheticParts();');

    expect(unavailableIndex).toBeGreaterThan(-1);
    expect(consumeIndex).toBeGreaterThan(unavailableIndex);
    const unavailableSource = source.slice(unavailableIndex, consumeIndex);
    expect(unavailableSource).toContain('restoreExplicitInput()');
    expect(unavailableSource).toContain("toast.error(t('chat.chatInput.toast.sessionStatusUnavailable'))");
    expect(unavailableSource).not.toContain('consumePendingSyntheticParts()');
    expect(unavailableSource).not.toContain('consumeDrafts(');
    expect(unavailableSource).not.toContain('clearAttachedFiles()');
    expect(unavailableSource).not.toContain('addToQueue(');
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

  test('keeps shell, known slash commands, and auto-review out of queue admission', () => {
    const autoReviewIndex = source.indexOf('if (autoReviewRunning || isAutoReviewRunningNow())');
    const consumeIndex = source.indexOf('const syntheticParts = isBtwActive ? [] : consumePendingSyntheticParts();');
    const slashIndex = source.indexOf("const parsedCommand = inputMode === 'normal'");
    const queueIndex = source.indexOf("if (delivery === 'queue')");
    const forceQueueIndex = source.indexOf("options?.forceQueue === true && inputMode === 'normal'");

    expect(autoReviewIndex).toBeGreaterThan(-1);
    expect(autoReviewIndex).toBeLessThan(consumeIndex);
    expect(slashIndex).toBeGreaterThan(consumeIndex);
    expect(slashIndex).toBeLessThan(queueIndex);
    expect(forceQueueIndex).toBeGreaterThan(-1);
    expect(forceQueueIndex).toBeLessThan(queueIndex);
  });
});
