import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import type { I18nKey } from '@/lib/i18n/messages/en';
import type { NativeExecutionTask } from '@/lib/native-agents/task-schemas';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useNativeTaskOutput, useNativeTaskStop, type NativeTaskScope } from './useTaskActions';

const TASK_STATUS_KEYS = {
  unknown: 'chat.nativeTasks.status.unknown',
  pending: 'chat.nativeTasks.status.pending',
  running: 'chat.nativeTasks.status.running',
  paused: 'chat.nativeTasks.status.paused',
  completed: 'chat.nativeTasks.status.completed',
  failed: 'chat.nativeTasks.status.failed',
  stopped: 'chat.nativeTasks.status.stopped',
} satisfies Record<NativeExecutionTask['status'], I18nKey>;

function TaskOutput({ scope, taskId }: { scope: NativeTaskScope; taskId: string }) {
  const { t } = useI18n();
  const state = useNativeTaskOutput(scope, taskId);
  return (
    <section className="space-y-2" aria-label={t('chat.nativeTasks.output.title')}>
      <div className="flex items-center justify-between gap-2">
        <h4 className="font-medium">{t('chat.nativeTasks.output.title')}</h4>
        <Button variant="outline" size="xs" disabled={state.status === 'loading'} onClick={() => void state.refresh()}>
          <Icon name="refresh" className="size-3.5" />{t('chat.nativeTasks.output.refresh')}
        </Button>
      </div>
      {state.status === 'loading' ? <p role="status">{t('common.loading')}</p> : null}
      {state.status === 'error' ? <p role="alert" className="text-[var(--status-error-text)]">{t('chat.nativeTasks.output.error')}</p> : null}
      {state.output?.state === 'unavailable' ? <p>{t(state.output.reason === 'query_closed'
        ? 'chat.nativeTasks.output.closed' : state.output.reason === 'unreadable'
          ? 'chat.nativeTasks.output.unreadable' : 'chat.nativeTasks.output.unavailable')}</p> : null}
      {state.output?.state === 'ready' ? (
        <>
          {state.output.truncated ? <p className="text-[var(--status-warning-text)]">{t('chat.nativeTasks.output.truncated')}</p> : null}
          {state.output.text === '' ? <p>{t('chat.nativeTasks.output.empty')}</p> : (
            <pre dir="ltr" className="oc-surface-code max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--syntax-background)] p-3 text-start text-xs">{state.output.text}</pre>
          )}
        </>
      ) : null}
    </section>
  );
}

export function NativeTaskRow({ task, scope, onClose }: { task: NativeExecutionTask; scope: NativeTaskScope; onClose?: () => void }) {
  const { t, locale } = useI18n();
  const [expanded, setExpanded] = React.useState(false);
  const detailId = React.useId();
  const stop = useNativeTaskStop(scope, task.id, task.active, task.canStop);
  const isMobile = useUIStore((state) => state.isMobile);
  const openChild = () => {
    if (!task.childSessionId) return;
    // The desktop panel switches to the chat surface in place; on mobile the
    // workspace drawer must close so the session it opens is visible.
    onClose?.();
    if (isMobile) {
      useSessionUIStore.getState().setCurrentSession(task.childSessionId, scope.directory);
    } else {
      useUIStore.getState().openContextPanelTab(scope.directory, {
        mode: 'chat', dedupeKey: `session:${task.childSessionId}`,
        label: task.description || task.id, readOnly: true,
      });
    }
  };
  const timestamp = (value: number) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? t('chat.nativeTasks.status.unknown')
      : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  };
  const stopping = stop.status === 'submitting' || stop.status === 'accepted';
  return (
    <li className="border-b border-border py-3 last:border-0" data-native-task-id={task.id}>
      <Button variant="ghost" size="sm" className="w-full justify-start whitespace-normal text-start" aria-expanded={expanded} aria-controls={detailId} onClick={() => setExpanded(!expanded)}>
        <Icon name={expanded ? 'arrow-down-s' : 'arrow-right-s'} className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 break-words">{task.description || task.id}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{t(TASK_STATUS_KEYS[task.status])}</span>
      </Button>
      {task.ambient ? <p className="px-3 text-xs text-muted-foreground">{t('chat.nativeTasks.ambient')}</p> : null}
      {task.active && (task.canStop || stopping) ? (
        <div className="flex flex-wrap items-center gap-2 px-3 pt-2">
          <Button variant="outline" size="xs" disabled={stopping || !task.canStop} onClick={() => void stop.stop()}>
            {stopping ? t('chat.nativeTasks.stop.pending') : t('chat.nativeTasks.stop.action')}
          </Button>
          {stop.status === 'accepted' ? <span role="status" className="text-xs text-muted-foreground">{t('chat.nativeTasks.stop.accepted')}</span> : null}
          {stop.status === 'error' ? <span role="alert" className="text-xs text-[var(--status-error-text)]">{t('chat.nativeTasks.stop.error')}</span> : null}
        </div>
      ) : null}
      {expanded ? (
        <div id={detailId} className="space-y-3 px-3 pt-3 text-sm text-muted-foreground">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 break-words">
            <dt>{t('chat.nativeTasks.detail.id')}</dt><dd dir="ltr">{task.id}</dd>
            <dt>{t('chat.nativeTasks.detail.type')}</dt><dd dir="ltr">{task.type}</dd>
            {task.toolUseId !== undefined ? <><dt>{t('chat.nativeTasks.detail.toolUse')}</dt><dd dir="ltr">{task.toolUseId}</dd></> : null}
            {task.lastToolName !== undefined ? <><dt>{t('chat.nativeTasks.detail.lastTool')}</dt><dd dir="ltr">{task.lastToolName}</dd></> : null}
            {task.startedAt !== undefined ? <><dt>{t('chat.nativeTasks.detail.started')}</dt><dd>{timestamp(task.startedAt)}</dd></> : null}
            {task.endedAt !== undefined ? <><dt>{t('chat.nativeTasks.detail.ended')}</dt><dd>{timestamp(task.endedAt)}</dd></> : null}
            {task.usage ? <>
              <dt>{t('chat.nativeTasks.detail.tokens')}</dt><dd>{task.usage.totalTokens.toLocaleString(locale)}</dd>
              <dt>{t('chat.nativeTasks.detail.toolUses')}</dt><dd>{task.usage.toolUses.toLocaleString(locale)}</dd>
              <dt>{t('chat.nativeTasks.detail.duration')}</dt><dd>{t('chat.nativeTasks.detail.durationValue', { milliseconds: task.usage.durationMs.toLocaleString(locale) })}</dd>
            </> : null}
          </dl>
          {task.summary !== undefined ? <section><h4 className="font-medium">{t('chat.nativeTasks.detail.summary')}</h4><p className="whitespace-pre-wrap break-words">{task.summary}</p></section> : null}
          {task.error !== undefined ? <section className="text-[var(--status-error-text)]"><h4 className="font-medium">{t('chat.nativeTasks.detail.error')}</h4><p className="whitespace-pre-wrap break-words">{task.error}</p></section> : null}
          {task.childSessionId ? <Button variant="outline" size="sm" onClick={openChild}>{t('chat.nativeTasks.detail.openChild')}</Button> : null}
          {task.outputAvailable ? <TaskOutput scope={scope} taskId={task.id} /> : <p>{t('chat.nativeTasks.output.unavailable')}</p>}
        </div>
      ) : null}
    </li>
  );
}
