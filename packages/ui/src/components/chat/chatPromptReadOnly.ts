import type { Session } from '@/lib/opencode/model';
import { isReviewSession } from '@/lib/sessionReviewMetadata';
import { nativeBackendOfSessionId } from '@/lib/native-agents/ids';
import { isOperatorChildSession } from '@/lib/sessionOperatorChild';

export const resolveChatPromptReadOnly = (
    session: Session | null | undefined,
    allowPromptingSubagentSessions: boolean,
    readOnly: boolean,
    ownFolderAdmitted = true,
): boolean => {
    if (!ownFolderAdmitted) return true;
    if (isOperatorChildSession(session)) return true;
    if (isReviewSession(session)) {
        return readOnly;
    }

    if (session?.parentID) {
        if (nativeBackendOfSessionId(session.id) === 'antigravity') return true;
        return !allowPromptingSubagentSessions;
    }

    return readOnly;
};
