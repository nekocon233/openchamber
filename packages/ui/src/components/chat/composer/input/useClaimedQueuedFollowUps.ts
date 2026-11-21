import { useEffect, useRef, useState } from 'react';
import { getQueuedAutoSendRetryDelayMs, sendClaimedFollowUp } from '@/hooks/useQueuedMessageAutoSend';
import { isNativeSessionId } from '@/lib/native-agents/ids';
import { getMessageQueueKey, isServerOwnedMessageQueue, type MessageQueueTarget, type QueuedMessage } from '@/stores/messageQueueStore';

export function useClaimedQueuedFollowUps(
    target: MessageQueueTarget | null,
    messages: readonly QueuedMessage[],
    ready: boolean,
) {
    const item = ready && target && (isNativeSessionId(target.sessionId) || isServerOwnedMessageQueue(target))
        ? messages.find((entry) => entry.deliveryOwner !== 'server' && entry.status === 'queued'
            && !entry.claim?.id.startsWith('host-import-')) : undefined;
    const itemKey = target && item ? JSON.stringify([getMessageQueueKey(target), item.id]) : null;
    const currentTarget = useRef<string | null>(null);
    useEffect(() => {
        currentTarget.current = itemKey;
        return () => { currentTarget.current = null; };
    }, [itemKey]);
    const active = useRef<string | null>(null);
    const retry = useRef({ key: '', attempts: 0, at: 0 });
    const [wake, setWake] = useState(0);
    useEffect(() => {
        if (!item || !itemKey || !target || active.current === itemKey) return;
        const deadline = Math.max(item.claim?.expiresAt ?? 0, retry.current.key === itemKey ? retry.current.at : 0);
        const delay = deadline - Date.now();
        if (delay > 0) {
            const timer = setTimeout(() => setWake((value) => value + 1), delay);
            return () => clearTimeout(timer);
        }
        active.current = itemKey;
        void sendClaimedFollowUp(target, item.id, 'auto', () => currentTarget.current === itemKey).catch(() => false).then((sent) => {
            if (active.current !== itemKey) return;
            active.current = null;
            const attempts = sent ? 0 : retry.current.key === itemKey ? retry.current.attempts + 1 : 1;
            retry.current = { key: itemKey, attempts, at: sent ? 0 : Date.now() + getQueuedAutoSendRetryDelayMs(attempts) };
            setWake((value) => value + 1);
        });
    }, [item, itemKey, target, wake]);
}
