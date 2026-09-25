import { useCallback, useState } from 'react';

import { useSessionAssistState } from '@/hooks/useSessionAssist';

interface PromptSuggestionOptions {
    runtimeKey: string;
    sessionId: string | null;
    directory?: string;
    hidden: boolean;
}

// Accepting or typing dismisses the displayed proposal locally. It never
// changes the session's recap or sends a message to the agent.
export function usePromptSuggestion({ runtimeKey, sessionId, directory, hidden }: PromptSuggestionOptions) {
    const { assist, suggestion } = useSessionAssistState(sessionId ?? '', directory);
    const identity = assist
        ? JSON.stringify([runtimeKey, directory, sessionId, assist.forMessageID])
        : null;
    const [dismissedIdentity, setDismissedIdentity] = useState<string | null>(null);
    const visible = !hidden && identity !== dismissedIdentity ? suggestion : null;
    const dismiss = useCallback(() => {
        if (identity) setDismissedIdentity(identity);
    }, [identity]);

    return { suggestion: visible, dismiss };
}
