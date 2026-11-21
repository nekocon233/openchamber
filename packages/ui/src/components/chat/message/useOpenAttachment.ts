import React from 'react';

import { useMobileAppActions } from '@/apps/mobileAppContext';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import type { AttachmentOpenTarget } from '@/lib/messages/attachmentPreview';
import { getDirectoryForFilePath } from '@/lib/path-utils';
import { useUIStore } from '@/stores/useUIStore';
import { useOpenChatLink } from '../useOpenChatLink';
import type { ToolPopupContent } from './types';

export function useOpenAttachment(onShowPopup: ((content: ToolPopupContent) => void) | undefined) {
    const runtime = React.useContext(RuntimeAPIContext);
    const mobileActions = useMobileAppActions();
    const effectiveDirectory = useEffectiveDirectory();
    const openChatLink = useOpenChatLink(effectiveDirectory ?? '');

    return React.useCallback((target: AttachmentOpenTarget, _event?: { metaKey: boolean; ctrlKey: boolean }) => {
        if (target.kind === 'external') {
            openChatLink(target.url);
            return;
        }
        if (target.kind === 'popup') {
            onShowPopup?.(target.popup);
            return;
        }
        if (runtime?.editor) {
            void runtime.editor.openFile(target.path);
            return;
        }
        const directory = effectiveDirectory || getDirectoryForFilePath(effectiveDirectory, target.path);
        useUIStore.getState().openContextFile(directory, target.path);
        mobileActions?.openFiles();
    }, [effectiveDirectory, mobileActions, onShowPopup, openChatLink, runtime]);
}
