import * as React from 'react';

import { useMobileAppActions } from '@/apps/mobileAppContext';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { isVSCodeRuntime } from '@/lib/desktop';
import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { openExternalUrl } from '@/lib/url';
import { useLinearAuthStore } from '@/stores/useLinearAuthStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSourceBoardStore, type BoardLinkFailureBehavior } from '@/stores/useSourceBoardStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

import { boardTargetOfUrl } from './boardLinkTarget';

/**
 * Shows the issue, PR or Linear issue a link names on the issues and PRs
 * board, in the project of `directory`, selected. False, with nothing opened,
 * for anything the board cannot show here: another kind of link, VS Code, a
 * project that is not open, Linear while it is not connected.
 */
export function useShowOnBoard() {
    const mobile = useMobileAppActions();
    // Read softly: sidebar rows also render where no runtime is provided, and
    // without one a Linear link simply opens in the browser.
    const linear = React.useContext(RuntimeAPIContext)?.linear;

    return React.useCallback((url: string, directory: string | null | undefined, failureBehavior: BoardLinkFailureBehavior = 'automatic'): boolean => {
        if (isVSCodeRuntime()) return false;
        const target = boardTargetOfUrl(url);
        if (!target) return false;

        const board = useSourceBoardStore.getState();
        if (target.source === 'linear') {
            if (!linear || useLinearAuthStore.getState().status?.connected !== true) return false;
            board.focusLinearIssue(target.identifier, url, failureBehavior);
        } else {
            const project = resolveProjectForSessionDirectory(
                useProjectsStore.getState().projects,
                useSessionUIStore.getState().availableWorktreesByProject,
                directory ?? null,
            );
            if (!project) return false;
            // The link itself is the search: it finds that one item, in its own repository.
            board.focusRepositoryItem(project.id, target.kind, url, failureBehavior);
        }
        if (mobile) mobile.openSourceBoard();
        else useUIStore.getState().setSourceBoardOpen(true);
        return true;
    }, [linear, mobile]);
}

/**
 * Opens an issue, PR or Linear issue a session is linked to on the board
 * (`useShowOnBoard`). Cmd or Ctrl opens the link itself, as links do; so does
 * anything the board cannot show here.
 */
export function useOpenOnBoard() {
    const showOnBoard = useShowOnBoard();

    return React.useCallback((url: string, directory: string | null | undefined, event?: { metaKey: boolean; ctrlKey: boolean }) => {
        if (event?.metaKey || event?.ctrlKey || !showOnBoard(url, directory)) void openExternalUrl(url);
    }, [showOnBoard]);
}
