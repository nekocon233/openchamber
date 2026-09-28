import React from 'react';

import { useAssistantStatus } from '@/hooks/useAssistantStatus';
import { useConfigStore } from '@/stores/useConfigStore';
import { getProviderModelDisplayName } from '@/lib/modelDisplay';
import { useSessionBackgroundTasks } from '@/sync/session-background-tasks';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { BackgroundTasksChip } from './BackgroundTasksChip';
import { StatusRow } from './StatusRow';

/**
 * Status row wrapper.
 * Uses the dedicated assistant status hook so the row keeps accurate live activity
 * labels while still limiting subscriptions to the active assistant message.
 */
export const StatusRowContainer: React.FC = React.memo(() => {
    const { activeModel, working } = useAssistantStatus();
    const currentAgentName = useConfigStore((state) => state.currentAgentName);
    const providers = useConfigStore((state) => state.providers);
    const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
    const backgroundTasks = useSessionBackgroundTasks(currentSessionId);

    const modelDisplayName = React.useMemo(() => {
        if (!activeModel) {
            return null;
        }
        const provider = providers.length > 0
            ? providers.find((candidate) => candidate.id === activeModel.providerId)
            : undefined;
        return getProviderModelDisplayName(provider, activeModel.modelId) || null;
    }, [activeModel, providers]);

    // An idle session whose CLI still runs background tasks goes on by itself.
    if (!working.isWorking && backgroundTasks.length > 0) {
        return <BackgroundTasksChip tasks={backgroundTasks} />;
    }

    return (
        <StatusRow
            isWorking={working.isWorking}
            statusText={working.statusText}
            isGenericStatus={working.isGenericStatus}
            isWaitingForPermission={working.isWaitingForPermission}
            abortActive={working.abortActive}
            retryInfo={working.retryInfo}
            agentName={currentAgentName}
            modelName={modelDisplayName}
            providerId={activeModel?.providerId ?? null}
        />
    );
});

StatusRowContainer.displayName = 'StatusRowContainer';
