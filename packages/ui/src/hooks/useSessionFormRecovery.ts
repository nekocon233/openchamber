import React from 'react';
import { recoverPendingFormWithRetry } from '@/sync/form-recovery';

export const useSessionFormRecovery = ({
  active,
  sessionId,
  directory,
  disabled,
  hasUnreconciledFormTool,
  recoverPendingQuestions,
}: {
  active: boolean;
  sessionId: string | null;
  directory: string | undefined;
  disabled: boolean;
  hasUnreconciledFormTool: boolean;
  recoverPendingQuestions: (sessionID: string, directoryOverride?: string) => Promise<boolean>;
}): void => {
  const hasUnreconciledFormToolRef = React.useRef(hasUnreconciledFormTool);
  hasUnreconciledFormToolRef.current = hasUnreconciledFormTool;

  React.useEffect(() => {
    if (!active || !sessionId || !directory || disabled || !hasUnreconciledFormTool) return;
    let cancelled = false;

    void recoverPendingFormWithRetry(
      () => recoverPendingQuestions(sessionId, directory),
      { isCancelled: () => cancelled },
    );

    return () => {
      cancelled = true;
    };
  }, [active, sessionId, directory, disabled, hasUnreconciledFormTool, recoverPendingQuestions]);

  React.useEffect(() => {
    if (!active || !sessionId || !directory || disabled) return;
    if (hasUnreconciledFormToolRef.current) return;
    void recoverPendingQuestions(sessionId, directory);
  }, [active, sessionId, directory, disabled, recoverPendingQuestions]);
};
