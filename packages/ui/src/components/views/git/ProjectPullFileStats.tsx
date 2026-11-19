import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { GitHubPullReference, SourceControlReadContext } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { summarizeFileStats } from '@/lib/source-control/fileStats';
import { useProjectPullFileStats } from './useProjectPullFileStats';

/** Mounted for visible project PR rows and details. */
export const ProjectPullFileStats: React.FC<{
  context: SourceControlReadContext;
  pull: GitHubPullReference;
  excludedTypes: readonly string[];
  detail?: boolean;
}> = ({ context, pull, excludedTypes, detail = false }) => {
  const { t } = useI18n();
  const snapshot = useProjectPullFileStats(context, pull);
  const summary = React.useMemo(() => snapshot?.status === 'ready'
    ? summarizeFileStats(snapshot.value, excludedTypes) : null, [excludedTypes, snapshot]);
  const filesLabel = summary ? t(summary.files === 1 ? 'references.projectPulls.files.single' : 'references.projectPulls.files.plural', { count: summary.files }) : undefined;
  return (
    <span dir="auto" className={detail
      ? 'inline-flex min-w-0 items-center gap-2 tabular-nums text-muted-foreground'
      : 'mt-1 flex min-h-4 min-w-0 items-center gap-1.5 typography-micro tabular-nums text-muted-foreground'}>
      {summary ? <>
        {detail ? null : <><span>{filesLabel}</span><span aria-hidden="true">·</span></>}
        <span dir="ltr" className="text-[var(--status-success)]">+{summary.additions ?? '—'}</span>
        <span dir="ltr" className="text-[var(--status-error)]">−{summary.deletions ?? '—'}</span>
        {detail ? (
          <span className="inline-flex items-center gap-0.5" title={filesLabel}>
            <Icon name="file-list-2" className="size-3.5" />
            {summary.files}
          </span>
        ) : null}
      </> : <span className="truncate" title={snapshot?.status === 'error' ? snapshot.error : undefined}>
        {t(snapshot?.status === 'error' ? 'references.projectPulls.files.failed' : 'references.projectPulls.files.loading')}
      </span>}
    </span>
  );
};
