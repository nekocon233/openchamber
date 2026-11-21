import type { SourceControlProvider } from '@/lib/api/types';
import React from 'react';

import { SessionGoalButton, SessionGoalObjectiveCounter } from '@/components/chat/SessionGoalButton';
import { ComposerDictation } from '@/components/dictation/ComposerDictation';
import { Icon } from '@/components/icon/Icon';
import type { GuestAttachItem } from '@/hooks/useGuestSurfaces';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isDictationCaptureSupported } from '@/lib/dictation/use-dictation-audio-source';
import { ModelControls } from '../../ModelControls';
import { ComposerActionButtons } from './ComposerActionButtons';
import { ComposerAttachmentControls, type ComposerTrackerPicker } from './ComposerAttachmentControls';
import { FocusModeButton } from './FocusModeButton';
import { PermissionAutoAcceptButton } from './PermissionAutoAcceptButton';
import type { PermissionMode } from '@/stores/utils/permissionAutoAccept';
import type { BtwSelection } from '@/stores/useBtwStore';

const MemoModelControls = React.memo(ModelControls);
const MemoComposerDictation = React.memo(ComposerDictation);

interface ComposerFooterProps {
    isMobile: boolean;
    isVSCode: boolean;
    sessionId: string | null;
    directory?: string;
    newSessionDraftOpen: boolean;
    messageLength: number;

    radius: string;
    footerPaddingClass: string;
    footerGapClass: string;
    footerIconButtonClass: string;
    iconSizeClass: string;
    sendIconSizeClass: string;
    stopIconSizeClass: string;

    canSend: boolean;
    canAbort: boolean;
    followUpDelivery: 'steer' | 'queue';
    hasContent: boolean;
    isExpandedInput: boolean;
    permissionMode: PermissionMode;
    isPermissionAutoAcceptInteractive: boolean;
    dictationActive: boolean;

    onOpenSettings?: () => void;
    onPickLocalFiles: () => void;
    onOpenGitHubPicker: () => void;
    repositoryProvider?: SourceControlProvider | null;
    trackerPickers?: readonly ComposerTrackerPicker[];
    attachGuests?: readonly GuestAttachItem[];
    onOpenGuestAttach?: (guestId: string) => void;
    onOpenAttachSheet: () => void;
    onToggleExpandedInput: () => void;
    onCyclePermissionMode: () => void;
    onPrimaryAction: () => void;
    onAbort: () => void;
    onStartDictation: () => void;
    onDictationInsert: (text: string) => void;
    onDictationInsertAndSend: (text: string) => void;
    onDictationSendStart: () => void;
    onDictationStart: () => void;
    onDictationContentHeightChange: (height: number | null) => void;
    onDictationActiveChange?: (active: boolean) => void;
    isBtw?: boolean;
    /** A native CLI session, or a draft that becomes one: the CLI approves every tool itself. */
    nativeTarget?: boolean;
    escapeStops?: boolean;
    modelSessionId?: string | null;
    btwSelection: BtwSelection;
    scopedModelSelectorOpen?: boolean;
    onScopedModelSelectorOpenChange?: (open: boolean) => void;
    pinnedSelection?: BtwSelection | null;
    onRunInParallel?: () => void;
    parallelRun?: { runCount: number; launching: boolean; onLaunch: () => void } | null;
    waitingForOpenCode: boolean;
}

function OpenCodeStartupNote({ className }: { className?: string }) {
    const { t } = useI18n();
    return (
        <span
            role="status"
            className={cn('min-w-0 truncate self-center typography-micro text-muted-foreground/70', className)}
            title={t('chat.chatInput.waitingForOpenCodeHint')}
        >
            {t('chat.chatInput.waitingForOpenCode')}
        </span>
    );
}

function ComposerFooterView(props: ComposerFooterProps) {
    const { t } = useI18n();
    const {
        isMobile,
        isVSCode,
        sessionId: currentSessionId,
        directory,
        newSessionDraftOpen,
        messageLength,
        radius: chatInputRadius,
        footerPaddingClass,
        footerGapClass,
        footerIconButtonClass,
        iconSizeClass,
        sendIconSizeClass,
        stopIconSizeClass,
        canSend,
        canAbort,
        followUpDelivery,
        hasContent,
        isExpandedInput,
        permissionMode,
        isPermissionAutoAcceptInteractive,
        dictationActive,
        onOpenSettings,
        onPickLocalFiles,
        onOpenGitHubPicker,
        repositoryProvider,
        trackerPickers,
        attachGuests,
        onOpenGuestAttach,
        onOpenAttachSheet,
        onToggleExpandedInput,
        onCyclePermissionMode,
        onPrimaryAction,
        onAbort,
        onStartDictation,
        onDictationInsert,
        onDictationInsertAndSend,
        onDictationSendStart,
        onDictationStart,
        onDictationContentHeightChange,
        onDictationActiveChange,
        isBtw = false,
        nativeTarget = false,
        escapeStops,
        modelSessionId,
        btwSelection,
        scopedModelSelectorOpen,
        onScopedModelSelectorOpenChange,
        pinnedSelection = null,
        onRunInParallel,
        parallelRun = null,
        waitingForOpenCode,
    } = props;

    const dictationEnabled = useConfigStore((state) => state.dictationEnabled);
    const [dictationSupported] = React.useState(() => !isVSCodeRuntime() && isDictationCaptureSupported());
    const showDictation = dictationEnabled && dictationSupported;

    return (
        <div
            className={cn(
                'bg-transparent flex-shrink-0',
                footerPaddingClass,
                !isMobile && !isVSCode && 'pe-2',
                isMobile && 'h-12 pe-3.5',
                isMobile ? 'flex items-center gap-x-1.5' : cn('flex items-center justify-between', footerGapClass)
            )}
            style={{
                borderBottomLeftRadius: chatInputRadius,
                borderBottomRightRadius: chatInputRadius,
            }}
            data-chat-input-footer="true"
            data-dictation-chain={isMobile ? undefined : 'true'}
        >
            {isMobile ? (
                <>
                    <div className="flex w-full items-center justify-between gap-x-1.5">
                        <div className="composer-mobile-actions flex items-center gap-x-2 ps-1">
                            <ComposerAttachmentControls
                                isVSCode={isVSCode}
                                footerIconButtonClass={footerIconButtonClass}
                                iconSizeClass={iconSizeClass}
                                handlePickLocalFiles={onPickLocalFiles}
                                openGitHubPicker={onOpenGitHubPicker}
                                repositoryProvider={repositoryProvider}
                                trackerPickers={trackerPickers}
                                onOpenSettings={isBtw ? undefined : onOpenSettings}
                                onOpenMobileSheet={onOpenAttachSheet}
                                attachGuests={attachGuests}
                                onOpenGuestAttach={onOpenGuestAttach}
                                filesOnly={isBtw}
                            />
                            {!nativeTarget ? <PermissionAutoAcceptButton
                                footerIconButtonClass={footerIconButtonClass}
                                iconSizeClass={iconSizeClass}
                                isInteractive={isPermissionAutoAcceptInteractive}
                                permissionMode={permissionMode}
                                handlePermissionModeCycle={onCyclePermissionMode}
                            /> : null}
                            {!isBtw ? <SessionGoalButton
                                sessionId={currentSessionId}
                                directory={directory}
                                draftOpen={newSessionDraftOpen}
                                footerIconButtonClass={footerIconButtonClass}
                                iconSizeClass={iconSizeClass}
                            /> : null}
                            {!isBtw ? <SessionGoalObjectiveCounter length={messageLength} /> : null}
                        </div>
                        <div className="flex items-center min-w-0 gap-x-1 justify-end">
                            {waitingForOpenCode ? <OpenCodeStartupNote /> : null}
                            <div className="flex items-center gap-x-1 flex-shrink-0">
                                {!isBtw && showDictation ? <button
                                    type="button"
                                    className={footerIconButtonClass}
                                    onMouseDown={(event) => event.preventDefault()}
                                    onPointerDownCapture={(event) => {
                                        if (event.pointerType === 'touch') {
                                            event.preventDefault();
                                        }
                                    }}
                                    onClick={onStartDictation}
                                    disabled={dictationActive}
                                    title={t('chat.dictation.start')}
                                    aria-label={t('chat.dictation.start')}
                                >
                                    <Icon name="mic" className={cn(iconSizeClass, 'text-current')} />
                                </button> : null}
                                <ComposerActionButtons
                                    followUpDelivery={followUpDelivery}
                                    isMobile={isMobile}
                                    footerIconButtonClass={footerIconButtonClass}
                                    sendIconSizeClass={sendIconSizeClass}
                                    stopIconSizeClass={stopIconSizeClass}
                                    canSend={canSend}
                                    canAbort={canAbort}
                                    hasContent={hasContent}
                                    currentSessionId={currentSessionId}
                                    newSessionDraftOpen={newSessionDraftOpen}
                                    onPrimaryAction={onPrimaryAction}
                                    onAbort={onAbort}
                                    escapeStops={escapeStops}
                                />
                            </div>
                        </div>
                    </div>
                </>
            ) : (
                <>
                    <div className={cn("flex items-center flex-shrink-0", footerGapClass)}>
                        <ComposerAttachmentControls
                            isVSCode={isVSCode}
                            footerIconButtonClass={footerIconButtonClass}
                            iconSizeClass={iconSizeClass}
                            handlePickLocalFiles={onPickLocalFiles}
                            openGitHubPicker={onOpenGitHubPicker}
                            repositoryProvider={repositoryProvider}
                                trackerPickers={trackerPickers}
                            onOpenSettings={isBtw ? undefined : onOpenSettings}
                            attachGuests={attachGuests}
                            onOpenGuestAttach={onOpenGuestAttach}
                            filesOnly={isBtw}
                        />
                        {!isBtw ? <FocusModeButton
                            footerIconButtonClass={footerIconButtonClass}
                            iconSizeClass={iconSizeClass}
                            isExpandedInput={isExpandedInput}
                            onToggle={onToggleExpandedInput}
                        /> : null}
                        {!nativeTarget ? <PermissionAutoAcceptButton
                            footerIconButtonClass={footerIconButtonClass}
                            iconSizeClass={iconSizeClass}
                            isInteractive={isPermissionAutoAcceptInteractive}
                            permissionMode={permissionMode}
                            handlePermissionModeCycle={onCyclePermissionMode}
                            withTooltip
                        /> : null}
                        {!isBtw ? <SessionGoalButton
                            sessionId={currentSessionId}
                            directory={directory}
                            draftOpen={newSessionDraftOpen}
                            footerIconButtonClass={footerIconButtonClass}
                            iconSizeClass={iconSizeClass}
                            withTooltip
                        /> : null}
                        {!isBtw ? <SessionGoalObjectiveCounter length={messageLength} /> : null}
                    </div>
                    <div className={cn('flex items-center flex-1 justify-end', isVSCode ? cn(footerGapClass, 'md:gap-x-3') : 'gap-x-2')} data-dictation-chain="true">
                        {waitingForOpenCode ? <OpenCodeStartupNote className="flex-shrink-0" /> : null}
                        {parallelRun ? <MemoModelControls className="flex-1 min-w-0" agentOnly /> : isBtw ? (
                            <ModelControls
                                className="flex-1 min-w-0 justify-end"
                                sessionId={modelSessionId ?? null}
                                selection={btwSelection}
                                rememberVariantPicks={false}
                                modelSelectorOpen={scopedModelSelectorOpen}
                                onModelSelectorOpenChange={onScopedModelSelectorOpenChange}
                            />
                        ) : pinnedSelection ? (
                            <ModelControls
                                className="flex-1 min-w-0 justify-end"
                                sessionId={currentSessionId}
                                selection={pinnedSelection}
                                rememberVariantPicks
                                modelSelectorOpen={scopedModelSelectorOpen}
                                onModelSelectorOpenChange={onScopedModelSelectorOpenChange}
                            />
                        ) : <MemoModelControls className="flex-1 min-w-0 justify-end" onRunInParallel={onRunInParallel} />}
                        {!isBtw ? <MemoComposerDictation
                            radius={chatInputRadius}
                            isMobile={isMobile}
                            footerIconButtonClass={footerIconButtonClass}
                            footerPaddingClass={footerPaddingClass}
                            iconSizeClass={iconSizeClass}
                            sendIconSizeClass={sendIconSizeClass}
                            onInsert={onDictationInsert}
                            onInsertAndSend={onDictationInsertAndSend}
                            onSendStart={onDictationSendStart}
                            onStart={onDictationStart}
                            onContentHeightChange={onDictationContentHeightChange}
                            onActiveChange={onDictationActiveChange}
                        /> : null}
                        {parallelRun ? (
                            <ComposerActionButtons
                                followUpDelivery={followUpDelivery}
                                isMobile={isMobile}
                                footerIconButtonClass={footerIconButtonClass}
                                sendIconSizeClass={sendIconSizeClass}
                                stopIconSizeClass={stopIconSizeClass}
                                canSend={canSend && parallelRun.runCount >= 2 && !parallelRun.launching}
                                canAbort={false}
                                hasContent={hasContent}
                                currentSessionId={currentSessionId}
                                newSessionDraftOpen={newSessionDraftOpen}
                                onPrimaryAction={parallelRun.onLaunch}
                                onAbort={onAbort}
                                sendLabel={t('chat.parallel.runAria', { count: parallelRun.runCount })}
                            />
                        ) : <ComposerActionButtons
                            followUpDelivery={followUpDelivery}
                            isMobile={isMobile}
                            footerIconButtonClass={footerIconButtonClass}
                            sendIconSizeClass={sendIconSizeClass}
                            stopIconSizeClass={stopIconSizeClass}
                            canSend={canSend}
                            canAbort={canAbort}
                            hasContent={hasContent}
                            currentSessionId={currentSessionId}
                            newSessionDraftOpen={newSessionDraftOpen}
                            onPrimaryAction={onPrimaryAction}
                            onAbort={onAbort}
                            escapeStops={escapeStops}
                        />}
                    </div>
                </>
            )}
        </div>
    );
}

export const ComposerFooter = React.memo(ComposerFooterView);
