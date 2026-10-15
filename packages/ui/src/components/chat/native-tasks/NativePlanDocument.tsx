import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { loadSessionNativePlan, useSessionNativePlan } from '@/sync/session-native-plan';
import { SimpleMarkdownRenderer } from '../MarkdownRenderer';
import type { NativeTasksTab } from './task-ui-store';

type Scope = { sessionId: string; directory: string; runtimeGeneration: number; tab: NativeTasksTab };

/**
 * The plan a Codex thread wrote, shown as the document it is. A plan states an
 * intention and is never revised as work proceeds, so this section carries no
 * status, no counts and no tick marks: those belong to the checklist, which
 * tracks progress. The step list a Codex turn maintains through `update_plan`
 * is a different thing and renders elsewhere.
 */
export function NativePlanDocument({ scope }: { scope: Scope }) {
  const { t } = useI18n();
  const state = useSessionNativePlan(scope.sessionId, scope.directory, { visible: true });
  const held = 'plan' in state ? state.plan : null;
  const document = held?.state === 'ready' ? held : null;

  return (
    <section className="space-y-3" aria-label={t('chat.nativeTasks.plan')}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-muted-foreground">{t('chat.nativeTasks.planNotice')}</p>
        <Button variant="outline" size="sm" disabled={state.status === 'loading' || state.status === 'unsupported'} onClick={() => void loadSessionNativePlan(scope.sessionId, scope.directory)}>
          <Icon name="refresh" className="size-4" />{t('chat.nativeTasks.refresh')}
        </Button>
      </div>
      {state.status === 'idle' || state.status === 'loading' ? <p role="status">{t('common.loading')}</p> : null}
      {state.status === 'unsupported' ? <p role="status">{t('chat.nativeTasks.unsupported')}</p> : null}
      {state.status === 'error' ? <p role="alert" className="text-[var(--status-error-text)]">{t('chat.nativeTasks.loadError')}</p> : null}
      {state.status === 'stale' ? <p role="status" className="text-[var(--status-warning-text)]">{t('chat.nativeTasks.stale')}</p> : null}
      {state.status === 'empty' ? <p data-native-plan-empty>{t('chat.nativeTasks.planEmpty')}</p> : null}
      {document ? (
        <div className="min-w-0" data-native-plan-document>
          {document.truncated ? <p role="status" className="text-[var(--status-warning-text)]">{t('chat.nativeTasks.planTruncated')}</p> : null}
          <SimpleMarkdownRenderer
            content={document.text}
            className="markdown-content leading-relaxed break-words"
            fallbackContent={<div className="whitespace-pre-wrap break-words">{document.text}</div>}
          />
        </div>
      ) : null}
    </section>
  );
}
