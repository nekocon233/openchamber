import { useMobileAppActions } from '@/apps/mobileAppContext';
import type { RepositoryChangeRequestReference, SourceControlReadContext } from '@/lib/api/types';
import type { PullRequestSource } from '@/lib/diff/pullRequestDiff';
import { usePullRequestSelectionStore, type PullRequestReturnLocation } from '@/stores/usePullRequestSelectionStore';
import { useUIStore } from '@/stores/useUIStore';
import { useWalkthroughStore } from '@/stores/useWalkthroughStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { resolvePullLinkTarget } from './boardRepository';
import type { SourceBoardProject } from './SourceBoardActions';

export type PullLinkProps = {
    pull: RepositoryChangeRequestReference;
    project: SourceBoardProject;
    repository: string | null;
    context: SourceControlReadContext;
    projectOwnsDirectory: (directory: string | undefined) => boolean;
    currentDirectory: string | undefined;
    onLeave?: () => void;
    revision?: string | null;
    returnTo?: PullRequestReturnLocation;
};

export const useOpenSourceBoardPull = () => {
    const mobile = useMobileAppActions();
    return (
        surface: 'diff' | 'walkthrough',
        { pull, project, repository, context, projectOwnsDirectory, currentDirectory, onLeave, revision = null, returnTo }: PullLinkProps,
    ) => {
        const source: PullRequestSource = {
            kind: 'pr', number: pull.number, sourceRepo: { owner: pull.sourceRepo.owner, repo: pull.sourceRepo.repo },
            ...(revision ? { revision } : {}),
            linked: context.linked,
        };
        const ui = useUIStore.getState();
        const target = resolvePullLinkTarget({
            projectPath: project.path,
            repository,
            currentDirectory: currentDirectory ?? null,
            owned: Boolean(currentDirectory && projectOwnsDirectory(currentDirectory)),
        });
        const restoreWorkspace = !mobile && returnTo && !projectOwnsDirectory(currentDirectory)
            ? useSessionUIStore.getState().captureNavigationReturn(returnTo.workspaceDirectory)
            : undefined;
        const navigationReturn = restoreWorkspace && returnTo
            ? useSessionUIStore.getState().captureNavigationReturnSnapshot(returnTo.workspaceDirectory) : null;
        const returning = returnTo ? { ...returnTo, reference: pull, context, restoreWorkspace, navigationReturn } : undefined;
        if (mobile) {
            if (target.mobileDirectory === currentDirectory) ui.closeMainSurfaces();
            else useSessionUIStore.getState().openNewSessionDraft({ selectedProjectId: project.id, directoryOverride: project.path });
            usePullRequestSelectionStore.getState().requestDiff(target.mobileRequestDirectory, source, returning ?? target.mobileRepository, context);
            onLeave?.();
            mobile.openChanges();
            return;
        }
        if (currentDirectory) ui.closeMainSurfaces();
        else useSessionUIStore.getState().openNewSessionDraft({ selectedProjectId: project.id, directoryOverride: project.path });
        const { panelDirectory, targetDirectory, requestDirectory } = target;
        if (surface === 'diff') {
            usePullRequestSelectionStore.getState().requestDiff(requestDirectory, source, returning, context);
            ui.openContextPanelTab(panelDirectory, { mode: 'diff', diffScope: 'pr', targetDirectory });
            return;
        }
        useWalkthroughStore.getState().requestTarget(requestDirectory, { source, context });
        ui.openContextPanelTab(panelDirectory, { mode: 'walkthrough', targetDirectory });
    };
};
