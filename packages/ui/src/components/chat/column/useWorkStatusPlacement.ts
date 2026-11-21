import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import { isChatDirectoryPath } from '@/lib/chatDirectories';
import type { useChatSurfaceMode } from '../useChatSurfaceMode';

type NewSessionDraft = {
    open?: boolean;
    target?: string;
    bootstrapPendingDirectory?: string | null;
    directoryOverride?: string | null;
};

export const useWorkStatusPlacement = ({
    pinned,
    isMobile,
    active,
    chatSurfaceMode,
    draftOpen,
    newSessionDraft,
    effectiveSessionDirectory,
    sessionId,
}: {
    pinned: boolean;
    isMobile: boolean;
    active: boolean;
    chatSurfaceMode: ReturnType<typeof useChatSurfaceMode>;
    draftOpen: boolean;
    newSessionDraft: NewSessionDraft | undefined;
    effectiveSessionDirectory: string | undefined;
    sessionId: string | null;
}) => {
    const isManagedChatContext = draftOpen
        ? newSessionDraft?.target === 'chat'
        : isChatDirectoryPath(effectiveSessionDirectory);
    const workStatusDirectory = draftOpen
        ? (isManagedChatContext ? null : newSessionDraft?.bootstrapPendingDirectory ?? newSessionDraft?.directoryOverride ?? effectiveSessionDirectory)
        : effectiveSessionDirectory;
    const workStatusOverlayMountable = !isMobile && !pinned && chatSurfaceMode !== 'mini-chat';
    const open = useUIStore((state) => state.workStatusOverlayOpen);
    const setOpen = useUIStore((state) => state.setWorkStatusOverlayOpen);

    React.useLayoutEffect(() => {
        if (!workStatusOverlayMountable) return;
        setOpen(false);
        return () => setOpen(false);
    }, [workStatusOverlayMountable, active, sessionId, workStatusDirectory, setOpen]);

    return {
        isManagedChatContext,
        workStatusDirectory,
        workStatusOverlayMountable,
        showWorkStatusOverlay: workStatusOverlayMountable && active && open,
    };
};
