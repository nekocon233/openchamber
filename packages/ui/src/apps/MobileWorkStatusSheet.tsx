import React from 'react';

import { WorkStatusPanel } from '@/components/chat/work-status/WorkStatusPanel';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { isChatDirectoryPath } from '@/lib/chatDirectories';
import { useI18n } from '@/lib/i18n';
import { useSessionUIStore } from '@/sync/session-ui-store';

/**
 * The mobile host for the work-status panel. The desktop card reserves a
 * column and floats over the transcript; on a phone the same sections render
 * as the body of a bottom sheet, with the sheet owning scroll and animation.
 */
export const MobileWorkStatusSheet: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const { t } = useI18n();
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const effectiveDirectory = useEffectiveDirectory() ?? null;
  const draft = useSessionUIStore((state) => state.newSessionDraft);
  const isManagedChat = draft?.open ? draft.target === 'chat' : isChatDirectoryPath(effectiveDirectory);

  return (
    <MobileOverlayPanel
      open={open}
      title={t('mobile.header.metadata.workStatus')}
      onClose={onClose}
      contentMaxHeightClassName="max-h-none"
    >
      <ErrorBoundary>
        <WorkStatusPanel
          sessionId={currentSessionId ?? null}
          directory={isManagedChat ? null : effectiveDirectory}
          repositoryEnabled={!isManagedChat}
          visible={open}
          presentation="sheet"
          prewarmPrStatus
        />
      </ErrorBoundary>
    </MobileOverlayPanel>
  );
};
