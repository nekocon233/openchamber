import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { ChecklistToolItem } from '@/lib/opencode/tools';

const STATUS_KEYS = {
  pending: 'chat.nativeTasks.status.pending',
  in_progress: 'chat.nativeTasks.status.running',
  completed: 'chat.nativeTasks.status.completed',
} as const;
const STATUS_COLORS = {
  pending: undefined,
  in_progress: 'var(--status-info)',
  completed: 'var(--status-success)',
};

export function ChecklistToolContent({ items }: { items: ChecklistToolItem[] }) {
  const { t } = useI18n();
  if (items.length === 0) {
    return <p className="typography-meta text-muted-foreground">{t('chat.toolPart.checklist.empty')}</p>;
  }
  return (
    <ul className="typography-meta space-y-2" aria-label={t('chat.toolPart.checklist.title')}>
      {items.map((item) => (
        <li key={item.id} className="flex items-start gap-2" data-checklist-item-id={item.id}>
          <Icon
            name={item.status === 'completed' ? 'checkbox-circle' : 'list-check-2'}
            className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
            style={{ color: STATUS_COLORS[item.status] }}
          />
          <span dir="auto" className="oc-ui-start-align min-w-0 flex-1 whitespace-pre-wrap break-words select-text">{item.content}</span>
          <span className="shrink-0 text-muted-foreground">{t(STATUS_KEYS[item.status])}</span>
        </li>
      ))}
    </ul>
  );
}
