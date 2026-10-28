import React from 'react';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { useNativeSessionBackend } from '@/lib/native-agents/useNativeSession';
import type { NativeExecutionTask } from '@/lib/native-agents/task-schemas';
import { useSessionNativeTaskDetails } from '@/sync/session-background-tasks';
import { WorkStatusCollapsibleSection, WorkStatusRow, WorkStatusValue } from './WorkStatusPrimitives';
import { useReportWorkStatusPresence } from './presenceContext';
import { useWorkStatusNavigation } from './useWorkStatusNavigation';

const SECTION_ID = 'taskBackground';

const TASK_STATUS_KEYS = {
  unknown: 'chat.nativeTasks.status.unknown',
  pending: 'chat.nativeTasks.status.pending',
  running: 'chat.nativeTasks.status.running',
  paused: 'chat.nativeTasks.status.paused',
  completed: 'chat.nativeTasks.status.completed',
  failed: 'chat.nativeTasks.status.failed',
  stopped: 'chat.nativeTasks.status.stopped',
} satisfies Record<NativeExecutionTask['status'], I18nKey>;
const TASK_STATUS_TONES = {
  unknown: 'muted',
  pending: 'muted',
  running: 'info',
  paused: 'warning',
  completed: 'success',
  failed: 'error',
  stopped: 'muted',
} as const;

export function WorkStatusBackgroundTasksSection({ sessionId, directory }: { sessionId: string | null; directory: string | null }) {
  const { t } = useI18n();
  const backend = useNativeSessionBackend(sessionId, directory);
  const enabled = Boolean(sessionId && directory && backend === 'claude');
  const state = useSessionNativeTaskDetails(sessionId, directory, { enabled, visible: false });
  const { openTasks } = useWorkStatusNavigation(directory);
  const snapshot = 'snapshot' in state ? state.snapshot : null;
  const tasks = snapshot?.tasks ?? [];
  useReportWorkStatusPresence(SECTION_ID, enabled);
  if (!enabled || !sessionId || !directory) return null;
  const summary = state.status === 'unsupported' ? t('chat.nativeTasks.summary.unsupported')
    : state.status === 'error' ? t('chat.nativeTasks.summary.unavailable')
      : state.status === 'stale' ? t('chat.nativeTasks.summary.partial')
        : snapshot?.state === 'unknown' ? t('chat.nativeTasks.waiting')
          : snapshot?.state === 'inactive' ? t('chat.nativeTasks.inactive')
            : snapshot ? t('chat.nativeTasks.summary.background', { active: tasks.filter((task) => task.active && !task.ambient).length, total: tasks.length })
              : t('common.loading');
  const empty = state.status === 'unsupported' ? t('chat.nativeTasks.unsupported')
    : state.status === 'error' ? t('chat.nativeTasks.loadError')
      : snapshot?.state === 'unknown' ? t('chat.nativeTasks.waiting')
        : snapshot?.state === 'inactive' ? t('chat.nativeTasks.inactive')
          : state.status === 'idle' || state.status === 'loading' ? t('common.loading')
            : t('chat.nativeTasks.backgroundEmpty');
  return (
    <WorkStatusCollapsibleSection id={SECTION_ID} title={t('chat.nativeTasks.background')} icon="task" defaultExpanded summary={summary}>
      <div className="max-h-56 overflow-y-auto">
        {tasks.length === 0 ? <WorkStatusRow muted label={empty} /> : (
          // Running work first, and a task that is no longer active reads muted.
          [...tasks].sort((left, right) => Number(right.active) - Number(left.active)).map((task) => (
            <WorkStatusRow
              key={task.id}
              muted={!task.active}
              label={task.description || task.id}
              value={<WorkStatusValue tone={task.active ? TASK_STATUS_TONES[task.status] : 'muted'}>{t(TASK_STATUS_KEYS[task.status])}</WorkStatusValue>}
              onClick={() => openTasks('background')}
              ariaLabel={t('chat.nativeTasks.openBackground')}
            />
          ))
        )}
      </div>
    </WorkStatusCollapsibleSection>
  );
}
