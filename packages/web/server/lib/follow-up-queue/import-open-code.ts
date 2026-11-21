import { createHash, randomUUID } from 'node:crypto';
import { parseQueuedItemInput, type createMessageQueueRuntime, type QueuedContextPart } from '../message-queue/runtime.js';
import type { createFollowUpQueueServerRuntime } from './server-runtime.js';
import { FollowUpQueueConflictError } from './errors.js';

type FollowUpQueue = Pick<ReturnType<typeof createFollowUpQueueServerRuntime>, 'load' | 'applyMutation'>;
type MessageQueue = Pick<ReturnType<typeof createMessageQueueRuntime>, 'enqueue'>;

export async function importOpenCodeFollowUps(
  followUps: FollowUpQueue,
  queue: MessageQueue,
  sessionId: string,
  directory: string,
): Promise<boolean> {
  let snapshot = await followUps.load(sessionId);
  let pending = false;
  for (const item of snapshot.items) {
    const key = createHash('sha256').update(JSON.stringify([sessionId, item.id])).digest('hex');
    const claimId = `host-import-${key}`;
    if (item.status !== 'queued' || (item.messageId !== null && item.claim?.id !== claimId)) continue;
    if (!item.sendConfig || item.additionalParts?.some((part) => part.attachments?.length)) continue;
    const context: QueuedContextPart[] = (item.additionalParts ?? []).map((part) => (
      part.metadata ? { kind: 'context', text: part.text, metadata: { ...part.metadata } }
        : { kind: 'synthetic', text: part.text }
    ));
    let input;
    try {
      input = parseQueuedItemInput({
        content: item.content,
        text: item.content,
        agentMention: item.agentMentionName,
        attachments: item.attachments,
        context,
        sendConfig: item.sendConfig,
        goal: item.goal,
      });
    } catch (error) {
      if (error instanceof TypeError) continue;
      throw error;
    }
    try {
      const claim = await followUps.applyMutation({
        sessionId,
        baseRevision: snapshot.revision,
        clientMutationId: randomUUID(),
        operation: { type: 'claim', itemId: item.id, claimId, mode: 'auto' },
      });
      snapshot = claim.snapshot;
      if (!snapshot.items.some((entry) => entry.id === item.id && entry.claim?.id === claimId)) continue;

      await queue.enqueue(sessionId, directory, input, claimId);
      for (let conflicts = 0; conflicts < 8; conflicts += 1) {
        try {
          const completed = await followUps.applyMutation({
            sessionId,
            baseRevision: snapshot.revision,
            clientMutationId: randomUUID(),
            operation: { type: 'complete', itemId: item.id, claimId },
          });
          snapshot = completed.snapshot;
        } catch (error) {
          if (!(error instanceof FollowUpQueueConflictError)) throw error;
          snapshot = error.latestSnapshot;
        }
        if (!snapshot.items.some((entry) => entry.id === item.id)) break;
      }
      if (snapshot.items.some((entry) => entry.id === item.id)) pending = true;
    } catch (error) {
      pending = true;
      if (error instanceof FollowUpQueueConflictError) snapshot = error.latestSnapshot;
      else break;
    }
  }
  return !pending;
}
