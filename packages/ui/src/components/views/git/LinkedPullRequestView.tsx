import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { DEFAULT_REPOSITORY_FILTER } from '@/components/references/referencePickerItems';
import { useGitHubReadContext, useGitHubReferenceDetail, useGitHubReferenceList, useGitHubSourceStatus } from '@/components/references/referenceSources';
import { isSameRepositoryItemLink } from '@/components/sourceBoard/boardLinkTarget';
import { SourceBoardPullLinks } from '@/components/sourceBoard/SourceBoardActions';
import { SourceBoardLinkFeedback, type BoardLinkFeedbackState } from '@/components/sourceBoard/SourceBoardLinkFeedback';
import { useBoardRevalidation } from '@/components/sourceBoard/useBoardRevalidation';
import { Button } from '@/components/ui/button';
import { resolveEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useNestedGitDirectory } from '@/hooks/useNestedGitDirectory';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { GitHubPullReference, SourceControlReadContext } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { sourceControlReadContextParts } from '@/lib/source-control/identity';
import { useRepositoryBinding } from '@/lib/source-control/repository-binding';
import { parseChangeRequestReference } from '@/lib/source-control/changeRequestReference';
import { openExternalUrl } from '@/lib/url';
import { useProjectsStore } from '@/stores/useProjectsStore';
import type { PullRequestOpenRequest } from '@/stores/usePullRequestSelectionStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { PullRequestDetail } from './PullRequestDetail';

/** The originating repository supplies authority even when another workspace hosts the pane. */
export const LinkedPullRequestView: React.FC<{
  request: PullRequestOpenRequest;
  visible: boolean;
  onBack: () => void;
}> = ({ request, visible, onBack }) => {
  const { sourceControl } = useRuntimeAPIs();
  const { gitDirectory } = useNestedGitDirectory(request.sourceDirectory, { enabled: visible });
  const directory = gitDirectory ?? request.sourceDirectory;
  const binding = useRepositoryBinding(directory, sourceControl);
  // Keep authority subscribed outside Activity, as the ordinary PR pane does.
  const context = useGitHubReadContext(directory);
  const scopeKey = JSON.stringify([request.runtimeKey, directory,
    context && context !== 'missing' ? sourceControlReadContextParts(context) : context]);
  return (
    <React.Activity mode={visible ? 'visible' : 'hidden'}>
      <LinkedPullRequestBody key={scopeKey} request={request} directory={directory} context={context} retryBinding={binding.retry} onBack={onBack} />
    </React.Activity>
  );
};

const LinkedPullRequestBody: React.FC<{
  request: PullRequestOpenRequest;
  directory: string;
  context: SourceControlReadContext | 'missing' | null;
  retryBinding: ReturnType<typeof useRepositoryBinding>['retry'];
  onBack: () => void;
}> = ({ request, directory, context, retryBinding, onBack }) => {
  const { t } = useI18n();
  const [now] = React.useState(() => Date.now());
  const sourceStatus = useGitHubSourceStatus(directory);
  const target = parseChangeRequestReference(request.url);
  const lookupUrl = target?.project
    ? `https://github.com/${target.project.owner.toLowerCase()}/${target.project.name.toLowerCase()}/pull/${target.number}` : request.url;
  const lookup = useGitHubReferenceList({
    enabled: context !== null && context !== 'missing' && context.provider === 'github',
    directory,
    kind: 'pull',
    filter: DEFAULT_REPOSITORY_FILTER,
    query: lookupUrl,
  });
  const reference = lookup.items.find((item): item is GitHubPullReference =>
    item.kind === 'pull' && isSameRepositoryItemLink(item.url, request.url)) ?? null;
  const { detail, refresh } = useGitHubReferenceDetail(directory, reference, true);
  useBoardRevalidation(true);

  const state: BoardLinkFeedbackState = context === null ? 'loading'
    : sourceStatus === 'disconnected' ? 'disconnected'
      : context === 'missing' || context.provider !== 'github' ? 'noRepository'
        : lookup.status === 'loading' || lookup.refreshing ? 'loading'
          : lookup.error ? 'error'
            : lookup.unavailable === 'disconnected' ? 'disconnected'
              : lookup.unavailable === 'no-repo' ? 'noRepository' : 'notFound';
  const openedExternally = React.useRef<PullRequestOpenRequest | null>(null);
  React.useEffect(() => {
    if (reference || state === 'loading' || request.failureBehavior === 'manual' || openedExternally.current === request) return;
    openedExternally.current = request;
    void openExternalUrl(request.url);
    onBack();
  }, [onBack, reference, request, state]);

  const projectFor = (value: string | null | undefined) => resolveProjectForSessionDirectory(
    useProjectsStore.getState().projects,
    useSessionUIStore.getState().availableWorktreesByProject,
    value ?? null,
  );
  const project = projectFor(request.sourceDirectory);

  return (
    <div className="flex h-full min-h-0 flex-col" data-linked-pull-request-url={request.url} data-source-directory={directory}>
      <div className="shrink-0 border-b border-border/60 px-4 py-2">
        <Button size="sm" variant="ghost" onClick={onBack}>
          <Icon name="arrow-left" className="size-4" />
          {t('header.actions.backAria')}
        </Button>
      </div>
      {reference && context && context !== 'missing' && context.provider === 'github' ? (
        <PullRequestDetail
          reference={reference}
          context={context}
          githubDetail={detail}
          now={now}
          onChanged={lookup.retry}
          onSubmitted={onBack}
          refreshDetail={refresh}
          pullLinks={<SourceBoardPullLinks
            pull={reference}
            project={project ?? { id: '', path: request.sourceDirectory }}
            context={context}
            projectOwnsDirectory={(value) => Boolean(project && projectFor(value)?.id === project.id)}
            currentDirectory={resolveEffectiveDirectory()}
            returnTo={{ workspaceDirectory: request.workspaceDirectory, tab: 'linked', request }}
          />}
        />
      ) : (
        <SourceBoardLinkFeedback url={request.url} state={state} error={lookup.error} onRetry={() => {
          if (context === 'missing') void retryBinding();
          else void lookup.retry();
        }} />
      )}
    </div>
  );
};
