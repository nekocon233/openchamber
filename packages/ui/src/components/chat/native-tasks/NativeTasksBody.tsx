import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { loadSessionNativeChecklist, useSessionNativeChecklist } from '@/sync/session-native-checklist';
import { loadSessionNativeTaskDetails, useSessionNativeTaskDetails } from '@/sync/session-background-tasks';
import { NativeTaskRow } from './NativeTaskDetails';
import { selectNativeTasksTab, selectTaskStopScope, type NativeTasksTab } from './task-ui-store';

type Scope = { sessionId: string; directory: string; runtimeGeneration: number; tab: NativeTasksTab };

function Checklist({ scope }: { scope: Scope }) {
  const { t } = useI18n();
  const state = useSessionNativeChecklist(scope.sessionId, scope.directory, { visible: true });
  const snapshot = 'snapshot' in state ? state.snapshot : null;
  return (
    <section className="space-y-3" aria-label={t('chat.nativeTasks.checklist')}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-muted-foreground">{t('chat.nativeTasks.readonly')}</p>
        <Button variant="outline" size="sm" disabled={state.status === 'loading' || state.status === 'unsupported'} onClick={() => void loadSessionNativeChecklist(scope.sessionId, scope.directory)}>
          <Icon name="refresh" className="size-4" />{t('chat.nativeTasks.refresh')}
        </Button>
      </div>
      {state.status === 'idle' || state.status === 'loading' ? <p role="status">{t('common.loading')}</p> : null}
      {state.status === 'unsupported' ? <p role="status">{t('chat.nativeTasks.unsupported')}</p> : null}
      {state.status === 'unavailable' ? <p role="status">{t('chat.nativeTasks.checklistUnavailable')}</p> : null}
      {state.status === 'error' ? <p role="alert" className="text-[var(--status-error-text)]">{t('chat.nativeTasks.loadError')}</p> : null}
      {state.status === 'stale' ? <p role="status" className="text-[var(--status-warning-text)]">{t('chat.nativeTasks.stale')}</p> : null}
      {snapshot && !snapshot.complete ? <p role="status" className="text-[var(--status-warning-text)]">{t('chat.nativeTasks.partial')}</p> : null}
      {snapshot?.source === 'history' ? <p className="text-sm text-muted-foreground">{t('chat.nativeTasks.history')}</p> : null}
      {snapshot?.items.length === 0 && snapshot.complete && state.status === 'ready' ? <p>{t('chat.nativeTasks.checklistEmpty')}</p> : null}
      {snapshot ? (
        <ul className="divide-y divide-border">
          {snapshot.items.map((item) => (
            <li key={item.id} className="space-y-1 py-3" data-native-checklist-id={item.id}>
              <div className="flex items-start gap-2">
                <Icon name={item.status === 'completed' ? 'checkbox-circle' : 'list-check-2'} className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 break-words font-medium">{item.subject}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{t(item.status === 'in_progress' ? 'chat.nativeTasks.status.running' : item.status === 'completed' ? 'chat.nativeTasks.status.completed' : 'chat.nativeTasks.status.pending')}</span>
              </div>
              {item.description !== undefined ? <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{item.description}</p> : null}
              {item.activeForm !== undefined ? <p className="break-words text-sm text-muted-foreground">{item.activeForm}</p> : null}
              {item.owner !== undefined ? <p className="break-words text-xs text-muted-foreground">{t('chat.nativeTasks.owner', { owner: item.owner })}</p> : null}
              {item.blockedBy.length ? <p className="break-words text-xs text-muted-foreground">{t('chat.nativeTasks.blockedBy', { ids: item.blockedBy.join(', ') })}</p> : null}
              {item.blocks.length ? <p className="break-words text-xs text-muted-foreground">{t('chat.nativeTasks.blocks', { ids: item.blocks.join(', ') })}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function BackgroundTasks({ scope, onClose }: { scope: Scope; onClose?: () => void }) {
  const { t } = useI18n();
  const state = useSessionNativeTaskDetails(scope.sessionId, scope.directory, { visible: true });
  const snapshot = 'snapshot' in state ? state.snapshot : null;
  const active = snapshot?.tasks.filter((task) => task.active) ?? [];
  const recent = snapshot?.tasks.filter((task) => !task.active) ?? [];
  React.useLayoutEffect(() => {
    if (!snapshot) return;
    selectTaskStopScope(
      snapshot.generation ? JSON.stringify([scope.runtimeGeneration, scope.directory, scope.sessionId, snapshot.generation]) : null,
      snapshot.tasks.filter((task) => task.active).map((task) => task.id),
    );
  }, [snapshot, scope.runtimeGeneration, scope.directory, scope.sessionId]);
  return (
    <section className="space-y-3" aria-label={t('chat.nativeTasks.background')}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-muted-foreground">{t('chat.nativeTasks.queryScope')}</p>
        <Button variant="outline" size="sm" disabled={state.status === 'loading' || state.status === 'unsupported'} onClick={() => void loadSessionNativeTaskDetails(scope.sessionId, scope.directory)}>
          <Icon name="refresh" className="size-4" />{t('chat.nativeTasks.refresh')}
        </Button>
      </div>
      {state.status === 'idle' || state.status === 'loading' ? <p role="status">{t('common.loading')}</p> : null}
      {state.status === 'unsupported' ? <p role="status">{t('chat.nativeTasks.unsupported')}</p> : null}
      {state.status === 'error' ? <p role="alert" className="text-[var(--status-error-text)]">{t('chat.nativeTasks.loadError')}</p> : null}
      {state.status === 'stale' ? <p role="status" className="text-[var(--status-warning-text)]">{t('chat.nativeTasks.stale')}</p> : null}
      {snapshot?.state === 'inactive' ? <p role="status">{t('chat.nativeTasks.inactive')}</p> : null}
      {snapshot?.state === 'unknown' ? (
        <>
          <p role="status">{t('chat.nativeTasks.waiting')}</p>
          <ul>{snapshot.tasks.map((task) => <NativeTaskRow key={`${snapshot.generation}:${task.id}`} task={task} scope={{ ...scope, generation: snapshot.generation }} onClose={onClose} />)}</ul>
        </>
      ) : null}
      {snapshot?.state === 'active' ? (
        <>
          {snapshot.tasks.length === 0 && state.status === 'ready' ? <p>{t('chat.nativeTasks.backgroundEmpty')}</p> : null}
          {snapshot.omitted > 0 ? <p className="text-sm text-muted-foreground">{t('chat.nativeTasks.omitted', { count: snapshot.omitted })}</p> : null}
          {([
            { id: 'active', title: t('chat.nativeTasks.active'), tasks: active },
            { id: 'recent', title: t('chat.nativeTasks.recent'), tasks: recent },
          ]).map((group) => group.tasks.length ? (
            <section key={group.id}>
              <h3 className="text-sm font-medium">{group.title}</h3>
              <ul>
                {group.tasks.map((task) => <NativeTaskRow key={`${snapshot.generation}:${task.id}`} task={task} scope={{ ...scope, generation: snapshot.generation }} onClose={onClose} />)}
              </ul>
            </section>
          ) : null)}
        </>
      ) : null}
    </section>
  );
}

export function NativeTasksBody({ scope, onClose }: { scope: Scope; onClose?: () => void }) {
  const { t } = useI18n();
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col" data-native-tasks-body>
      <div className="flex shrink-0 flex-wrap gap-2 border-b border-border p-3" role="group" aria-label={t('chat.nativeTasks.title')}>
        <Button variant="chip" size="sm" aria-pressed={scope.tab === 'checklist'} onClick={() => selectNativeTasksTab('checklist')}>{t('chat.nativeTasks.checklist')}</Button>
        <Button variant="chip" size="sm" aria-pressed={scope.tab === 'background'} onClick={() => selectNativeTasksTab('background')}>{t('chat.nativeTasks.background')}</Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {scope.tab === 'checklist' ? <Checklist scope={scope} /> : <BackgroundTasks scope={scope} onClose={onClose} />}
      </div>
    </div>
  );
}
