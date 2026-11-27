import * as React from 'react';
import { DEFAULT_REPOSITORY_FILTER } from '@/components/references/referencePickerItems';
import { useRepositoryReferenceList } from '@/components/references/referenceSources';
import type { ReferenceBrowser } from '@/components/references/useReferenceBrowser';
import { isSameRepositoryItemLink } from '@/components/sourceBoard/boardLinkTarget';
import type { SourceControlReadContext } from '@/lib/api/types';
import { parseChangeRequestReference } from '@/lib/source-control/changeRequestReference';
import { parseIssueReference } from '@/lib/source-control/issueReference';
import { useWorkspaceDraftStore, workspaceReplyDraftKey } from '@/stores/useWorkspaceDraftStore';
import { readWorkspaceViewState, useWorkspaceViewStateStore } from '@/stores/useWorkspaceViewStateStore';

const ISSUE_LOOKUP_FILTER = { ...DEFAULT_REPOSITORY_FILTER, state: 'all' as const };

export function useProjectReferenceSelection(
  browser: ReferenceBrowser,
  { directory, context, stateOwner, runtime, active }: {
    directory: string | null;
    context: SourceControlReadContext | null;
    stateOwner: string | null;
    runtime: string;
    active: boolean;
  },
) {
  const issue = browser.mode === 'project-issues';
  const kind = issue ? 'issue' : 'pull';
  const view = issue ? 'issue' : 'pullRequest';
  const { selectionUrl, previewItem, openItem } = browser;
  const previewUrl = previewItem?.source === 'repository' ? previewItem.reference.url : null;
  const restoreUrl = selectionUrl && selectionUrl !== previewUrl ? selectionUrl : null;
  const target = restoreUrl ? (issue ? parseIssueReference(restoreUrl) : parseChangeRequestReference(restoreUrl)) : null;
  const orphanKey = target?.project && context ? workspaceReplyDraftKey(runtime, context, {
    kind, number: target.number, sourceRepo: { owner: target.project.owner, repo: target.project.name },
  }) : null;
  const orphan = useWorkspaceDraftStore(state => orphanKey ? state.drafts[orphanKey] : undefined);
  const restored = useRepositoryReferenceList({
    directory, kind, filter: issue ? ISSUE_LOOKUP_FILTER : DEFAULT_REPOSITORY_FILTER,
    query: restoreUrl ?? '', scope: 'repository', enabled: Boolean(restoreUrl && active), active,
  });
  React.useEffect(() => {
    if (!active || !restoreUrl) return;
    if (stateOwner && readWorkspaceViewState(useWorkspaceViewStateStore.getState(), view, stateOwner).selectedUrl !== restoreUrl) return;
    const reference = restored.items.find(item => item.kind === kind && isSameRepositoryItemLink(item.url, restoreUrl));
    if (reference) openItem({ source: 'repository', reference });
  }, [active, kind, openItem, restoreUrl, restored.items, stateOwner, view]);
  return { restoreUrl, restored, orphan };
}

export function useProjectReferenceBack(browser: ReferenceBrowser, listVisible: boolean) {
  const restoreFocus = React.useRef(false);
  const { searchRef, closeMobilePreview } = browser;
  React.useLayoutEffect(() => {
    if (!listVisible || !restoreFocus.current) return;
    restoreFocus.current = false;
    searchRef.current?.focus({ preventScroll: true });
  }, [listVisible, searchRef]);
  return () => {
    restoreFocus.current = true;
    closeMobilePreview();
  };
}
