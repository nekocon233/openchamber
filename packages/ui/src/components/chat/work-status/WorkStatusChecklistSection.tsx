import React from 'react';
import { useI18n } from '@/lib/i18n';
import { nativeBackendOfSessionId } from '@/lib/native-agents/ids';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionNativeChecklist } from '@/sync/session-native-checklist';
import { selectNativeTasksTab } from '../native-tasks/task-ui-store';
import { WorkStatusCollapsibleSection, WorkStatusRow } from './WorkStatusPrimitives';
import { useReportWorkStatusPresence } from './presenceContext';

const openTasks = (directory: string, tab: 'checklist' | 'background') => {
  selectNativeTasksTab(tab);
  useUIStore.getState().openContextSurface(directory, 'tasks');
};

export function WorkStatusChecklistSection({ sessionId, directory }: { sessionId: string | null; directory: string | null }) {
  const { t } = useI18n();
  const enabled = Boolean(sessionId && directory && nativeBackendOfSessionId(sessionId) === 'claude');
  const state = useSessionNativeChecklist(sessionId, directory, { enabled, visible: false });
  const snapshot = 'snapshot' in state ? state.snapshot : null;
  useReportWorkStatusPresence('taskChecklist', enabled);
  if (!enabled || !sessionId || !directory) return null;
  const summary = state.status === 'unsupported' ? t('chat.nativeTasks.summary.unsupported')
    : state.status === 'error' || state.status === 'unavailable' ? t('chat.nativeTasks.summary.unavailable')
      : state.status === 'partial' || state.status === 'stale' || snapshot?.complete === false ? t('chat.nativeTasks.summary.partial')
        : snapshot ? t('chat.nativeTasks.summary.checklist', { completed: snapshot.items.filter((item) => item.status === 'completed').length, total: snapshot.items.length })
          : t('common.loading');
  const row = <WorkStatusRow label={summary} onClick={() => openTasks(directory, 'checklist')} ariaLabel={t('chat.nativeTasks.openChecklist')} />;
  return (
    <WorkStatusCollapsibleSection id="taskChecklist" title={t('chat.nativeTasks.cliChecklist')} icon="list-check-2" defaultExpanded collapsedContent={row}>
      {row}
    </WorkStatusCollapsibleSection>
  );
}
