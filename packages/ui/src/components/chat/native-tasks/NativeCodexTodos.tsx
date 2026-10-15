import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { loadSessionNativeTodos, useSessionNativeTodos } from '@/sync/session-native-todos';
import type { NativeTasksTab } from './task-ui-store';

type Scope = { sessionId: string; directory: string; runtimeGeneration: number; tab: NativeTasksTab };

/**
 * The steps a Codex turn maintains through `update_plan`, with the status each
 * one carried. Codex never writes them to its store, so this shows what the
 * server's CLI process observed and says so rather than implying a thread has
 * no steps: the reader has to be able to tell a quiet session from a restarted
 * server.
 */
export function NativeCodexTodos({ scope }: { scope: Scope }) {
  const { t } = useI18n();
  const state = useSessionNativeTodos(scope.sessionId, scope.directory, { visible: true });
  const snapshot = 'snapshot' in state ? state.snapshot : null;
  return (
    <section className="space-y-3" aria-label={t('chat.nativeTasks.todos')}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-muted-foreground">{t('chat.nativeTasks.todosNotice')}</p>
        <Button variant="outline" size="sm" disabled={state.status === 'loading' || state.status === 'unsupported'} onClick={() => void loadSessionNativeTodos(scope.sessionId, scope.directory)}>
          <Icon name="refresh" className="size-4" />{t('chat.nativeTasks.refresh')}
        </Button>
      </div>
      {state.status === 'idle' || state.status === 'loading' ? <p role="status">{t('common.loading')}</p> : null}
      {state.status === 'unsupported' ? <p role="status">{t('chat.nativeTasks.unsupported')}</p> : null}
      {state.status === 'error' ? <p role="alert" className="text-[var(--status-error-text)]">{t('chat.nativeTasks.loadError')}</p> : null}
      {state.status === 'stale' ? <p role="status" className="text-[var(--status-warning-text)]">{t('chat.nativeTasks.stale')}</p> : null}
      {snapshot?.state === 'unknown' ? <p role="status" data-native-todos-unknown>{t('chat.nativeTasks.todosUnknown')}</p> : null}
      {snapshot?.state === 'inactive' ? <p role="status" className="text-[var(--status-warning-text)]">{t('chat.nativeTasks.todosInactive')}</p> : null}
      {snapshot && snapshot.state !== 'unknown' && snapshot.todos.length === 0 ? <p>{t('chat.nativeTasks.todosEmpty')}</p> : null}
      {snapshot?.todos.length ? (
        <ul className="divide-y divide-border">
          {snapshot.todos.map((todo) => (
            <li key={todo.id} className="flex items-start gap-2 py-3" data-native-todo-id={todo.id}>
              <Icon name={todo.status === 'completed' ? 'checkbox-circle' : 'list-check-2'} className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 break-words">{todo.content}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{t(todo.status === 'in_progress' ? 'chat.nativeTasks.status.running' : todo.status === 'completed' ? 'chat.nativeTasks.status.completed' : 'chat.nativeTasks.status.pending')}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
