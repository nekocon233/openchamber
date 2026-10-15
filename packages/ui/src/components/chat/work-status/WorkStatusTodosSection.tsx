import React from 'react';
import { useI18n } from '@/lib/i18n';
import { nativeBackendOfSessionId } from '@/lib/native-agents/ids';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionNativeTodos } from '@/sync/session-native-todos';
import { selectNativeTasksTab } from '../native-tasks/task-ui-store';
import { WorkStatusCollapsibleSection, WorkStatusRow, WorkStatusValue } from './WorkStatusPrimitives';
import { useReportWorkStatusPresence } from './presenceContext';

const SECTION_ID = 'taskTodos';

const openTasks = (directory: string, tab: 'plan' | 'todos') => {
  selectNativeTasksTab(tab);
  useUIStore.getState().openContextSurface(directory, 'tasks');
};

const STEP_STATUS_KEYS = {
  pending: 'chat.nativeTasks.status.pending',
  in_progress: 'chat.nativeTasks.status.running',
  completed: 'chat.nativeTasks.status.completed',
} as const;
const STEP_STATUS_TONES = { pending: 'muted', in_progress: 'info', completed: 'success' } as const;

export function WorkStatusTodosSection({ sessionId, directory }: { sessionId: string | null; directory: string | null }) {
  const { t } = useI18n();
  const enabled = Boolean(sessionId && directory && nativeBackendOfSessionId(sessionId) === 'codex');
  const state = useSessionNativeTodos(sessionId, directory, { enabled, visible: false });
  const snapshot = 'snapshot' in state ? state.snapshot : null;
  const steps = snapshot?.todos ?? [];
  useReportWorkStatusPresence(SECTION_ID, enabled);
  if (!enabled || !sessionId || !directory) return null;
  const summary = state.status === 'unsupported' ? t('chat.nativeTasks.summary.unsupported')
    : state.status === 'error' ? t('chat.nativeTasks.summary.unavailable')
      : state.status === 'stale' ? t('chat.nativeTasks.summary.partial')
        : snapshot?.state === 'unknown' ? t('chat.nativeTasks.todosUnknown')
          : snapshot?.state === 'inactive' ? t('chat.nativeTasks.todosInactive')
            : snapshot ? t('chat.nativeTasks.summary.checklist', { completed: steps.filter((step) => step.status === 'completed').length, total: steps.length })
              : t('common.loading');
  // Codex stores none of these steps, so an unobserved session says so rather
  // than reading as a session with nothing to do.
  const empty = state.status === 'unsupported' ? t('chat.nativeTasks.unsupported')
    : state.status === 'error' ? t('chat.nativeTasks.loadError')
      : snapshot?.state === 'inactive' ? t('chat.nativeTasks.todosInactive')
        : state.status === 'idle' || state.status === 'loading' ? t('common.loading')
          : snapshot?.state === 'unknown' ? t('chat.nativeTasks.todosUnknown')
            : t('chat.nativeTasks.todosEmpty');
  return (
    <WorkStatusCollapsibleSection id={SECTION_ID} title={t('chat.nativeTasks.todos')} icon="list-check-2" defaultExpanded summary={summary}>
      <div className="max-h-56 overflow-y-auto">
        {steps.length === 0 ? <WorkStatusRow muted label={empty} /> : steps.map((step) => (
          <WorkStatusRow
            key={step.id}
            label={step.content}
            value={<WorkStatusValue tone={STEP_STATUS_TONES[step.status]}>{t(STEP_STATUS_KEYS[step.status])}</WorkStatusValue>}
            onClick={() => openTasks(directory, 'todos')}
            ariaLabel={t('chat.nativeTasks.openChecklist')}
          />
        ))}
      </div>
    </WorkStatusCollapsibleSection>
  );
}
