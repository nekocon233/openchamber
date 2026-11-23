import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { TREE_INDENT_PX } from '@/components/views/git/changesTree';
import { buildDiffTreeRows } from '@/components/views/diffFileTree';
import { ChangeStats } from '@/components/views/git/ChangeRow';
import { ChangedPathLabel } from '@/components/views/git/ChangedPathLabel';
import { PierreDiffViewer, type ContextExpansionRequest } from '@/components/views/PierreDiffViewer';
import { cn } from '@/lib/utils';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { type FileDiffMetadata } from '@pierre/diffs';
import type { GitSubmoduleState } from '@/lib/api/types';
import { SubmoduleDiffSummary } from '@/components/views/SubmoduleDiffSummary';
import { useI18n } from '@/lib/i18n';
import { getLanguageFromExtension, isImageFile, isOfficePreviewFile } from '@/lib/toolHelpers';
import { isDocumentVersions } from '@/components/views/files/documentVersions';
import { OfficeDocumentDiff } from '@/components/views/files/OfficeDocumentDiff';
import { type DiffCommentOrigin } from '@/lib/diffCommentOrigin';
import { useWholeFileComment } from '@/components/comments';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { MOBILE_HEADER_BUTTON_CLASS, MOBILE_HEADER_CLASS, MOBILE_HEADER_TITLE_CLASS } from '@/components/ui/mobileHeader';

export interface MobileDiffData {
  reviewHeadSha?: string | null;
  original: string;
  modified: string;
  isBinary?: boolean;
  fileDiff?: FileDiffMetadata;
  submodule?: GitSubmoduleState | null;
}

export const MobileChangesState: React.FC<{
  message: string;
  description?: string;
  loading?: boolean;
  icon?: boolean;
}> = ({ message, description, loading = false, icon = false }) => (
  <div className="flex h-full items-center justify-center px-6 text-center">
    <div className="flex max-w-sm flex-col items-center gap-2">
      {loading ? <Icon name="loader-4" className="size-5 animate-spin text-muted-foreground" /> : null}
      {icon ? <Icon name="git-branch" className="size-6 text-muted-foreground" /> : null}
      <p className="typography-ui-label font-semibold text-foreground">{message}</p>
      {description ? <p className="typography-meta text-muted-foreground">{description}</p> : null}
    </div>
  </div>
);

export const MobileDiffDetail: React.FC<{
  path: string;
  previousPath?: string;
  subtitle?: string;
  diff: MobileDiffData | null;
  staged?: boolean;
  fileExists: boolean;
  unavailableReason?: 'nested_repository' | 'untracked_directory' | null;
  error?: string | null;
  onBack: () => void;
  onRetry?: () => void;
  onExpandContextRequest?: (request: ContextExpansionRequest) => void;
  pendingContextExpansion?: ContextExpansionRequest | null;
  contextLoading?: boolean;
  commentOrigin?: DiffCommentOrigin;
}> = ({ path, previousPath, subtitle, diff, staged = false, fileExists, unavailableReason = null, error = null, onBack, onRetry, onExpandContextRequest, pendingContextExpansion, contextLoading, commentOrigin }) => {
  const { t } = useI18n();
  const language = React.useMemo(() => getLanguageFromExtension(path) || 'text', [path]);
  const wholeFileComment = useWholeFileComment({ fileLabel: path, origin: commentOrigin });
  const trimmedPath = path.replace(/\/$/, '');
  const lastSlash = trimmedPath.lastIndexOf('/');
  const fileName = trimmedPath.slice(lastSlash + 1);
  const folder = lastSlash > 0 ? trimmedPath.slice(0, lastSlash) : null;
  const location = previousPath ? `${previousPath} → ${folder ?? fileName}` : folder;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
      <header className={cn(MOBILE_HEADER_CLASS, 'border-b border-edge text-foreground')}>
        <button
          type="button"
          className={MOBILE_HEADER_BUTTON_CLASS}
          aria-label={t('header.actions.backAria')}
          onClick={onBack}
        >
          <Icon name="arrow-left" className="size-5" />
        </button>
        <div className="min-w-0 flex-1 px-1" title={previousPath ? `${previousPath} → ${path}` : path}>
          <h2 dir="ltr" className={cn('oc-ui-start-align truncate', MOBILE_HEADER_TITLE_CLASS)}>{fileName}</h2>
          <p className="flex min-w-0 items-baseline gap-1.5 typography-micro text-muted-foreground">
            {location ? <span dir="ltr" className="oc-ui-start-align min-w-0 truncate">{location}</span> : null}
            {location && subtitle ? <span aria-hidden className="shrink-0 opacity-60">·</span> : null}
            {subtitle ? <span className="min-w-0 max-w-full shrink-0 truncate">{subtitle}</span> : null}
          </p>
        </div>
        <button
          type="button"
          className={cn(
            MOBILE_HEADER_BUTTON_CLASS,
            wholeFileComment.isOpen ? 'text-foreground' : 'text-muted-foreground',
          )}
          aria-label={t('inlineComment.actions.commentOnFile')}
          aria-pressed={wholeFileComment.isOpen}
          title={t('inlineComment.actions.commentOnFile')}
          onClick={wholeFileComment.toggle}
        >
          <Icon name="chat-1" className="size-5" />
        </button>
      </header>
      {wholeFileComment.cards}
      {wholeFileComment.editor}
      <div className="min-h-0 flex-1 overflow-hidden">
        {!fileExists ? (
          <MobileChangesState icon message={t('mobile.changes.diffDetail.missingTitle')} description={t('mobile.changes.diffDetail.missingDescription')} />
        ) : unavailableReason === 'nested_repository' ? (
          <MobileChangesState icon message={t('diffView.unavailable.nestedRepositoryTitle')} description={t('diffView.unavailable.nestedRepositoryDescription')} />
        ) : unavailableReason === 'untracked_directory' ? (
          <MobileChangesState icon message={t('diffView.unavailable.untrackedDirectoryTitle')} description={t('diffView.unavailable.untrackedDirectoryDescription')} />
        ) : error ? (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <div className="flex max-w-sm flex-col items-center gap-3">
              <p className="typography-ui-label font-semibold text-foreground">{t('mobile.changes.diffDetail.loadFailed')}</p>
              <p className="typography-meta text-muted-foreground">{error}</p>
              <Button type="button" size="sm" variant="outline" onClick={() => onRetry?.()}>{t('diffView.actions.retry')}</Button>
            </div>
          </div>
        ) : !diff ? (
          <MobileChangesState loading message={t('diffView.state.loadingDiff')} />
        ) : diff.submodule ? (
          <div className="p-3"><SubmoduleDiffSummary state={diff.submodule} staged={staged} /></div>
        ) : diff.isBinary ? (
          <MobileChangesState icon message={t('diffView.binary.unavailable')} />
        ) : isOfficePreviewFile(path) && isDocumentVersions(diff.original, diff.modified) ? (
          <ScrollableOverlay outerClassName="h-full" className="p-3" disableHorizontal data-diff-virtual-root data-diff-virtual-content>
            <OfficeDocumentDiff
              filePath={path}
              original={diff.original}
              modified={diff.modified}
              renderText={(text) => (
                <PierreDiffViewer
                  original={text.original}
                  modified={text.modified}
                  language="text"
                  fileName={path}
                  commentOrigin={commentOrigin}
                  renderSideBySide={false}
                  wrapLines={true}
                  layout="inline"
                />
              )}
            />
          </ScrollableOverlay>
        ) : previousPath && (diff.fileDiff ? diff.fileDiff.hunks.length === 0 : diff.original === diff.modified) ? (
          <MobileChangesState icon message={t('diffView.change.renamedFrom', { from: previousPath })} />
        ) : isImageFile(path) && !diff.fileDiff ? (
          <MobileChangesState icon message={t('mobile.changes.diffDetail.imageUnavailable')} />
        ) : (
          <ScrollableOverlay
            outerClassName="h-full"
            className="p-3"
            useScrollShadow
            disableHorizontal
            data-diff-virtual-root
            data-diff-virtual-content
          >
            <PierreDiffViewer
              original={diff.original}
              modified={diff.modified}
              fileDiff={diff.fileDiff}
              language={language}
              fileName={path}
              commentOrigin={commentOrigin}
              renderSideBySide={false}
              wrapLines={true}
              layout="inline"
              onExpandContextRequest={onExpandContextRequest}
              pendingContextExpansion={pendingContextExpansion}
              contextLoading={contextLoading}
              reviewHeadSha={diff.reviewHeadSha}
            />
          </ScrollableOverlay>
        )}
      </div>
    </div>
  );
};

type ComparisonFileListItem = { path: string; status: string; insertions: number; deletions: number; previousPath?: string };

export const MobileComparisonFileList: React.FC<{
  files: ComparisonFileListItem[];
  viewMode: 'tree' | 'flat';
  collapsedDirectories: ReadonlySet<string>;
  onToggleDirectory: (path: string) => void;
  onSelect: (path: string) => void;
}> = ({ files, viewMode, collapsedDirectories, onToggleDirectory, onSelect }) => {
  const { t } = useI18n();
  const rows = React.useMemo(
    () => (viewMode === 'tree' ? buildDiffTreeRows(files, collapsedDirectories) : []),
    [collapsedDirectories, files, viewMode],
  );
  const describeStatus = (status: string) => {
    const label = status === 'A' ? t('diffView.change.new')
      : status === 'D' ? t('diffView.change.deleted')
      : status === 'R' ? t('diffView.change.renamed')
      : status === 'C' ? t('diffView.change.copied') : t('diffView.change.modified');
    const color = status === 'A' ? 'var(--status-success)' : status === 'D' ? 'var(--status-error)'
      : status === 'R' || status === 'C' ? 'var(--status-info)' : 'var(--status-warning)';
    return { label, color };
  };
  const renderGuides = (depth: number) => Array.from({ length: depth }, (_, level) => (
    <span
      key={level}
      aria-hidden
      className="pointer-events-none absolute inset-y-0 w-px bg-edge"
      style={{ insetInlineStart: `${level * TREE_INDENT_PX + 18}px` }}
    />
  ));

  return (
    <ScrollableOverlay outerClassName="h-full" className="px-2 py-1" useScrollShadow disableHorizontal>
      <ul aria-label={t('gitView.changes.changedFilesAria')} className="flex flex-col">
        {viewMode === 'tree' ? rows.map((row) => {
          const indentStyle = row.depth > 0 ? { paddingInlineStart: `${row.depth * TREE_INDENT_PX + 12}px` } : undefined;
          if (row.kind === 'directory') {
            return (
              <li key={row.key} className="relative">
                {renderGuides(row.depth)}
                <button
                  type="button"
                  className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-start text-muted-foreground touch-manipulation focus:outline-none active:bg-interactive-hover hover:text-foreground"
                  style={indentStyle}
                  aria-expanded={row.expanded}
                  aria-label={t(row.expanded ? 'diffView.fileTree.collapseDirectoryAria' : 'diffView.fileTree.expandDirectoryAria', { path: row.path })}
                  onClick={() => onToggleDirectory(row.path)}
                >
                  <Icon name="arrow-right-s" className={cn('size-4 shrink-0 transition-transform', row.expanded && 'rotate-90 rtl:-rotate-90')} />
                  <span dir="ltr" className="min-w-0 flex-1 truncate typography-ui-label" title={row.path}>{row.label}</span>
                  {!row.expanded ? <span className="shrink-0 typography-meta tabular-nums text-muted-foreground">{row.fileCount}</span> : null}
                </button>
              </li>
            );
          }
          const { file } = row;
          const { label: statusLabel, color: statusColor } = describeStatus(file.status);
          return (
            <li key={row.key} className="relative">
              {renderGuides(row.depth)}
              <button
                type="button"
                className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-start touch-manipulation focus:outline-none active:bg-interactive-hover"
                style={indentStyle}
                onClick={() => onSelect(file.path)}
              >
                <span className="w-4 shrink-0 text-center typography-micro font-semibold uppercase" style={{ color: statusColor }} aria-label={statusLabel}>{file.status}</span>
                <FileTypeIcon filePath={file.path} className="size-3.5 shrink-0" />
                <span dir="ltr" className="min-w-0 flex-1 truncate typography-ui-label text-foreground" title={file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}>{row.name}</span>
                {(file.insertions > 0 || file.deletions > 0) && <ChangeStats insertions={file.insertions} deletions={file.deletions} hideZero />}
              </button>
            </li>
          );
        }) : files.map((file) => {
          const { label: statusLabel, color: statusColor } = describeStatus(file.status);
          return <li key={file.path}>
            <button
              type="button"
              className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-start touch-manipulation focus:outline-none active:bg-interactive-hover"
              onClick={() => onSelect(file.path)}
            >
              <span className="w-4 shrink-0 text-center typography-micro font-semibold uppercase" style={{ color: statusColor }} aria-label={statusLabel}>{file.status}</span>
              <FileTypeIcon filePath={file.path} className="size-3.5 shrink-0" />
              <ChangedPathLabel path={file.path} from={file.previousPath} nameFirst className="flex-1 typography-ui-label" />
              {(file.insertions > 0 || file.deletions > 0) && <ChangeStats insertions={file.insertions} deletions={file.deletions} hideZero />}
            </button>
          </li>;
        })}
      </ul>
    </ScrollableOverlay>
  );
};
