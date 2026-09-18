import React, { memo } from 'react';
import {
    DndContext,
    MouseSensor,
    TouchSensor,
    useSensor,
    useSensors,
    closestCenter,
    type DragEndEvent,
} from '@dnd-kit/core';
import {
    SortableContext,
    useSortable,
    verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { getMessageQueueKey, useMessageQueueStore, type MessageQueueTarget, type QueuedMessage } from '@/stores/messageQueueStore';
import { useUIStore } from '@/stores/useUIStore';
import { ComposerFloatingPanel } from './composer/ui/ComposerFloatingPanel';
import { useI18n } from '@/lib/i18n';
import { Icon } from "@/components/icon/Icon";
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface QueuedMessageChipProps {
    message: QueuedMessage;
    sendingMessageId: string | null;
    target: MessageQueueTarget;
    onEdit: (message: QueuedMessage) => void;
    onQueue: (message: QueuedMessage) => void;
    onSend: (message: QueuedMessage) => void;
}

const QueuedMessageChip = memo(({ message, target, sendingMessageId, onEdit, onQueue, onSend }: QueuedMessageChipProps) => {
    const { t } = useI18n();
    const removeFromQueue = useMessageQueueStore((state) => state.removeFromQueue);
    const setQueuedStatus = useMessageQueueStore((state) => state.setQueuedStatus);
    const isSending = sendingMessageId === message.id;
    const isQueued = message.status === 'queued';
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
        id: message.id,
        disabled: isSending,
    });

    // Get first line of message, truncated
    const firstLine = React.useMemo(() => {
        const lines = message.content.split('\n');
        const first = lines[0] || '';
        const maxLength = 100;
        if (first.length > maxLength) {
            return first.substring(0, maxLength) + '...';
        }
        return first + (lines.length > 1 ? '...' : '');
    }, [message.content]);

    const attachmentCount = message.attachments?.length ?? 0;

    return (
        <div
            ref={setNodeRef}
            // Translate only (no scaleX/scaleY) so the lifted row keeps its size.
            style={{ transform: CSS.Translate.toString(transform), transition }}
            className={cn(
                'relative flex min-w-0 flex-col gap-1 py-1.5 min-[360px]:block md:flex md:flex-row md:items-center md:gap-2 md:py-1',
                isDragging && 'z-10 opacity-60',
            )}
            aria-busy={isSending}
        >
            <div className="flex min-w-0 items-center gap-1.5 md:contents">
                <button
                    type="button"
                    disabled={isSending}
                    {...attributes}
                    {...listeners}
                    className="flex size-11 flex-shrink-0 cursor-grab touch-none select-none items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-[var(--interactive-hover)] hover:text-foreground active:cursor-grabbing disabled:cursor-default disabled:opacity-40 md:size-auto md:rounded-none md:hover:bg-transparent"
                    aria-label={t('chat.queuedMessage.reorderAria')}
                >
                    <Icon name="draggable" className="h-4 w-4" aria-hidden="true" />
                </button>
                <div className={cn(
                    'flex min-h-11 min-w-0 flex-1 flex-col justify-center md:contents md:min-h-0 md:pr-0',
                    isQueued ? 'min-[360px]:pr-[9.5rem]' : 'min-[360px]:pr-[6.25rem]',
                )}>
                    <span className="line-clamp-2 min-w-0 [overflow-wrap:anywhere] typography-ui-label text-foreground md:line-clamp-1 md:flex-1">
                        {firstLine || t('chat.queuedMessage.empty')}
                        {attachmentCount > 0 && (
                            <span className="ml-1 text-muted-foreground">{t('chat.queuedMessage.attachments', { count: attachmentCount })}</span>
                        )}
                    </span>
                    {isQueued && (
                        <span className="mt-1 inline-flex w-fit rounded-full bg-[var(--interactive-hover)] px-2 py-0.5 typography-micro text-muted-foreground md:hidden">
                            {t('chat.queuedMessage.queued')}
                        </span>
                    )}
                </div>
                {isQueued && (
                    <span className="hidden flex-shrink-0 rounded-full bg-[var(--interactive-hover)] px-2 py-0.5 typography-ui-label text-muted-foreground md:inline-flex">
                        {t('chat.queuedMessage.queued')}
                    </span>
                )}
                <button
                    type="button"
                    disabled={isSending}
                    onClick={() => removeFromQueue(target, message.id)}
                    className="flex size-11 flex-shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-[var(--interactive-hover)] disabled:opacity-40 md:hidden"
                    aria-label={t('chat.queuedMessage.removeAria')}
                >
                    <Icon name="delete-bin" className="h-4 w-4 text-muted-foreground" />
                </button>
            </div>
            <div className={cn(
                'flex min-w-0 justify-end gap-1.5 px-[3.25rem] min-[360px]:absolute min-[360px]:right-[3.25rem] min-[360px]:top-1/2 min-[360px]:-translate-y-1/2 min-[360px]:px-0 md:static md:ml-auto md:translate-y-0 md:flex-nowrap md:px-0',
            )}>
                <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="h-11 min-w-14 shrink overflow-hidden px-3 min-[360px]:w-11 min-[360px]:min-w-11 min-[360px]:px-0 md:h-6 md:w-auto md:min-w-0 md:shrink-0 md:px-2"
                    disabled={isSending}
                    onClick={() => onEdit(message)}
                >
                    <Icon name="edit" className="h-4 w-4 md:h-3 md:w-3" aria-hidden="true" />
                    <span className="truncate min-[360px]:sr-only md:not-sr-only">{t('chat.queuedMessage.edit')}</span>
                </Button>
                {isQueued ? (
                    <>
                        <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            className="h-11 min-w-14 shrink overflow-hidden px-3 min-[360px]:w-11 min-[360px]:min-w-11 min-[360px]:px-0 md:h-6 md:w-auto md:min-w-0 md:shrink-0 md:px-2"
                            disabled={sendingMessageId !== null}
                            onClick={() => setQueuedStatus(target, message.id, 'staged')}
                        >
                            <Icon name="close-circle" className="h-4 w-4 md:h-3 md:w-3" aria-hidden="true" />
                            <span className="truncate min-[360px]:sr-only md:not-sr-only">{t('chat.queuedMessage.unqueue')}</span>
                        </Button>
                        <Button
                            type="button"
                            variant="secondary"
                            size="xs"
                            className="h-11 min-w-14 shrink overflow-hidden px-3 min-[360px]:w-11 min-[360px]:min-w-11 min-[360px]:px-0 md:h-6 md:w-auto md:min-w-0 md:shrink-0 md:px-2"
                            disabled={sendingMessageId !== null}
                            onClick={() => onSend(message)}
                        >
                            <Icon name={isSending ? 'loader-4' : 'send-plane'} className={cn('h-4 w-4 md:h-3 md:w-3', isSending && 'animate-spin')} aria-hidden="true" />
                            <span className="truncate min-[360px]:sr-only md:not-sr-only">{t('chat.queuedMessage.send')}</span>
                        </Button>
                    </>
                ) : (
                    <Button
                        type="button"
                        variant="secondary"
                        size="xs"
                        className="h-11 min-w-14 shrink overflow-hidden px-3 min-[360px]:w-11 min-[360px]:min-w-11 min-[360px]:px-0 md:h-6 md:w-auto md:min-w-0 md:shrink-0 md:px-2"
                        disabled={sendingMessageId !== null}
                        onClick={() => onQueue(message)}
                    >
                        <Icon name="time" className="h-4 w-4 md:h-3 md:w-3" aria-hidden="true" />
                        <span className="truncate min-[360px]:sr-only md:not-sr-only">{t('chat.queuedMessage.queue')}</span>
                    </Button>
                )}
                <button
                    type="button"
                    disabled={isSending}
                    onClick={() => removeFromQueue(target, message.id)}
                    className="hidden size-6 flex-shrink-0 items-center justify-center rounded-full transition-colors hover:bg-[var(--interactive-hover)] disabled:opacity-40 md:flex"
                    aria-label={t('chat.queuedMessage.removeAria')}
                >
                    <Icon name="close" className="h-4 w-4 text-muted-foreground" />
                </button>
            </div>
        </div>
    );
});

QueuedMessageChip.displayName = 'QueuedMessageChip';

interface QueuedMessageChipsProps {
    target: MessageQueueTarget | null;
    hidden?: boolean;
    onEditMessage: (message: QueuedMessage) => void;
    onQueueMessage: (messageId: string) => void;
    onSendMessage: (messageId: string) => void;
    sendingMessageId: string | null;
}

const EMPTY_QUEUE: QueuedMessage[] = [];

export const QueuedMessageChips = memo(({ target, hidden = false, onEditMessage, onQueueMessage, onSendMessage, sendingMessageId }: QueuedMessageChipsProps) => {
    const { t } = useI18n();
    // One shared preference, so the list stays open (or closed) across
    // session switches instead of resetting with the queue key.
    const collapsed = !useUIStore((state) => state.messageQueueExpanded);
    const setMessageQueueExpanded = useUIStore((state) => state.setMessageQueueExpanded);
    const bodyId = React.useId();
    const queueKey = target ? getMessageQueueKey(target) : null;
    const queuedMessages = useMessageQueueStore(
        React.useCallback(
            (state) => {
                if (!queueKey) return EMPTY_QUEUE;
                return state.queuedMessages[queueKey] ?? EMPTY_QUEUE;
            },
            [queueKey]
        )
    );
    const popToInput = useMessageQueueStore((state) => state.popToInput);
    const reorderQueue = useMessageQueueStore((state) => state.reorderQueue);

    const sensors = useSensors(
        // Desktop: drag after a small move so other clicks still register.
        useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
        // Touch: long-press to drag (tap still hits buttons, swipe scrolls).
        useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    );

    const handleDragEnd = React.useCallback((event: DragEndEvent) => {
        const { active, over } = event;
        if (!over || active.id === over.id || !target) return;
        reorderQueue(target, String(active.id), String(over.id));
    }, [target, reorderQueue]);

    const handleEdit = React.useCallback((message: QueuedMessage) => {
        if (!target) return;

        const popped = popToInput(target, message.id);
        if (popped) {
            onEditMessage(popped);
        }
    }, [target, popToInput, onEditMessage]);

    const handleQueue = React.useCallback((message: QueuedMessage) => {
        onQueueMessage(message.id);
    }, [onQueueMessage]);

    const handleSend = React.useCallback((message: QueuedMessage) => {
        onSendMessage(message.id);
    }, [onSendMessage]);

    if (hidden || queuedMessages.length === 0 || !target) {
        return null;
    }

    return (
        <ComposerFloatingPanel role="region" ariaLabel={t('chat.queuedMessage.title')} compact={collapsed} header={
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setMessageQueueExpanded(collapsed)}
                    aria-expanded={!collapsed}
                    aria-controls={collapsed ? undefined : bodyId}
                    className="min-w-0 flex-1 shrink justify-start px-0 normal-case text-muted-foreground hover:!bg-transparent hover:text-foreground has-[>svg]:px-0"
                >
                    <Icon name="time" className="size-3.5 shrink-0" aria-hidden="true" />
                    <Icon name={collapsed ? 'arrow-up-s' : 'arrow-down-s'} className="size-4 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 truncate">{t('chat.queuedMessage.title')} {queuedMessages.length}</span>
                </Button>
        }>
            {!collapsed && (
                <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={handleDragEnd}
                >
                    <SortableContext
                        items={queuedMessages.map((m) => m.id)}
                        strategy={verticalListSortingStrategy}
                    >
                        <div id={bodyId} className="flex max-h-[min(36dvh,18rem)] flex-col divide-y divide-border/50 overflow-y-auto overscroll-contain px-3 md:max-h-[10.5rem] md:divide-y-0">
                            {queuedMessages.map((message) => (
                                <QueuedMessageChip
                                    key={message.id}
                                    message={message}
                                    sendingMessageId={sendingMessageId}
                                    target={target}
                                    onEdit={handleEdit}
                                    onQueue={handleQueue}
                                    onSend={handleSend}
                                />
                            ))}
                        </div>
                    </SortableContext>
                </DndContext>
            )}
        </ComposerFloatingPanel>
    );
});

QueuedMessageChips.displayName = 'QueuedMessageChips';
