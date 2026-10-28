import React from 'react';
import { useI18n } from '@/lib/i18n';
import { useNativeSessionBackend } from '@/lib/native-agents/useNativeSession';
import { useSessionNativeChecklist } from '@/sync/session-native-checklist';
import { WorkStatusCollapsibleSection, WorkStatusRow, WorkStatusValue } from './WorkStatusPrimitives';
import { useReportWorkStatusPresence } from './presenceContext';
import { useWorkStatusNavigation } from './useWorkStatusNavigation';

const SECTION_ID = 'taskChecklist';

const ITEM_STATUS_KEYS = {
  pending: 'chat.nativeTasks.status.pending',
  in_progress: 'chat.nativeTasks.status.running',
  completed: 'chat.nativeTasks.status.completed',
} as const;
const ITEM_STATUS_TONES = { pending: 'muted', in_progress: 'info', completed: 'success' } as const;

export function WorkStatusChecklistSection({ sessionId, directory }: { sessionId: string | null; directory: string | null }) {
  const { t } = useI18n();
  const backend = useNativeSessionBackend(sessionId, directory);
  const enabled = Boolean(sessionId && directory && backend === 'claude');
  const state = useSessionNativeChecklist(sessionId, directory, { enabled, visible: false });
  const { openTasks } = useWorkStatusNavigation(directory);
  const snapshot = 'snapshot' in state ? state.snapshot : null;
  const items = snapshot?.items ?? [];
  useReportWorkStatusPresence(SECTION_ID, enabled);
  if (!enabled || !sessionId || !directory) return null;
  const summary = state.status === 'unsupported' ? t('chat.nativeTasks.summary.unsupported')
    : state.status === 'error' || state.status === 'unavailable' ? t('chat.nativeTasks.summary.unavailable')
      : state.status === 'partial' || state.status === 'stale' || snapshot?.complete === false ? t('chat.nativeTasks.summary.partial')
        : snapshot ? t('chat.nativeTasks.summary.checklist', { completed: items.filter((item) => item.status === 'completed').length, total: items.length })
          : t('common.loading');
  // With nothing to expand into, the section says why rather than disappearing:
  // it is the only place a reader is told the checklist could not be read.
  const empty = state.status === 'unsupported' ? t('chat.nativeTasks.unsupported')
    : state.status === 'unavailable' ? t('chat.nativeTasks.checklistUnavailable')
      : state.status === 'error' ? t('chat.nativeTasks.loadError')
        : state.status === 'idle' || state.status === 'loading' ? t('common.loading')
          : t('chat.nativeTasks.checklistEmpty');
  return (
    <WorkStatusCollapsibleSection id={SECTION_ID} title={t('chat.nativeTasks.cliChecklist')} icon="list-check-2" defaultExpanded summary={summary}>
      <div className="max-h-56 overflow-y-auto">
        {items.length === 0 ? <WorkStatusRow muted label={empty} /> : items.map((item) => (
          <WorkStatusRow
            key={item.id}
            label={item.subject}
            value={<WorkStatusValue tone={ITEM_STATUS_TONES[item.status]}>{t(ITEM_STATUS_KEYS[item.status])}</WorkStatusValue>}
            onClick={() => openTasks('checklist')}
            ariaLabel={t('chat.nativeTasks.openChecklist')}
          />
        ))}
      </div>
    </WorkStatusCollapsibleSection>
  );
}
