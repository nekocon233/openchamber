import React from 'react';
import { useI18n } from '@/lib/i18n';
import { nativeBackendOfSessionId } from '@/lib/native-agents/ids';
import { useSessionNativePlan } from '@/sync/session-native-plan';
import { SimpleMarkdownRenderer } from '../MarkdownRenderer';
import { WorkStatusCollapsibleSection, WorkStatusRow } from './WorkStatusPrimitives';
import { useReportWorkStatusPresence } from './presenceContext';

const SECTION_ID = 'taskPlan';

export function WorkStatusPlanSection({ sessionId, directory }: { sessionId: string | null; directory: string | null }) {
  const { t } = useI18n();
  const enabled = Boolean(sessionId && directory && nativeBackendOfSessionId(sessionId) === 'codex');
  const state = useSessionNativePlan(sessionId, directory, { enabled, visible: false });
  const held = 'plan' in state ? state.plan : null;
  const document = held?.state === 'ready' ? held : null;
  useReportWorkStatusPresence(SECTION_ID, enabled);
  if (!enabled || !sessionId || !directory) return null;
  const summary = state.status === 'unsupported' ? t('chat.nativeTasks.summary.unsupported')
    : state.status === 'error' ? t('chat.nativeTasks.summary.unavailable')
      : state.status === 'stale' ? t('chat.nativeTasks.summary.partial')
        : document ? t('chat.nativeTasks.summary.plan')
          : state.status === 'empty' ? t('chat.nativeTasks.planEmpty')
            : t('common.loading');
  const empty = state.status === 'unsupported' ? t('chat.nativeTasks.unsupported')
    : state.status === 'error' ? t('chat.nativeTasks.loadError')
      : state.status === 'idle' || state.status === 'loading' ? t('common.loading')
        : t('chat.nativeTasks.planEmpty');
  return (
    <WorkStatusCollapsibleSection id={SECTION_ID} title={t('chat.nativeTasks.plan')} icon="file-text" defaultExpanded summary={summary}>
      {document ? (
        <div className="max-h-56 overflow-y-auto px-1">
          {document.truncated ? <p role="status" className="text-xs text-[var(--status-warning-text)]">{t('chat.nativeTasks.planTruncated')}</p> : null}
          <SimpleMarkdownRenderer
            content={document.text}
            className="markdown-content typography-micro leading-relaxed break-words"
            fallbackContent={<div className="whitespace-pre-wrap break-words text-xs">{document.text}</div>}
          />
        </div>
      ) : <WorkStatusRow muted label={empty} />}
    </WorkStatusCollapsibleSection>
  );
}
