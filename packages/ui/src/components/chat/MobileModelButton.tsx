import React from 'react';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import { getModelDisplayName } from './mobileControlsUtils';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { useI18n } from '@/lib/i18n';
import { isAutoModel } from '@/lib/routing/autoModel';
import type { Session } from '@/lib/opencode/model';
import { useSessionSelector } from '@/sync/sync-context';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { nativeAgentConfigurationOf } from '@/lib/native-agents/combinations';
import { isUnifiedNativeSessionId } from '@/lib/native-agents/ids';
import { agentCombinationDraftKey, useAgentCombinationDrafts, type AgentCombinationDraftTarget } from '@/lib/native-agents/combination-drafts';
import { useChatSessionSelection } from './chatColumnSession';

const selectCombinationName = (session: Session | undefined) => nativeAgentConfigurationOf(session?.metadata)?.combination?.name;

interface MobileModelButtonProps {
    onOpenModel: () => void;
    className?: string;
    model?: { providerId: string; modelId: string } | null;
}

export const MobileModelButton: React.FC<MobileModelButtonProps> = ({ onOpenModel, className, model }) => {
    const { t } = useI18n();
    const { sessionId, directory } = useChatSessionSelection();
    const combinationSessionId = model === undefined && sessionId && isUnifiedNativeSessionId(sessionId) ? sessionId : undefined;
    const savedCombinationName = useSessionSelector(combinationSessionId, directory ?? undefined, selectCombinationName);
    const draftId = useSessionUIStore((state) => model === undefined && !sessionId && state.newSessionDraft.open ? state.newSessionDraft.draftId : undefined);
    const draftTarget: AgentCombinationDraftTarget | null = draftId !== undefined ? { draftId } : directory;
    const draftCombinationName = useAgentCombinationDrafts((state) => model === undefined && !sessionId && draftTarget
        ? state.drafts.get(agentCombinationDraftKey(draftTarget))?.combination?.name : undefined);
    const combinationName = sessionId ? savedCombinationName : draftCombinationName;
    const currentModelId = useConfigStore((state) => model === undefined ? state.currentModelId : model?.modelId);
    const currentProviderId = useConfigStore((state) => model === undefined ? state.currentProviderId : model?.providerId);
    const providers = useConfigStore((state) => state.providers);
    const currentProvider = providers.find((provider) => provider.id === currentProviderId);
    const isAuto = isAutoModel(currentProviderId, currentModelId);
    const modelLabel = combinationName ?? (isAuto
        ? t('chat.modelControls.autoModel')
        : getModelDisplayName(currentProvider, currentModelId, t('chat.modelControls.selectModel')));

    return (
        <button
            type="button"
            onClick={onOpenModel}
            // Same guard as PermissionAutoAcceptButton/MobileAgentButton: block
            // the focus transfer so the tap doesn't dismiss the keyboard. With
            // interactive-widget=resizes-content (Android), the keyboard-close
            // relayout moves this button mid-tap and the click never lands.
            onMouseDown={(event) => event.preventDefault()}
            onPointerDownCapture={(event) => {
                if (event.pointerType === 'touch') {
                    event.preventDefault();
                }
            }}
            className={cn(
                // 36px to tap, drawn in the row's 26px: the margin keeps the row's height.
                'inline-flex h-9 -my-[5px] min-h-0 min-w-0 items-stretch',
                'rounded-lg',
                'typography-micro font-medium text-foreground/80',
                'focus:outline-none hover:bg-[var(--interactive-hover)]',
                className
            )}
            title={modelLabel}
        >
            <span className="flex h-full w-full min-w-0 items-center gap-1">
                {currentProviderId && !isAuto ? (
                    <ProviderLogo providerId={currentProviderId} className="size-4 flex-shrink-0" />
                ) : null}
                <span dir="auto" className="oc-ui-start-align truncate">{modelLabel}</span>
            </span>
        </button>
    );
};
