import { describe, expect, test, beforeEach } from 'bun:test';
import { useMessageQueueStore } from './messageQueueStore';

describe('messageQueueStore staged/queued status', () => {
    beforeEach(() => {
        useMessageQueueStore.setState({ queuedMessages: {} });
    });

    test('addToQueue defaults status to staged', () => {
        useMessageQueueStore.getState().addToQueue('s1', { content: 'hello' });
        const [item] = useMessageQueueStore.getState().queuedMessages.s1;
        expect(item.status).toBe('staged');
    });

    test('setQueuedStatus marks an item queued and back to staged', () => {
        useMessageQueueStore.getState().addToQueue('s1', { content: 'hello' });
        const [item] = useMessageQueueStore.getState().queuedMessages.s1;

        useMessageQueueStore.getState().setQueuedStatus('s1', item.id, 'queued');
        expect(useMessageQueueStore.getState().queuedMessages.s1[0].status).toBe('queued');

        useMessageQueueStore.getState().setQueuedStatus('s1', item.id, 'staged');
        expect(useMessageQueueStore.getState().queuedMessages.s1[0].status).toBe('staged');
    });

    test('setQueuedStatus ignores unknown sessions and messages', () => {
        useMessageQueueStore.getState().addToQueue('s1', { content: 'hello' });
        const before = useMessageQueueStore.getState().queuedMessages;

        useMessageQueueStore.getState().setQueuedStatus('unknown', 'missing', 'queued');
        useMessageQueueStore.getState().setQueuedStatus('s1', 'missing', 'queued');

        expect(useMessageQueueStore.getState().queuedMessages).toBe(before);
    });

    test('status transitions do not drop sendConfig or attachments', () => {
        useMessageQueueStore.getState().addToQueue('s1', {
            content: 'hello',
            sendConfig: { providerID: 'p', modelID: 'm', agent: 'a', variant: 'v' },
        });
        const [item] = useMessageQueueStore.getState().queuedMessages.s1;

        useMessageQueueStore.getState().setQueuedStatus('s1', item.id, 'queued');
        const updated = useMessageQueueStore.getState().queuedMessages.s1[0];
        expect(updated.sendConfig).toEqual({ providerID: 'p', modelID: 'm', agent: 'a', variant: 'v' });
        expect(updated.content).toBe('hello');
    });
});
