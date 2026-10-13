import React from 'react';
import { useI18n } from '@/lib/i18n';
import { nativeBackendOfSessionId } from '@/lib/native-agents/ids';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionNativeTaskDetails } from '@/sync/session-background-tasks';
import { selectNativeTasksTab } from '../native-tasks/task-ui-store';
import { WorkStatusCollapsibleSection, WorkStatusRow } from './WorkStatusPrimitives';
import { useReportWorkStatusPresence } from './presenceContext';

const openTasks = (directory: string, tab: 'checklist' | 'background') => {
  selectNativeTasksTab(tab);
  useUIStore.getState().openContextSurface(directory, 'tasks');
};

export function WorkStatusBackgroundTasksSection({ sessionId, directory }: { sessionId: string | null; directory: string | null }) {
  const { t } = useI18n();
  const enabled = Boolean(sessionId && directory && nativeBackendOfSessionId(sessionId) === 'claude');
  const state = useSessionNativeTaskDetails(sessionId, directory, { enabled, visible: false });
  const snapshot = 'snapshot' in state ? state.snapshot : null;
  useReportWorkStatusPresence('taskBackground', enabled);
  if (!enabled || !sessionId || !directory) return null;
  const summary = state.status === 'unsupported' ? t('chat.nativeTasks.summary.unsupported')
    : state.status === 'error' ? t('chat.nativeTasks.summary.unavailable')
      : state.status === 'stale' ? t('chat.nativeTasks.summary.partial')
        : snapshot?.state === 'unknown' ? t('chat.nativeTasks.waiting')
          : snapshot?.state === 'inactive' ? t('chat.nativeTasks.inactive')
        : snapshot ? t('chat.nativeTasks.summary.background', { active: snapshot.tasks.filter((task) => task.active && !task.ambient).length, total: snapshot.tasks.length })
          : t('common.loading');
  const row = <WorkStatusRow label={summary} onClick={() => openTasks(directory, 'background')} ariaLabel={t('chat.nativeTasks.openBackground')} />;
  return (
    <WorkStatusCollapsibleSection id="taskBackground" title={t('chat.nativeTasks.background')} icon="task" defaultExpanded collapsedContent={row}>
      {row}
    </WorkStatusCollapsibleSection>
  );
}
