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
    expect(source.slice(branchIndex, sendIndex)).not.toContain('sendCapturedMessage(');
  });

  test('restores the explicit queue action and drains only unclaimed queued entries at idle', () => {
    expect(source).toContain('onQueueMessage={handleQueueMessage}');
    expect(source).toContain("void handleSubmitRef.current({ forceQueue: true });");
    expect(source).toContain("entry.status === 'queued' && !entry.claim");
    expect(source).toContain("sendQueuedMessage(next.id, 'auto')");
    expect(source).toContain('hasPendingBlockingRequests');
    expect(source).toContain("claim.claimId, 'staged', claim.context");
    expect(source).not.toContain('QueuedMessagesDock');
  });
});
