import React from 'react';
import { formatChangeRequestReference } from '@/lib/source-control/identity';
import { ComposerDictation } from '@/components/dictation/ComposerDictation';
import { useConfigStore } from '@/stores/useConfigStore';
import { filterVisibleAgents } from '@/stores/useAgentsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useAutoReviewStore } from '@/stores/useAutoReviewStore';
import { useSessionGoalArmStore } from '@/stores/useSessionGoalArmStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { isNativeSessionId, isUnifiedNativeSessionId, nativeBackendOfProviderId, nativeBackendOfSessionId, unifiedNativeSessionState, NATIVE_AGENT_NAMES } from '@/lib/native-agents/ids';
import { useUnifiedNativeState } from '@/lib/native-agents/useNativeSession';
import {
    createMessageQueueTarget,
    getMessageQueueKey,
    useMessageQueueStore,
    type QueuedMessage,
} from '@/stores/messageQueueStore';
import { isFollowUpQueueClaimAvailable } from '@/lib/followUpQueue';
import { useSelectionStore } from '@/sync/selection-store';
import { prepareLocalAttachments, useDraftAttachedFiles, useInputStore } from '@/sync/input-store';
import { buildZipUploadNote } from '@/sync/zip-attachments';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { openParallelComposer } from '@/lib/multirun/openParallelComposer';
import { useParallelComposer } from './composer/parallel/useParallelComposer';
import { ParallelComposerStrip } from './composer/parallel/ParallelComposerStrip';
import {
    ACCEPTED_ATTACHMENT_EXTENSIONS,
    ATTACHMENT_ACCEPT,
    getUnsupportedAttachmentInputs,
    isReadOnSendMentionFilename,
    type AttachmentInputModality,
} from '@/sync/attachment-files';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import * as sessionActions from '@/sync/session-actions';
import { isNativeLocalCommand, nativeCompactCommand } from '@/sync/native-send';
import { useSessionHasBackgroundTasks } from '@/sync/session-background-tasks';
import { useSessionPermissions, useSessionForms } from "@/sync/sync-context";
// Guest surfaces load on demand: VS Code and mobile never mount them, and the
// composer must not pay for the guest bridge before an extension is installed.
const GuestAttachDialog = React.lazy(() => import('@/components/layout/GuestAttachDialog').then((module) => ({ default: module.GuestAttachDialog })));
import type { AttachIssueRequest } from '@openchamber/sdk';
import { getInlineCommentDraftKey, useInlineCommentDraftStore, type InlineCommentDraft, type InlineCommentDraftTarget } from '@/stores/useInlineCommentDraftStore';
import { useSnippetsStore } from '@/stores/useSnippetsStore';
import { renderMagicPrompt } from '@/lib/magicPrompts';
import {
    getRuntimeKey,
    getRuntimeEndpointGeneration,
    RuntimeContextChangedError,
    subscribeRuntimeEndpointWillChange,
} from '@/lib/runtime-switch';
import { runtimeFetch } from '@/lib/runtime-fetch';
import {
    createChatDraftIdentity,
    getChatDraftIdentityKey,
    clearChatDraft,
    readChatDraft,
    writeChatDraft,
    type ChatDraftIdentity,
    type ChatDraftSnapshot,
} from '@/lib/chatDraftPersistence';
import { CHAT_DRAFT_PROJECT_ID } from '@/lib/chatDirectories';
import { ReviewFlowDialog } from '@/components/session/ReviewFlowDialog';
import { useReviewFlowStart } from '@/components/session/useReviewFlowStart';
import { BtwPanel } from './btw/BtwPanel';
import { useBtwPanelState } from './btw/useBtwPanelState';
import { btwModelAvailability, resolveBtwSelection, useBtwStore } from '@/stores/useBtwStore';
import { buildBtwSyntheticTexts, destroyBtwSession, preparePendingBtwSend, startBtwSession, type BtwSessionRef } from '@/lib/btw';
import { AttachedFilesList, AttachedVSCodeFileChips, ActiveEditorFileSuggestion } from './FileAttachment';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import type { ToolPopupContent } from './message/types';
import { AutoReviewStrip } from './AutoReviewStrip';
import type { FileMentionHandle } from './FileMentionAutocomplete';
import type { CommandAutocompleteHandle, CommandInfo } from './CommandAutocomplete';
import type { SkillAutocompleteHandle } from './SkillAutocomplete';
import type { SnippetAutocompleteHandle } from './SnippetAutocomplete';
import { cn } from "@/lib/utils";
import { ModelControls } from './ModelControls';
import { parseAgentMentions } from '@/lib/messages/agentMentions';
import { shouldSubmitEnter } from './composer/keyboardPolicy';
import { getDropdownNavigationKey } from '@/components/ui/dropdown-navigation';
import { useChatColumnActions, useChatColumnExpandedInput, useChatColumnSession, type ChatColumnSession } from './chatColumnSession';
import { usePinnedComposerSelection } from './pinnedComposerSelection';
import { useChatSurfaceMode } from './useChatSurfaceMode';
import { MobileAgentButton } from './MobileAgentButton';
import { MobileModelButton } from './MobileModelButton';
import { useSessionActivity } from '@/hooks/useSessionActivity';
import { toast } from '@/components/ui';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useTabletLayout } from '@/lib/device';
import { useHardwareKeyboard } from '@/lib/hardwareKeyboard';
import { isCapacitorApp } from '@/lib/platform';
import { isIMECompositionEvent } from '@/lib/ime';
import { setNativeImagePasteEnabled, subscribeToNativeImagePastes } from '@/lib/nativeImagePaste';
import { getCycledPrimaryAgentName, type MobileControlsPanel } from './mobileControlsUtils';
import { isAutoModel } from '@/lib/routing/autoModel';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { ReferencePickerDialog } from '@/components/references/ReferencePickerDialog';
import { useAttachReferences } from '@/components/references/useAttachReferences';
import { useRepositoryReferenceProvider } from '@/components/references/referenceSources';
import {
    composerReferenceKey,
    toContextReference,
    toLinkedIssue,
    withComposerReferences,
    withoutComposerReference,
    type ComposerReference,
} from './composer/composerReferences';
import { usePendingComposerReferences } from './composer/pendingComposerReferences';
import { postLinearSessionStarted } from '@/lib/linearSessionStatus';
import { Icon } from "@/components/icon/Icon";
import { DraftPresetChips } from './DraftPresetChips';
import type { ResolvedStarter } from './useDraftStarters';
import { useChatSearchDirectory } from '@/hooks/useChatSearchDirectory';
import { useGuestAttachItems, useGuestCommands } from '@/hooks/useGuestSurfaces';
import { useGuestDialogStore } from '@/lib/guests/dialog-store';
import { useGuestItemStore } from '@/lib/guests/item-store';
import { runGuestCommand } from '@/lib/guests/run-command';
import { useGuestsStore } from '@/lib/guests/store';
import { isGuestActive } from '@/lib/guests/capabilities';
import { routeGuestSlashCommand } from './composer/submit/guestCommands';
import { CODEX_COMPOSER_COMMANDS, parseCodexComposerCommand } from '@/lib/native-agents/codex-commands';
import { NativeAgentsRequestError, nativeSessionActionErrorKey } from '@/lib/native-agents/errors';
import { executeCodexComposerCommand } from './composer/submit/codexCommands';
import { CodexCommandOutput, type CodexCommandOutputState } from './CodexCommandOutput';
import { pluginModeFromId } from '@/lib/surfaces/modes';
import { opencodeClient, type SkillMentions } from '@/lib/opencode/client';
import { buildSkillMentionInstruction } from '@/lib/skillMentionInstruction';
import { useGitStore } from '@/stores/useGitStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { selectSkillsForDirectory, useSkillsStore } from '@/stores/useSkillsStore';
import { selectCommandsForDirectory, useCommandsStore } from '@/stores/useCommandsStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { usePermissionStore } from '@/stores/permissionStore';
import { cyclePermissionMode } from './permissionAutoAccept';
import { displayedPermissionMode, nextPermissionMode } from '@/stores/utils/permissionAutoAccept';
import { selectAutoReady, selectSafetyNetAvailable, useRoutingStore } from '@/stores/useRoutingStore';
import { useKeybind } from '@/hooks/useKeybind';
import { hasOpenDropdown } from '@/hooks/keyboard-shortcut-dom';
import { useAuthSessionStore } from '@/lib/runtime-auth-expiry';
import { useI18n } from '@/lib/i18n';
import { sessionEvents } from '@/lib/sessionEvents';
import { createOpenCodeIdentifier } from '@/lib/opencode/identifier';
import { fetchResponseStyleInstruction } from '@/lib/responseStyle';
import { wrapSystemReminder } from '@/lib/systemReminder';
import { getSyncMessages } from '@/sync/sync-refs';
import { useOpenCodeStartupStore } from '@/sync/opencode-startup-gate';
import { eventMatchesShortcut, getEffectiveShortcutCombo, normalizeCombo } from '@/lib/shortcuts';
import {
    assignImageAttachmentFilenames,
    buildAttachmentCitationText,
    nextPastedContextFilename,
    renameFileForAttachmentCitation,
} from './attachmentCitations';
import {
    createPastedContextFile,
    isLargePlainTextPaste,
    LargeTextPasteGesture,
    type LargeTextPasteCandidate,
} from './composer/largeTextPaste';
import {
    beginLargeTextPasteOffer,
    resolveLargeTextPasteOffer,
} from './composer/largeTextPasteOffer';
import type { LargeTextPasteBehavior } from '@/stores/useUIStore';
import type { FileMentionAutocompleteInputSource } from './fileMentionAutocompleteState';
import {
    classifyMention,
    scanMentions,
} from './composer/language/mentions';
import { collectKnownTokenNames } from './composer/language/prefixTokens';
import { resolveAutocompleteTrigger, type AutocompleteKind } from './composer/language/triggers';
import { type ComposerLanguageContext } from './composer/language/tokenize';
import {
    ComposerEditor,
    type ComposerChange,
    type ComposerEditorHandle,
} from './composer/editor/ComposerEditor';
import { useComposerHeightLimit } from './composer/editor/useComposerHeightLimit';
import { usePendingComposerText } from './composer/state/usePendingComposerText';
import { createComposerEditorViewStore } from './composer/editor/viewStore';
import { composerAutoCorrect } from './composer/editor/autocorrect';
import {
    appendInlineText,
    appendWithLineBreaks,
    buildImagePasteInsertion,
    getMarkdownAutoPairEdit,
    shouldWrapSelectionAsLink,
    withInlineInsertionBoundaries,
} from './composer/text';
import {
    collectDroppedFileUris,
    collectDroppedFiles,
    hasDraggedFiles,
} from './composer/attachments/dataTransfer';
import {
    normalizeDroppedPath,
    normalizePath,
    toProjectRelativeMentionPath,
    toServerFileUrl,
} from './composer/attachments/filePaths';
import {
    INLINE_SERVER_ATTACHMENT_ID_PREFIX,
    filterMissingInlineAttachments,
} from './composer/attachments/inlineMentionAttachments';
import { buildOutgoingMessage, expandCommentSnippets, selectComposerQueue } from './composer/submit/buildOutgoingMessage';
import { resolveFollowUpDeliveryDecision, resolveNativeFollowUpDelivery } from './lib/followUpDrafts';
import {
    buildCommandVariables,
    canRunCommand,
    findMagicPromptCommand,
    parseSlashCommand,
    planLocalSlashCommand,
} from './composer/submit/slashCommands';
import { runForkCommand } from './composer/submit/forkCommand';
import { useAutocompletePosition } from './composer/state/useAutocompletePosition';
import { useMessageHistory } from './composer/state/useMessageHistory';
import { useComposerDraft } from './composer/state/useComposerDraft';
import { useSessionAssistState } from '@/hooks/useSessionAssist';
import { useDictationOrigin } from './composer/state/useDictationOrigin';
import { useDraftTarget } from './composer/state/useDraftTarget';
import { useMobileComposerShell } from './composer/state/useMobileComposerShell';
import { useMobileViewportPin } from './composer/state/useMobileViewportPin';
import { MobileCommentComposer } from './composer/comment/MobileCommentComposer';
import { useMobileCommentComposerController } from './composer/comment/MobileCommentComposerContext';
import { useMobileCommentComposerMode } from './composer/comment/useMobileCommentComposerMode';
import {
    DraftTargetSelectors,
    MobileDraftTargetSheets,
    MobileDraftTargetTriggers,
} from './composer/ui/DraftTargetSelectors';
import { NewSpaceDialog } from '@/components/session/spaces/NewSpaceDialog';
import { NewWorktreeDialog } from '@/components/session/NewWorktreeDialog';
import { isSpaceCreationRequest } from '@/lib/spaces/space-creation';
import { spaceModelRefusal, stoppedSpaceOfTarget } from '@/lib/spaces/space-model-access';
import { runSpaceAction } from '@/lib/spaces/space-repair';
import { useSpacesStore } from '@/lib/spaces/spaces-store';
import { isDraftSendWaiting, subscribeDraftSendWaiting } from '@/lib/worktrees/pendingDraftWorktree';
import { ComposerAutocompletePopups } from './composer/ui/ComposerAutocompletePopups';
import { ComposerFooter } from './composer/ui/ComposerFooter';
import { MobilePillComposer } from './composer/ui/MobilePillComposer';
import { ComposerContextChips } from './composer/ui/ComposerContextChips';
import { LargeTextPasteChoice, type LargeTextPasteChoiceAction } from './composer/ui/LargeTextPasteChoice';
import { LinkedReferenceRow } from './composer/ui/LinkedReferenceRow';
import { RevertedMessageDock } from './composer/ui/RevertedMessageDock';
import { SessionDoneHintRow } from '@/components/chat/SessionDoneHintRow';
import { SessionReviewHintRow } from '@/components/chat/SessionReviewHintRow';
import { BackgroundShellsStrip } from '@/components/chat/BackgroundShellsStrip';
import { ComposerStatusStrip } from '@/components/chat/ComposerStatusStrip';
import { useWorktreeBootstrapPending } from '@/hooks/useWorktreeBootstrapPending';
import { FormDock } from '@/components/chat/FormDock';
import { PermissionDock } from '@/components/chat/PermissionDock';
import { QueuedMessageChips } from './QueuedMessageChips';
import { PromptSuggestion } from './composer/ui/PromptSuggestion';
import { SessionGoalRow } from '@/components/chat/SessionGoalRow';
import {
    createInputHistoryIdentity,
    selectInputHistoryEntries,
    type InputHistorySubmission,
    useInputHistoryStore,
} from '@/stores/useInputHistoryStore';
import {
    buildChatInputHistorySubmissions,
    buildInputHistoryNavigatorIdentity,
    mapInputHistoryEntriesToValues,
    mergeSessionInputHistory,
} from './inputHistory';
import { useScopedBlockingForms, useScopedBlockingPermissions, useUserMessageHistory } from '@/sync/sync-context';
import { changeRequestCopy } from '@/lib/source-control/changeRequestCopy';

// Lazy like in ChatMessage: a static import would pull the @pierre/diffs and
// Shiki stacks into the eager startup graph for a dialog opened on demand.
const ToolOutputDialog = lazyWithChunkRecovery(() => import('./message/ToolOutputDialog'));

const MAX_VISIBLE_COMPOSER_LINES = 8;
/**
 * Mobile grows the composer with content instead of offering a fullscreen
 * gesture — the old swipe-up handle bought barely a line of extra height.
 * The real ceiling is measured: the editor may grow until the composer fills
 * its screen container (marked data-composer-bound in ChatContainer), with
 * the chrome around the editor read from the DOM. The line cap only stops
 * absurdly tall editors on tablets.
 */
const MAX_MOBILE_COMPOSER_LINES = 16;
/**
 * Breathing room between the fully grown composer and the top of its screen
 * container: without it the composer's border lands exactly on the header's
 * bottom edge on the chat screen. A visual gap by design, not an estimate.
 */
const MOBILE_COMPOSER_BOUND_GAP_PX = 4;
const EMPTY_QUEUE: QueuedMessage[] = [];
const NO_ATTACH_GUESTS: [] = [];
const COMPACT_CHAT_PLACEHOLDER_MAX_WIDTH = 560;

const getFileMentionInputSourceForInsertedText = (insertedText: string): FileMentionAutocompleteInputSource => (
    insertedText.includes('@') ? 'paste' : 'manual'
);

/**
 * Skills the user named with `$name`. Matched against the registry's exact
 * casing, since the name is echoed back to the model as a skill to load.
 */
const collectInlineSkillMentions = (text: string, skillNames: Set<string>): string[] =>
    collectKnownTokenNames(text, '$', skillNames, 'exact');

/** Which reference picker is open, and for GitHub on which tab. */
type ReferencePickerState = { source: 'github'; kind?: 'issue' | 'pull' } | { source: 'linear' } | null;

/**
 * Record what a session was pointed at, so the work-status panel can show it
 * as a context source long after the message scrolled away. A snapshot only —
 * never re-fetched, never authoritative. Failures are swallowed: the message
 * went out (or was queued), and a missing bookkeeping entry must not surface
 * as an error.
 */
const recordLinkedReferences = (
    sessionId: string,
    directory: Parameters<typeof sessionActions.addLinkedIssues>[1],
    references: readonly ComposerReference[],
) => {
    if (references.length === 0) return;
    const linkedAt = Date.now();
    void sessionActions.addLinkedIssues(
        sessionId,
        directory,
        references.map((reference) => toLinkedIssue(reference, linkedAt)),
    ).catch(() => undefined);
};

const hasUserMessages = (sessionId: string, directory?: string) => {
    return getSyncMessages(sessionId, directory).some((message) => message.role === 'user');
};

const renderDraftTitle = (title: string, projectLabel: string | null): React.ReactNode => {
    if (!projectLabel) return title;
    const projectIndex = title.indexOf(projectLabel);
    if (projectIndex === -1) return title;

    return (
        <>
            {title.slice(0, projectIndex)}
            <span className="font-medium">{projectLabel}</span>
            {title.slice(projectIndex + projectLabel.length)}
        </>
    );
};

/**
 * An event handler with one identity for the composer's lifetime that runs the
 * latest render's closure. Handlers that read the draft text would otherwise
 * be new on every keystroke and re-render every memoized child they reach.
 * Event handlers only: calling the result during render runs a stale closure.
 */
function useStableHandler<Args extends readonly unknown[], Result>(
    handler: (...args: Args) => Result,
): (...args: Args) => Result {
    const handlerRef = React.useRef(handler);
    React.useLayoutEffect(() => {
        handlerRef.current = handler;
    });
    return React.useCallback((...args: Args) => handlerRef.current(...args), []);
}

const MemoModelControls = React.memo(ModelControls);
const MemoComposerDictation = React.memo(ComposerDictation);
const MemoMobileAgentButton = React.memo(MobileAgentButton);

const MemoMobileModelButton = React.memo(MobileModelButton);

interface ChatInputProps {
    onOpenSettings?: () => void;
    scrollToBottom?: () => void;
    // Queued sends do not create a user row (the queue delivers later), so
    // the anchor-arming scrollToBottom is wrong for them; this returns the
    // viewport to the live edge instead.
    scrollToLatest?: () => void;
    active?: boolean;
    draftPresentationExiting?: boolean;
}

class SubmissionContextChangedError extends Error {
    constructor() {
        super('Submission context changed');
        this.name = 'SubmissionContextChangedError';
    }
}

// A new Chat's working directory moves from the Chats root to a prepared
// folder on the first keystroke. Its composer text keys on the Chats bucket
// instead, so that move neither clears what was typed nor leaves it behind
// under the root for the next new Chat to show.
const NEW_CHAT_DRAFT_DIRECTORY = CHAT_DRAFT_PROJECT_ID;

const resolveChatDraftIdentity = (column: ChatColumnSession | null): ChatDraftIdentity | null => {
    const sessionState = useSessionUIStore.getState();
    const sessionId = column ? column.sessionId : sessionState.currentSessionId;
    const draft = sessionState.newSessionDraft;
    const newSessionDirectory = draft?.open
        ? draft.target === 'chat' ? NEW_CHAT_DRAFT_DIRECTORY : draft.bootstrapPendingDirectory ?? draft.directoryOverride
        : null;
    const directory = sessionId
        ? sessionState.getDirectoryForSession(sessionId) ?? (column ? column.directory : sessionState.currentSessionDirectory)
        : newSessionDirectory ?? useDirectoryStore.getState().currentDirectory;
    return createChatDraftIdentity(getRuntimeKey(), directory, sessionId);
};

type AttachmentPickerInputProps = {
    ref: React.Ref<HTMLInputElement>;
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
};

// Memoized because React re-applies an input's `name` and `type` on every
// commit that reaches it (it clears `name` while setting `type`), and the
// composer renders on streamed updates while these props never change.
const AttachmentPickerInput = React.memo(function AttachmentPickerInput({ ref, onChange }: AttachmentPickerInputProps) {
    return (
        <input
            ref={ref}
            type="file"
            multiple
            className="hidden"
            onChange={onChange}
            accept={ATTACHMENT_ACCEPT}
        />
    );
});

const ChatInputComponent: React.FC<ChatInputProps> = ({
    onOpenSettings,
    scrollToBottom,
    scrollToLatest,
    active = true,
    draftPresentationExiting = false,
}) => {
    const { t } = useI18n();
    // The session this composer belongs to: its column's (see
    // chatColumnSession.ts); outside a column it follows the live selection.
    const chatColumnSession = useChatColumnSession();
    const { pinned: columnPinned, openTimelineDialog, focusInput: focusColumnInput } = useChatColumnActions();
    // Track if we restored a draft on mount (for text selection)
    const initialDraftRef = React.useRef<string | null>(null);
    const initialDraftIdentityRef = React.useRef<ChatDraftIdentity | null>(null);
    const initialDraftSnapshotRef = React.useRef<ChatDraftSnapshot>({ text: '', confirmedMentions: new Set() });
    const [message, setMessage] = React.useState(() => {
        const identity = resolveChatDraftIdentity(chatColumnSession);
        const snapshot = readChatDraft(identity);
        initialDraftIdentityRef.current = identity;
        initialDraftSnapshotRef.current = snapshot;
        if (snapshot.text) {
            initialDraftRef.current = snapshot.text;
        }
        return snapshot.text;
    });
    const confirmedMentionsRef = React.useRef<Set<string>>(initialDraftSnapshotRef.current.confirmedMentions);
    const [storedInputMode, setInputMode] = React.useState<'normal' | 'shell'>('normal');
    const inputModeParentRef = React.useRef<string | null>(null);
    const [isDragging, setIsDragging] = React.useState(false);
    const [isInternalDrag, setIsInternalDrag] = React.useState(false);
    // At most one picker is open at a time; the prompt language decides which.
    const [openAutocomplete, setOpenAutocomplete] = React.useState<AutocompleteKind | null>(null);
    const [autocompleteQuery, setAutocompleteQuery] = React.useState('');
    const closeAutocomplete = React.useCallback(() => setOpenAutocomplete(null), []);
    const [mobileControlsPanel, setMobileControlsPanel] = React.useState<MobileControlsPanel>(null);
    const [mobileAttachMenuOpen, setMobileAttachMenuOpen] = React.useState(false);
    const [mobileDraftPicker, setMobileDraftPicker] = React.useState<'project' | 'branch' | null>(null);
    // Message history navigation state (up/down arrow to recall previous messages)
    const composerRef = React.useRef<ComposerEditorHandle>(null);
    // The mobile composer swaps between the collapsed pill and the full
    // composer, which unmounts the editor. Building a CodeMirror view is far
    // from free, and it would happen inside the tap that expands the pill —
    // before the browser may paint the swap. The store keeps one view alive for
    // as long as the composer itself is mounted.
    const composerViewStore = React.useRef(createComposerEditorViewStore()).current;
    React.useEffect(() => () => {
        composerViewStore.view?.destroy();
        composerViewStore.view = null;
    }, [composerViewStore]);
    const composerFormRef = React.useRef<HTMLFormElement | null>(null);
    const cursorPosRef = React.useRef(0);
    const dropZoneRef = React.useRef<HTMLDivElement>(null);
    const dragEnterCountRef = React.useRef(0);
    const suppressNextFileDropTextInsertRef = React.useRef(false);
    const suppressNextFileDropTextInsertTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const suppressNextFileMentionPasteRef = React.useRef(false);
    const suppressNextFileMentionPasteTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const shellTriggerNormalizationRef = React.useRef(false);
    const pendingDroppedAbsolutePathsRef = React.useRef<string[]>([]);
    const canAcceptDropRef = React.useRef(false);
    const mentionRef = React.useRef<FileMentionHandle>(null);
    const commandRef = React.useRef<CommandAutocompleteHandle>(null);
    const skillRef = React.useRef<SkillAutocompleteHandle>(null);
    const snippetRef = React.useRef<SnippetAutocompleteHandle>(null);
    // Ref to track current message value without triggering re-renders in effects
    const messageRef = React.useRef(message);
    const dictationSendInFlightRef = React.useRef(false);
    const pendingPastedAttachmentFilenamesRef = React.useRef<Set<string>>(new Set());
    // The message ID and text of the last failed submission. Re-submitting
    // the same restored text reuses the ID so OpenCode merges the retry into
    // the (possibly accepted) original message instead of creating a
    // duplicate that spawns a second AI response.
    const lastSubmitRef = React.useRef<{ messageId: string; text: string } | undefined>(undefined);
    // The unanswered large-paste choice; `resolve` applies the answer once.
    const [largeTextPasteOffer, setLargeTextPasteOffer] = React.useState<{
        id: number;
        resolve: (action: LargeTextPasteChoiceAction, explicitlyChosen: boolean, typedText?: string) => void;
    } | null>(null);
    const largeTextPasteOfferIdRef = React.useRef(0);
    const [largeTextPasteGesture] = React.useState(() => new LargeTextPasteGesture());

    // TODO: port sendMessage to session-actions (complex — creates sessions, handles attachments, etc.)
    // oxlint-disable-next-line typescript/no-explicit-any
    const sendMessage = React.useRef((...args: any[]) =>
        Promise.resolve((useSessionUIStore.getState().sendMessage as (...a: unknown[]) => unknown)(...args)),
    ).current;
    // Inside the chat column the composer follows the session the timeline is
    // showing (see chatColumnSession.ts); elsewhere it follows the live one.
    const liveSessionId = useSessionUIStore((s) => (chatColumnSession ? null : s.currentSessionId));
    const currentSessionId = chatColumnSession ? chatColumnSession.sessionId : liveSessionId;
    React.useEffect(() => {
        if (inputModeParentRef.current !== null && inputModeParentRef.current !== currentSessionId) {
            setInputMode('normal');
        }
        inputModeParentRef.current = currentSessionId;
    }, [currentSessionId]);
    const fallbackDirectory = useDirectoryStore((s) => s.currentDirectory);
    const liveEffectiveDirectory = useEffectiveDirectory();
    const currentDirectory = (chatColumnSession?.sessionId ? chatColumnSession.directory : null)
        ?? liveEffectiveDirectory
        ?? fallbackDirectory;
    const currentSessionDirectoryForSync = useSessionUIStore(
        React.useCallback((s) => currentSessionId ? s.getDirectoryForSession(currentSessionId) : null, [currentSessionId]),
    );
    // btw mode: the CURRENT session's metadata links an active btw fork and
    // the panel is expanded, so this composer's sends route to the fork
    // instead of the main session. Collapsed keeps the fork alive (chip stays
    // visible) while the composer talks to the main session again.
    const btwPanel = useBtwPanelState(currentSessionId, currentSessionDirectoryForSync ?? currentDirectory ?? undefined);
    const pendingForms = useScopedBlockingForms(currentSessionId, currentSessionDirectoryForSync ?? currentDirectory ?? undefined);
    const pendingPermissions = useScopedBlockingPermissions(currentSessionId, currentSessionDirectoryForSync ?? currentDirectory ?? undefined);
    const hasPendingPermission = pendingPermissions.length > 0;
    // A pending permission or form owns the dock; the composer is not for sending then.
    const hasPendingForm = pendingForms.length > 0 || hasPendingPermission;
    const btwSessionId = btwPanel.btwSessionId;
    const btwDirectory = btwPanel.btwDirectory;
    const btwSessionRef = React.useMemo<BtwSessionRef | null>(
        () => (currentSessionId && btwSessionId && btwDirectory
            ? { parentSessionId: currentSessionId, btwSessionId, directory: btwDirectory }
            : null),
        [btwDirectory, btwSessionId, currentSessionId],
    );
    const btwComposerSessionId = btwPanel.pending && currentSessionId
        ? `btw-pending:${currentSessionId}`
        : btwSessionId;
    const isBtwActive = Boolean(btwComposerSessionId) && !btwPanel.collapsed;
    const isBtwPanelVisible = Boolean((btwPanel.btwSessionId && btwPanel.btwDirectory) || btwPanel.creating || btwPanel.pending);
    const immediateBtwSubmitRef = React.useRef<{ identity: ChatDraftIdentity; text: string } | null>(null);
    const draftCaretModeRef = React.useRef({ btw: isBtwActive, atEnd: isBtwActive });
    const inputMode = isBtwActive ? 'normal' : storedInputMode;
    // A session promoted out of `/btw` keeps the boundary instructions in its
    // transcript — there is no way to delete a message part — so it has to say
    // they no longer apply.
    const isPromotedBtwSession = btwPanel.parentPromoted;
    const activeRuntimeKey = getRuntimeKey();
    const isNewChatDraft = useSessionUIStore((s) => (
        !columnPinned && !currentSessionId && Boolean(s.newSessionDraft?.open) && s.newSessionDraft.target === 'chat'
    ));
    const chatDraftIdentity = React.useMemo(
        () => createChatDraftIdentity(
            activeRuntimeKey,
            isNewChatDraft ? NEW_CHAT_DRAFT_DIRECTORY : currentSessionDirectoryForSync ?? currentDirectory,
            isBtwActive ? btwComposerSessionId : currentSessionId,
        ),
        [activeRuntimeKey, btwComposerSessionId, currentDirectory, currentSessionDirectoryForSync, currentSessionId, isBtwActive, isNewChatDraft],
    );
    const claimAttachmentSlot = React.useCallback(() => {
        useInputStore.getState().selectAttachmentDraft(chatDraftIdentity);
    }, [chatDraftIdentity]);
    const newSessionDraft = useSessionUIStore((s) => s.newSessionDraft);
    const currentChatDraftIdentityRef = React.useRef(chatDraftIdentity);
    currentChatDraftIdentityRef.current = chatDraftIdentity;
    // The new-session draft is the main chat's; a pinned composer is never on it.
    const newSessionDraftOpen = !columnPinned && Boolean(newSessionDraft?.open);
    const draftPermissionMode = useSessionUIStore((s) => (
        s.newSessionDraft?.open ? s.newSessionDraft.permissionMode : undefined
    ));
    const setNewSessionDraftTarget = useSessionUIStore((s) => s.setNewSessionDraftTarget);
    const setDraftPermissionMode = useSessionUIStore((s) => s.setDraftPermissionMode);
    const prepareChatDraftDirectory = useSessionUIStore((s) => s.prepareChatDraftDirectory);
    const abortPromptSessionId = useSessionUIStore((s) => s.abortPromptSessionId);
    const clearAbortPrompt = useSessionUIStore((s) => s.clearAbortPrompt);
    const attachedFiles = useDraftAttachedFiles(chatDraftIdentity);
    const addAttachedFile = useInputStore((s) => s.addAttachedFile);
    const clearAttachedFiles = useInputStore((s) => s.clearAttachedFiles);
    const saveSessionAgentSelection = useSelectionStore((s) => s.saveSessionAgentSelection);
    const btwModelSelection = useSelectionStore(React.useCallback(
        (s) => btwComposerSessionId ? s.sessionModelSelections.get(btwComposerSessionId) ?? null : null,
        [btwComposerSessionId],
    ));
    const btwAgentSelection = useSelectionStore(React.useCallback(
        (s) => btwComposerSessionId ? s.sessionAgentSelections.get(btwComposerSessionId) ?? null : null,
        [btwComposerSessionId],
    ));
    const consumePendingBtwComposerRequest = useInputStore((s) => s.consumePendingBtwComposerRequest);
    const pendingBtwComposerRequest = useInputStore((s) => s.pendingBtwComposerRequest);
    const pendingPresetSubmit = useInputStore((s) => s.pendingPresetSubmit);
    const pendingDraftSubmit = useInputStore((s) => s.pendingDraftSubmit);
    const setPendingInputText = useInputStore((s) => s.setPendingInputText);
    const pendingGuestIssue = useInputStore((s) => s.pendingGuestIssue);
    const consumePendingGuestIssue = useInputStore((s) => s.consumePendingGuestIssue);
    const pendingComposerReferenceCount = usePendingComposerReferences((s) => s.references.length);

    React.useEffect(() => {
        if (!newSessionDraftOpen || newSessionDraft.target !== 'chat' || message.trim().length === 0) return;
        void prepareChatDraftDirectory();
    }, [message, newSessionDraft.target, newSessionDraftOpen, prepareChatDraftDirectory]);
    const consumePendingSyntheticParts = useInputStore((s) => s.consumePendingSyntheticParts);
    const setPendingSyntheticParts = useInputStore((s) => s.setPendingSyntheticParts);
    const acknowledgeSessionAbort = useSessionUIStore((s) => s.acknowledgeSessionAbort);
    const abortCurrentOperation = React.useCallback(
        (sessionIdOverride?: string) => sessionActions.abortCurrentOperation(sessionIdOverride ?? currentSessionId ?? ''),
        [currentSessionId],
    );
    const currentManagementSessionId = currentSessionId;
    const [reviewDialogOpen, setReviewDialogOpen] = React.useState(false);
    // Mounted from the first open on, so it costs nothing until then and its
    // close animation still plays afterwards.
    const [reviewDialogMounted, setReviewDialogMounted] = React.useState(false);
    if (reviewDialogOpen && !reviewDialogMounted) setReviewDialogMounted(true);
    const closeReviewDialog = React.useCallback(() => setReviewDialogOpen(false), []);

    // A pinned column's composer sends with its own selection; the app-wide
    // current model, agent and effort belong to the main chat.
    const pinnedComposerSelection = usePinnedComposerSelection({
        enabled: columnPinned,
        sessionId: currentSessionId,
        directory: currentDirectory ?? null,
    });
    // Pending text and context other parts of the app leave for "the
    // composer" are the main chat's; a pinned composer takes only what was
    // addressed to its session (see input-store `pendingInputTarget`).
    const mailboxTarget = columnPinned ? currentSessionId : null;
    const configProviderId = useConfigStore((state) => state.currentProviderId);
    const configModelId = useConfigStore((state) => state.currentModelId);
    const configCatalogLoaded = useConfigStore((state) => state.providersLoaded && state.agentsLoaded);
    const currentProviderId = pinnedComposerSelection?.model?.providerId ?? configProviderId;
    const currentModelId = pinnedComposerSelection?.model?.modelId ?? configModelId;

    const [codexCommandOutput, setCodexCommandOutput] = React.useState<CodexCommandOutputState | null>(null);
    const codexCommandRunning = React.useRef(false);
    React.useEffect(() => {
        setCodexCommandOutput(null);
    }, [activeRuntimeKey, currentSessionId, currentDirectory]);

    // A native CLI session, or a draft that becomes one on send. The CLI runs
    // its own slash commands and has no shell mode.
    const unifiedState = useUnifiedNativeState(currentSessionId, currentSessionDirectoryForSync ?? currentDirectory);
    const nativeTargetBackend = currentSessionId
        ? nativeBackendOfSessionId(currentSessionId)
            ?? (isUnifiedNativeSessionId(currentSessionId) ? nativeBackendOfProviderId(currentProviderId ?? '') ?? unifiedState?.backend ?? null : null)
        : newSessionDraftOpen && currentProviderId ? nativeBackendOfProviderId(currentProviderId) : null;
    const isNativeTarget = nativeTargetBackend !== null || Boolean(currentSessionId && isNativeSessionId(currentSessionId));
    const getModelMetadata = useConfigStore((state) => state.getModelMetadata);
    // Subscribe to both sources read by getModelMetadata so async metadata and provider updates are observed.
    useConfigStore((state) => state.modelsMetadata);
    const providerCatalog = useConfigStore((state) => state.providers);
    const autoReady = useRoutingStore(selectAutoReady);
    const currentModelMetadata = currentProviderId && currentModelId
        ? getModelMetadata(currentProviderId, currentModelId)
        : undefined;
    const configVariant = useConfigStore((state) => state.currentVariant);
    const currentVariant = pinnedComposerSelection ? pinnedComposerSelection.variant ?? undefined : configVariant;
    const currentVariantSelection = useConfigStore((state) => state.currentVariantSelection);
    const configAgentName = useConfigStore((state) => state.currentAgentName);
    const currentAgentName = pinnedComposerSelection?.agent ?? configAgentName;
    const setAgent = useConfigStore((state) => state.setAgent);
    // Filtered here rather than through `getVisibleAgents()`, which returns a
    // new array on every call: that identity would rebuild the language
    // context, and with it re-tokenize the editor, on every keystroke.
    const allAgents = useConfigStore((state) => state.agents);
    const agents = React.useMemo(() => filterVisibleAgents(allAgents), [allAgents]);
    const btwSavedVariant = useSelectionStore(React.useCallback(
        (state) => btwComposerSessionId && btwAgentSelection && btwModelSelection
            ? state.getAgentModelVariantForSession(
                btwComposerSessionId,
                btwAgentSelection,
                btwModelSelection.providerId,
                btwModelSelection.modelId,
            )
            : undefined,
        [btwAgentSelection, btwComposerSessionId, btwModelSelection],
    ));
    const btwComposerVariant = currentVariantSelection.override === null ? null : currentVariantSelection.override ?? configVariant;
    // Memoized: the footer and its model controls compare this selection by
    // identity, and nothing in it changes while the user types.
    const effectiveBtwSelection = React.useMemo(() => resolveBtwSelection({
        agents,
        savedAgent: btwAgentSelection,
        isModelAvailable: btwModelAvailability(providerCatalog, autoReady),
        savedModel: btwModelSelection,
        savedVariant: btwSavedVariant,
        composerModel: currentProviderId && currentModelId ? { providerId: currentProviderId, modelId: currentModelId } : null,
        composerVariant: btwComposerVariant,
        // A CLI's plan mode can switch to another model and answers far
        // slower, so a side question in a native session builds instead.
        defaultAgent: isNativeTarget ? 'build' : 'plan',
    }), [agents, autoReady, btwAgentSelection, btwComposerVariant, btwModelSelection, btwSavedVariant, currentModelId, currentProviderId, isNativeTarget, providerCatalog]);
    React.useEffect(() => {
        const { model, agent, variant } = effectiveBtwSelection;
        if (!isBtwActive || !btwComposerSessionId || !model || !agent) return;
        const selections = useSelectionStore.getState();
        if (selections.getSessionModelSelection(btwComposerSessionId)) return;
        selections.saveSessionAgentSelection(btwComposerSessionId, agent);
        selections.saveSessionModelSelection(btwComposerSessionId, model.providerId, model.modelId);
        selections.saveAgentModelForSession(btwComposerSessionId, agent, model.providerId, model.modelId);
        selections.saveAgentModelVariantForSession(btwComposerSessionId, agent, model.providerId, model.modelId, variant);
    }, [btwComposerSessionId, effectiveBtwSelection, isBtwActive]);
    const isMobile = useUIStore((state) => state.isMobile);
    const hasHardwareKeyboard = useHardwareKeyboard();
    const enterToSend = useUIStore((state) => state.enterToSend);
    const enterToSendConfigured = useUIStore((state) => state.enterToSendConfigured);
    const { enabled: isTabletLayout } = useTabletLayout();
    const setImagePreviewOpen = useUIStore((state) => state.setImagePreviewOpen);
    const inputBarOffset = useUIStore((state) => state.inputBarOffset);
    const persistChatDraft = useUIStore((state) => state.persistChatDraft);
    const followUpBehavior = useMessageQueueStore((state) => state.followUpBehavior);
    const queueRuntimeKey = useMessageQueueStore((state) => state.runtimeKey);
    const queueGeneration = useMessageQueueStore((state) => state.generation);
    const messageQueueTarget = React.useMemo(
        () => currentSessionId
            ? createMessageQueueTarget(
                currentSessionId,
                currentSessionDirectoryForSync ?? currentDirectory,
                queueRuntimeKey,
            )
            : null,
        [currentDirectory, currentSessionDirectoryForSync, currentSessionId, queueRuntimeKey],
    );
    const messageQueueKey = messageQueueTarget ? getMessageQueueKey(messageQueueTarget) : null;
    const queuedMessages = useMessageQueueStore(
        React.useCallback(
            (state) => messageQueueKey
                ? state.queuedMessages[messageQueueKey] ?? EMPTY_QUEUE
                : EMPTY_QUEUE,
            [messageQueueKey],
        ),
    );
    const addToQueue = useMessageQueueStore((state) => state.addToQueue);
    const setQueuedStatus = useMessageQueueStore((state) => state.setQueuedStatus);
    const watchQueueSession = useMessageQueueStore((state) => state.watchSession);
    const claimQueuedMessage = useMessageQueueStore((state) => state.claim);
    const completeQueuedMessage = useMessageQueueStore((state) => state.complete);
    const releaseQueuedMessage = useMessageQueueStore((state) => state.release);
    const queuedMessageSendInFlightRef = React.useRef<{ itemId: string } | null>(null);
    const queuedDrainInFlightRef = React.useRef<{ itemId: string } | null>(null);
    const [sendingQueuedMessageId, setSendingQueuedMessageId] = React.useState<string | null>(null);
    const inputSpellcheckEnabled = useUIStore((state) => state.inputSpellcheckEnabled);
    const largeTextPasteBehavior = useUIStore((state) => state.largeTextPasteBehavior);
    const largeTextPasteScope = JSON.stringify([
        activeRuntimeKey, chatDraftIdentity ? getChatDraftIdentityKey(chatDraftIdentity) : null,
        inputMode, largeTextPasteBehavior,
    ]);
    const largeTextPasteScopeRef = React.useRef(largeTextPasteScope);
    React.useLayoutEffect(() => {
        largeTextPasteScopeRef.current = largeTextPasteScope;
        largeTextPasteGesture.invalidate();
        // An unanswered choice belongs to the draft it was pasted into; it
        // must not land in another one. The text is still on the clipboard.
        largeTextPasteOfferIdRef.current += 1;
        setLargeTextPasteOffer(null);
        return () => largeTextPasteGesture.invalidate();
    }, [largeTextPasteGesture, largeTextPasteScope]);
    React.useEffect(() => subscribeRuntimeEndpointWillChange(() => largeTextPasteGesture.invalidate()), [largeTextPasteGesture]);

    const getLargeTextPasteScope = React.useCallback(() => (
        JSON.stringify([getRuntimeKey(), largeTextPasteScopeRef.current, useInputStore.getState().attachmentDraftKey])
    ), []);

    const readLargeTextPasteSnapshot = React.useCallback(() => {
        const editor = composerRef.current;
        if (!editor) return null;
        return {
            value: editor.getValue(), selection: editor.getSelection(),
            scope: getLargeTextPasteScope(),
        };
    }, [getLargeTextPasteScope]);
    const { expanded: persistedExpandedInput, setExpanded: setExpandedInput } = useChatColumnExpandedInput();
    const isExpandedInput = !isBtwActive && persistedExpandedInput;
    const setTimelineDialogOpen = useUIStore((state) => state.setTimelineDialogOpen);
    const { git: runtimeGit, vscode: vscodeApi, linear: runtimeLinear, nativeAgents } = useRuntimeAPIs();
    const cycleAgentShortcutOverride = useUIStore((state) => state.shortcutOverrides.cycle_agent);
    const cycleAgentShortcut = React.useMemo(() => (
        getEffectiveShortcutCombo('cycle_agent', cycleAgentShortcutOverride ? { cycle_agent: cycleAgentShortcutOverride } : undefined)
    ), [cycleAgentShortcutOverride]);
    const { currentTheme } = useThemeSystem();
    const chatSearchDirectory = useChatSearchDirectory();
    const ensureGitStatus = useGitStore((state) => state.ensureStatus);
    const fetchGitStatus = useGitStore((state) => state.fetchStatus);
    const clearGitDiffCache = useGitStore((state) => state.clearDiffCache);
    const setSessionMode = usePermissionStore((state) => state.setSessionMode);
    const pendingBtwPermissionMode = useBtwStore(React.useCallback(
        (state) => currentSessionId ? state.byParent[currentSessionId]?.pendingPermissionMode : undefined,
        [currentSessionId],
    ));
    const [isNarrowComposer, setIsNarrowComposer] = React.useState(false);
    const [attachmentPreview, setAttachmentPreview] = React.useState<ToolPopupContent>({
        open: false,
        title: '',
        content: '',
    });
    // Mount the lazy preview dialog only after its first open; rendering it
    // closed would fetch the ToolOutputDialog chunk (with the @pierre/diffs
    // stack) on the draft screen before any preview is requested.
    const [attachmentPreviewMounted, setAttachmentPreviewMounted] = React.useState(false);
    React.useEffect(() => {
        if (attachmentPreview.open) {
            setAttachmentPreviewMounted(true);
        }
    }, [attachmentPreview.open]);
    const attachmentCompatibilityRef = React.useRef({
        modelKey: `${currentProviderId ?? ''}/${currentModelId ?? ''}`,
        modalitySignature: currentModelMetadata?.modalities?.input?.slice().sort().join(',') ?? null,
        attachmentIds: new Set<string>(),
    });

    React.useEffect(() => {
        const modelKey = `${currentProviderId ?? ''}/${currentModelId ?? ''}`;
        const inputModalities = currentModelMetadata?.modalities?.input;
        const modalitySignature = inputModalities?.slice().sort().join(',') ?? null;
        const previous = attachmentCompatibilityRef.current;
        const modelChanged = previous.modelKey !== modelKey;
        const metadataBecameAvailable = previous.modalitySignature === null && modalitySignature !== null;
        const filesToCheck = modelChanged || metadataBecameAvailable
            ? attachedFiles
            : attachedFiles.filter((file) => !previous.attachmentIds.has(file.id));

        attachmentCompatibilityRef.current = {
            modelKey,
            modalitySignature,
            attachmentIds: new Set(attachedFiles.map((file) => file.id)),
        };

        if (!inputModalities || filesToCheck.length === 0) return;

        const incompatibleFiles = getUnsupportedAttachmentInputs(filesToCheck, inputModalities);
        if (incompatibleFiles.length === 0) return;

        const unsupportedModalities = Array.from(new Set(incompatibleFiles.map(({ modality }) => modality)));
        const modalityLabels: Record<AttachmentInputModality, string> = {
            text: t('chat.modelControls.modality.text'),
            image: t('chat.modelControls.modality.image'),
            pdf: t('chat.modelControls.modality.pdf'),
            audio: t('chat.modelControls.modality.audio'),
            video: t('chat.modelControls.modality.video'),
        };
        const filenames = incompatibleFiles.map(({ attachment }) => attachment.filename);
        const fileSummary = filenames.length > 3
            ? `${filenames.slice(0, 3).join(', ')} (+${filenames.length - 3})`
            : filenames.join(', ');

        toast.warning(t('chat.chatInput.toast.unsupportedAttachmentModalities', {
            model: currentModelMetadata.name ?? currentModelId ?? '',
            modalities: unsupportedModalities.map((modality) => modalityLabels[modality]).join(', '),
            files: fileSummary,
        }), { id: `attachment-modalities:${modelKey}` });
    }, [attachedFiles, currentModelId, currentModelMetadata, currentProviderId, t]);

    const handleShowAttachmentPreview = React.useCallback((content: ToolPopupContent) => {
        if (!content.image) return;
        setAttachmentPreview(content);
        setImagePreviewOpen(true);
    }, [setImagePreviewOpen]);

    const handleAttachmentPreviewOpenChange = React.useCallback((open: boolean) => {
        setAttachmentPreview((prev) => ({ ...prev, open }));
        setImagePreviewOpen(open);
    }, [setImagePreviewOpen]);

    React.useEffect(() => {
        if (!currentDirectory || !runtimeGit) return;
        void ensureGitStatus(currentDirectory, runtimeGit);
    }, [currentDirectory, runtimeGit, ensureGitStatus]);

    React.useEffect(() => {
        if (!currentDirectory || !runtimeGit) return;
        return sessionEvents.onGitRefreshHint((hint) => {
            if (normalizePath(hint.directory) !== normalizePath(currentDirectory)) return;
            if (hint.paths?.length) {
                clearGitDiffCache(currentDirectory, hint.paths);
            }
            void fetchGitStatus(currentDirectory, runtimeGit, { silent: true });
        });
    }, [clearGitDiffCache, currentDirectory, runtimeGit, fetchGitStatus]);

    React.useEffect(() => {
        if (!chatDraftIdentity) return;
        return sessionActions.onUnconfirmedSendRollback((rollback) => {
            if (rollback.runtimeKey !== chatDraftIdentity.runtimeKey) return;
            if (normalizePath(rollback.directory) !== chatDraftIdentity.directory) return;
            // New-session drafts only have a session ID after materialization;
            // an unresolved draft composer is the only one that can own a
            // rollback for this directory without a session match.
            if (chatDraftIdentity.sessionId !== null && rollback.sessionId !== chatDraftIdentity.sessionId) return;

            const currentInput = composerRef.current?.getValue() ?? messageRef.current;
            const restoredInput = currentInput && currentInput !== rollback.content
                ? appendWithLineBreaks(rollback.content, currentInput)
                : rollback.content;
            messageRef.current = restoredInput;
            setMessage(restoredInput);
            writeChatDraft(chatDraftIdentity, restoredInput, confirmedMentionsRef.current);
            // A retry of the restored text must reuse the rolled-back message
            // ID so an accepted server-side message is merged, not duplicated.
            lastSubmitRef.current = { messageId: rollback.messageId, text: rollback.content };
            toast.error(t('chat.chatInput.toast.messageSendFailed'));
        });
    }, [chatDraftIdentity, t]);

    const { submitting: reviewFlowSubmitting, start: handleStartReviewFlow } = useReviewFlowStart(currentSessionId, currentDirectory, closeReviewDialog);

    const isDesktopExpanded = isExpandedInput && !isMobile;
    // Mobile fullscreen composer (entered via the drag handle's swipe-up).
    const isMobileExpanded = isExpandedInput && isMobile;
    const isComposerExpanded = isDesktopExpanded || isMobileExpanded;
    // Rounder composer on mobile (touch UI reads better with a softer corner).
    const chatInputRadius = isMobile ? '1.5rem' : 'var(--radius-xl)';
    const useCompactChatPlaceholder = isMobile || isNarrowComposer;

    React.useEffect(() => {
        const element = dropZoneRef.current;
        if (!element) return;

        const updateWidth = (width: number) => {
            const next = width > 0 && width < COMPACT_CHAT_PLACEHOLDER_MAX_WIDTH;
            setIsNarrowComposer((prev) => (prev === next ? prev : next));
        };

        updateWidth(element.clientWidth);

        if (typeof ResizeObserver === 'undefined') {
            const handleResize = () => updateWidth(element.clientWidth);
            window.addEventListener('resize', handleResize);
            return () => window.removeEventListener('resize', handleResize);
        }

        const observer = new ResizeObserver((entries) => {
            updateWidth(entries[0]?.contentRect.width ?? element.clientWidth);
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    const knownAgentNames = React.useMemo(
        () => new Set(agents.map((agent) => agent.name.toLowerCase())),
        [agents]
    );
    const knownAgentNamesRef = React.useRef(knownAgentNames);
    knownAgentNamesRef.current = knownAgentNames;

    // Known slash-invocations (commands + built-ins) and `$` skills, used to
    // highlight matching tokens in the composer, the same way confirmed
    // @files are.
    const availableCommands = useCommandsStore((s) => selectCommandsForDirectory(s, currentDirectory));
    const availableSkills = useSkillsStore((s) => selectSkillsForDirectory(s, currentDirectory));
    const knownSlashNames = React.useMemo(() => {
        if (nativeTargetBackend === 'antigravity') return new Set<string>();
        if (nativeTargetBackend === 'codex') {
            const names = new Set<string>(CODEX_COMPOSER_COMMANDS.map((command) => command.name));
            for (const name of ['undo', 'redo', 'timeline', 'compact', 'btw']) names.add(name);
            if (!isMobile && !isVSCodeRuntime()) names.add('handoff-review');
            return names;
        }
        const names = new Set<string>([
            'init', 'review', 'undo', 'redo', 'timeline', 'compact', 'fork', 'btw', 'summary', 'workspace-review', 'plan-feature', 'craft-goal', 'schedule-task', 'catch-up', 'debug', 'weigh', 'explore',
        ]);
        if (!isMobile && !isVSCodeRuntime()) names.add('handoff-review');
        for (const command of availableCommands) names.add(command.name.toLowerCase());
        return names;
    }, [availableCommands, isMobile, nativeTargetBackend]);
    const knownSkillNames = React.useMemo(
        () => new Set(availableSkills.map((skill) => skill.name.toLowerCase())),
        [availableSkills],
    );

    // Extension slash commands. Built-ins and OpenCode commands are reserved:
    // an extension command with one of those names is ignored.
    const guestCommands = useGuestCommands(knownSlashNames);
    const knownSlashNamesWithGuests = React.useMemo(() => {
        if (isNativeTarget || guestCommands.length === 0) return knownSlashNames;
        const names = new Set(knownSlashNames);
        for (const entry of guestCommands) names.add(entry.command.name);
        return names;
    }, [guestCommands, isNativeTarget, knownSlashNames]);

    const availableSnippets = useSnippetsStore((s) => s.snippets);
    const knownSnippetTriggers = React.useMemo(() => {
        const triggers = new Set<string>();
        for (const snippet of availableSnippets) {
            triggers.add(snippet.name.toLowerCase());
            for (const alias of snippet.aliases ?? []) triggers.add(alias.toLowerCase());
        }
        return triggers;
    }, [availableSnippets]);

    const attachmentFilenames = React.useMemo(
        () => attachedFiles.map((file) => file.filename),
        [attachedFiles],
    );

    /**
     * Everything the prompt language needs to resolve references. Rebuilt only
     * when a registry changes, so typing does not churn the tokenizer input.
     */
    const languageContext = React.useMemo<ComposerLanguageContext>(() => ({
        inputMode,
        knownAgentNames,
        confirmedMentions: confirmedMentionsRef.current,
        knownSlashNames: knownSlashNamesWithGuests,
        knownSnippetTriggers,
        attachmentFilenames,
        pendingAttachmentFilenames: pendingPastedAttachmentFilenamesRef.current,
        knownSkillNames,
        fileIconVariant: currentTheme.metadata.variant === 'light' ? 'light' : 'dark',
    }), [attachmentFilenames, currentTheme.metadata.variant, inputMode, knownAgentNames, knownSkillNames, knownSlashNamesWithGuests, knownSnippetTriggers]);

    const sanitizeAttachmentsForSend = React.useCallback(
        (files: readonly AttachedFile[] | undefined): AttachedFile[] => [...(files ?? [])]
            .map((file) => ({
                ...file,
                dataUrl: file.source === 'server' && file.serverPath
                    ? toServerFileUrl(file.serverPath)
                    : file.dataUrl,
            })),
        [],
    );

    const resolveInlineFileMention = React.useCallback((mentionPath: string): { serverPath: string; filename: string; root: string } | null => {
        const kind = classifyMention(mentionPath, {
            knownAgentNames: knownAgentNamesRef.current,
            confirmedMentions: confirmedMentionsRef.current,
        });
        if (kind !== 'file') return null;

        const normalizedMentionPath = mentionPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
        if (!normalizedMentionPath) return null;

        const clientDirectory = opencodeClient.getDirectory() || '';
        const root = (chatSearchDirectory || clientDirectory).replace(/\\/g, '/').replace(/\/+$/, '');
        let serverPath: string | null = null;
        if (mentionPath.startsWith('/')) {
            serverPath = mentionPath.replace(/\\/g, '/');
        } else if (root) {
            serverPath = `${root}/${normalizedMentionPath}`;
        }
        if (!serverPath) return null;

        return {
            serverPath: serverPath.replace(/\/+/g, '/'),
            filename: normalizedMentionPath.split('/').filter(Boolean).pop() || normalizedMentionPath,
            root,
        };
    }, [chatSearchDirectory]);

    const extractInlineFileMentions = React.useCallback((
        rawText: string,
        preparedMentions?: ReadonlyMap<string, AttachedFile[]>,
    ) => {
        if (!rawText || !rawText.includes('@')) {
            return { sanitizedText: rawText, attachments: [] };
        }

        const seenPaths = new Set<string>();
        const attachments: AttachedFile[] = [];

        for (const token of scanMentions(rawText, confirmedMentionsRef.current)) {
            const mention = resolveInlineFileMention(token.name);
            if (!mention || seenPaths.has(mention.serverPath)) continue;
            seenPaths.add(mention.serverPath);

            const prepared = preparedMentions?.get(mention.serverPath);
            if (prepared) {
                attachments.push(...prepared);
                continue;
            }
            attachments.push({
                id: `${INLINE_SERVER_ATTACHMENT_ID_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                file: new File([], mention.filename, { type: 'text/plain' }),
                filename: mention.filename,
                mimeType: 'text/plain',
                size: 0,
                dataUrl: toServerFileUrl(mention.serverPath),
                source: 'server',
                serverPath: mention.serverPath,
            });
        }

        return {
            sanitizedText: rawText,
            attachments,
        };
    }, [resolveInlineFileMention]);

    type ReadOnSendMentionPreparation =
        | { status: 'ready'; prepared: Map<string, AttachedFile[]> }
        | { status: 'failed'; filename: string }
        | { status: 'runtime-changed' };

    /**
     * Document and image mentions (`@notes.docx`, `@shot.png`) are sent as
     * converted attachments with their real type, like a picked file. Their
     * sources are fetched up front — by the send, or by queueing, since the
     * server that later delivers a queued message cannot read them.
     */
    const prepareReadOnSendMentions = React.useCallback(async (
        texts: readonly string[],
        reservedFilenames: Set<string>,
        runtimeKey: string,
    ): Promise<ReadOnSendMentionPreparation> => {
        const prepared = new Map<string, AttachedFile[]>();
        for (const rawText of texts) {
            for (const token of scanMentions(rawText, confirmedMentionsRef.current)) {
                const mention = resolveInlineFileMention(token.name);
                if (
                    !mention
                    || !isReadOnSendMentionFilename(mention.filename)
                    || prepared.has(mention.serverPath)
                ) {
                    continue;
                }
                try {
                    // The directory bounds the read, and sends it to the space that holds the file.
                    const response = await runtimeFetch('/api/fs/raw', {
                        query: { path: mention.serverPath, directory: mention.root || undefined },
                    });
                    if (!response.ok) throw new Error(`Failed to read ${mention.filename}`);
                    const sourceBlob = await response.blob();
                    if (getRuntimeKey() !== runtimeKey) return { status: 'runtime-changed' };
                    const source = new File([sourceBlob], mention.filename);
                    const converted = await prepareLocalAttachments(source, reservedFilenames);
                    if (!converted || converted.length === 0) throw new Error(`Failed to prepare ${mention.filename}`);
                    if (getRuntimeKey() !== runtimeKey) return { status: 'runtime-changed' };
                    prepared.set(mention.serverPath, converted);
                    for (const attachment of converted) reservedFilenames.add(attachment.filename);
                } catch {
                    if (getRuntimeKey() !== runtimeKey) return { status: 'runtime-changed' };
                    return { status: 'failed', filename: mention.filename };
                }
            }
        }
        return { status: 'ready', prepared };
    }, [resolveInlineFileMention]);
    const prevWasAbortedRef = React.useRef(false);

    // Issue linking state
    const [referencePicker, setReferencePicker] = React.useState<ReferencePickerState>(null);
    // The paste-toast tap may need to reopen the collapsed mobile composer.
    const mobileShell = useMobileComposerShell({
        isMobile,
        editorRef: composerRef,
        formRef: composerFormRef,
        setExpandedInput,
        // Without a soft keyboard, keep the full composer up.
        alwaysExpanded: hasHardwareKeyboard || isTabletLayout,
        holders: {
            controlsPanelOpen: Boolean(mobileControlsPanel),
            attachMenuOpen: mobileAttachMenuOpen,
            draftPickerOpen: mobileDraftPicker !== null,
            referencePickerOpen: referencePicker !== null,
            isDragging,
        },
    });
    const mobileComposerExpanded = mobileShell.expanded;
    const mobileTextareaFocused = mobileShell.focused;
    // Issues, PRs and tracker items on the composer, in attach order.
    const [linkedReferences, setLinkedReferences] = React.useState<ComposerReference[]>([]);
    const [contextPreviewHost, setContextPreviewHost] = React.useState<HTMLDivElement | null>(null);
    const [attachDialogGuestId, setAttachDialogGuestId] = React.useState<string | null>(null);
    // The chip the attach dialog was opened from; null when opened from the + menu.
    const [attachDialogItem, setAttachDialogItem] = React.useState<AttachIssueRequest | null>(null);

    // Inline comment drafts
    const inlineDraftSessionKey = isBtwActive ? btwComposerSessionId ?? '' : currentSessionId ?? (newSessionDraftOpen ? 'draft' : '');
    const inlineDraftDirectory = currentSessionDirectoryForSync ?? currentDirectory;
    const inlineDraftTarget = React.useMemo<InlineCommentDraftTarget | null>(
        () => inlineDraftSessionKey && inlineDraftDirectory
            ? { directory: inlineDraftDirectory, sessionKey: inlineDraftSessionKey }
            : null,
        [inlineDraftDirectory, inlineDraftSessionKey],
    );
    const inlineDraftKey = inlineDraftTarget
        ? getInlineCommentDraftKey(activeRuntimeKey, inlineDraftTarget.directory, inlineDraftTarget.sessionKey)
        : null;
    const draftCount = useInlineCommentDraftStore(
        React.useCallback(
            (state) => inlineDraftKey ? (state.drafts[inlineDraftKey] ?? []).length : 0,
            [inlineDraftKey]
        )
    );
    const consumeDrafts = useInlineCommentDraftStore((state) => state.consumeDrafts);
    const hasDrafts = draftCount > 0;

    // Mobile comment mode (see composer/comment/): read imperatively here so
    // the send/queue guards below see the live state; rendering and lifecycle
    // live in useMobileCommentComposerMode further down.
    const mobileCommentController = useMobileCommentComposerController();
    const isMobileCommentOpen = React.useCallback(
        () => isMobile && mobileCommentController?.getState().status === 'open',
        [isMobile, mobileCommentController],
    );
    const attachMobileCommentRef = React.useRef<() => void>(() => undefined);

    const inputHistoryScope = useInputHistoryStore((state) => state.scope);
    const inputHistoryIdentity = React.useMemo(
        () => createInputHistoryIdentity(
            activeRuntimeKey,
            currentSessionDirectoryForSync ?? currentDirectory ?? '',
            inlineDraftSessionKey || 'draft',
        ),
        [activeRuntimeKey, currentDirectory, currentSessionDirectoryForSync, inlineDraftSessionKey],
    );
    const inputHistoryEntries = useInputHistoryStore(React.useCallback(
        (state) => selectInputHistoryEntries(state, inputHistoryIdentity),
        [inputHistoryIdentity],
    ));
    // Session scope also reads the visible transcript, so sessions older than
    // the persisted history still recall their prompts.
    const transcriptPrompts = useUserMessageHistory((isBtwActive ? btwSessionId : currentSessionId) ?? '');
    const historyValues = React.useMemo(
        () => (inputHistoryScope === 'session'
            ? mergeSessionInputHistory(transcriptPrompts, inputHistoryEntries)
            : mapInputHistoryEntriesToValues(inputHistoryEntries)),
        [inputHistoryEntries, inputHistoryScope, transcriptPrompts],
    );
    const messageHistoryIdentity = React.useMemo(
        () => buildInputHistoryNavigatorIdentity(inputHistoryScope, inputHistoryIdentity),
        [inputHistoryIdentity, inputHistoryScope],
    );
    const messageHistory = useMessageHistory<AttachedFile>(historyValues, messageHistoryIdentity);

    // Keep messageRef in sync with message state
    React.useEffect(() => {
        messageRef.current = message;
    }, [message]);

    // Draft persistence: identity switching, debounced writes and the
    // flush-on-hide edges live in the hook.
    const {
        persistNow: persistDraftImmediately,
        handoffDraft,
        restoreDraft,
        migrateDraft,
    } = useComposerDraft({
        message,
        messageRef,
        setMessage,
        confirmedMentionsRef,
        identity: chatDraftIdentity,
        selectAttachmentsOnIdentityChange: !columnPinned,
        persistEnabled: persistChatDraft,
        initialDraft: {
            text: initialDraftRef.current ?? '',
            identity: initialDraftIdentityRef.current,
        },
        newSessionDraftId: newSessionDraftOpen ? newSessionDraft.draftId : null,
        onIdentityChange: () => {
            setInputMode('normal');
            draftCaretModeRef.current.atEnd = isBtwActive || draftCaretModeRef.current.btw;
            draftCaretModeRef.current.btw = isBtwActive;
        },
        onDraftRestored: (source) => {
            const editor = composerRef.current;
            if (!editor) return;
            if (source === 'fork') editor.focus();
            if (source !== 'fork' && draftCaretModeRef.current.atEnd) {
                editor.setSelection(editor.getValue().length);
            } else {
                editor.selectAll();
            }
        },
    });

    const handleExitBtw = React.useCallback(() => {
        if (!currentSessionId) return;
        immediateBtwSubmitRef.current = null;
        const panels = useBtwStore.getState();
        const pending = panels.byParent[currentSessionId];
        if (pending?.pending && !pending.creating && !btwSessionId) {
            const pendingSessionId = `btw-pending:${currentSessionId}`;
            const identity = createChatDraftIdentity(activeRuntimeKey, currentSessionDirectoryForSync ?? currentDirectory, pendingSessionId);
            if (identity) {
                clearChatDraft(identity, true);
                useInlineCommentDraftStore.getState().clearDrafts({ directory: identity.directory, sessionKey: pendingSessionId });
            }
            useSelectionStore.getState().clearSessionSelections(pendingSessionId);
            useInputStore.getState().consumePendingBtwComposerRequest(currentSessionId);
            panels.clearPanelState(currentSessionId);
            return;
        }
        panels.setPanelState(currentSessionId, { collapsed: true });
    }, [activeRuntimeKey, btwSessionId, currentDirectory, currentSessionDirectoryForSync, currentSessionId]);

    React.useEffect(() => {
        const request = pendingBtwComposerRequest;
        if (!request || request.parentSessionId !== currentSessionId) return;
        if (!isBtwActive) {
            useBtwStore.getState().setPanelState(
                request.parentSessionId,
                btwSessionId ? { collapsed: false } : { pending: true, collapsed: false },
            );
            return;
        }
        if (!chatDraftIdentity) return;
        const consumed = consumePendingBtwComposerRequest(currentSessionId);
        if (!consumed) return;
        restoreDraft(chatDraftIdentity, consumed.text, new Set());
        queueMicrotask(() => focusColumnInput());
    }, [btwSessionId, chatDraftIdentity, consumePendingBtwComposerRequest, currentSessionId, focusColumnInput, isBtwActive, pendingBtwComposerRequest, restoreDraft]);

    // Focus textarea when new session draft is opened
    const prevNewSessionDraftOpenRef = React.useRef(newSessionDraftOpen);
    React.useEffect(() => {
        // The draft opens in the main chat; a pinned composer stays out of it.
        if (!prevNewSessionDraftOpenRef.current && newSessionDraftOpen && !columnPinned) {
            // New session draft just opened - focus the textarea
            requestAnimationFrame(() => {
                if (isMobile) {
                    // On mobile, use preventScroll to avoid viewport jumping
                    composerRef.current?.focus({ preventScroll: true });
                } else {
                    composerRef.current?.focus();
                }
            });
        }
        prevNewSessionDraftOpenRef.current = newSessionDraftOpen;
    }, [columnPinned, newSessionDraftOpen, isMobile]);

    // Session activity for queue availability and controls. In btw mode the
    // composer controls the temporary fork, so the stop button and send-button
    // state follow the FORK's activity; the queue affordance stays tied to the
    // main session (queued messages always belong to the main chat).
    // The column's session: a chat pinned in the side panel shows its own
    // send/stop state, not the main chat's.
    const { phase: currentSessionPhase } = useSessionActivity(currentSessionId, currentSessionDirectoryForSync ?? currentDirectory ?? undefined);
    const { phase: btwSessionPhase } = useSessionActivity(btwSessionId, btwDirectory ?? undefined);
    const sessionPhase = isBtwActive ? btwSessionPhase : currentSessionPhase;
    const pendingBlockingPermissions = useSessionPermissions(
        currentSessionId ?? '',
        currentSessionDirectoryForSync ?? currentDirectory,
    );
    const pendingBlockingQuestions = useSessionForms(
        currentSessionId ?? '',
        currentSessionDirectoryForSync ?? currentDirectory,
    );
    const hasPendingBlockingRequests = pendingBlockingPermissions.length > 0 || pendingBlockingQuestions.length > 0;
    const autoReviewRunning = useAutoReviewStore(React.useCallback((state) => {
        if (!currentSessionId) return false;
        const run = state.runsByOriginalSessionID[currentSessionId];
        return run?.status === 'running' && run.runtimeKey === getRuntimeKey();
    }, [currentSessionId]));
    const followUpDelivery = autoReviewRunning ? 'queue' : resolveNativeFollowUpDelivery({
        delivery: 'queue',
        sessionId: isBtwActive ? btwSessionId : currentSessionId,
        providerID: (isBtwActive ? effectiveBtwSelection.model?.providerId : currentProviderId) ?? '',
        sessionPhase: 'busy',
        unifiedState: isBtwActive ? undefined : unifiedState,
    }) ?? 'queue';

    React.useEffect(() => {
        queuedMessageSendInFlightRef.current = null;
        queuedDrainInFlightRef.current = null;
        setSendingQueuedMessageId(null);
    }, [messageQueueKey, queueGeneration]);

    React.useEffect(() => {
        if (!messageQueueTarget) return;
        return watchQueueSession(messageQueueTarget);
    }, [messageQueueKey, messageQueueTarget, queueGeneration, watchQueueSession]);

    const sendQueuedMessage = React.useCallback(async (messageId: string, mode: 'manual' | 'auto'): Promise<boolean> => {
        if (!messageQueueTarget || queuedMessageSendInFlightRef.current) return false;
        const item = useMessageQueueStore.getState().getQueueForTarget(messageQueueTarget)
            .find((candidate) => candidate.id === messageId);
        if (!item) return false;
        queuedMessageSendInFlightRef.current = { itemId: messageId };
        setSendingQueuedMessageId(messageId);
        const claim = await claimQueuedMessage(messageQueueTarget, messageId, mode).catch(() => null);
        if (!claim) {
            queuedMessageSendInFlightRef.current = null;
            setSendingQueuedMessageId(null);
            return false;
        }
        try {
            const queuedItem = claim.item;
            const expectedRuntime = {
                runtimeKey: getRuntimeKey(),
                generation: getRuntimeEndpointGeneration(),
            };
            const queueState = useMessageQueueStore.getState();
            if (
                expectedRuntime.runtimeKey !== messageQueueTarget.runtimeKey
                || queueState.runtimeKey !== claim.context.runtimeKey
                || queueState.generation !== claim.context.generation
            ) throw new RuntimeContextChangedError();
            const sendConfig = queuedItem.sendConfig ?? {
                providerID: currentProviderId ?? '',
                modelID: currentModelId ?? '',
                ...(currentAgentName ? { agent: currentAgentName } : {}),
                ...(currentVariant ? { variant: currentVariant } : {}),
            };
            if (!sendConfig.providerID || !sendConfig.modelID) {
                throw new Error('Queued message is missing its captured model selection');
            }
            await sendMessage(
                queuedItem.content,
                sendConfig.providerID,
                sendConfig.modelID,
                sendConfig.agent,
                queuedItem.attachments,
                queuedItem.agentMentionName,
                queuedItem.additionalParts,
                sendConfig.variant,
                'normal',
                {
                    sessionId: messageQueueTarget.sessionId,
                    directory: messageQueueTarget.directory,
                    messageId: queuedItem.messageId,
                    preserveModelSelection: true,
                    expectedRuntime,
                },
            );
            await completeQueuedMessage(messageQueueTarget, messageId, claim.claimId, claim.context);
            return true;
        } catch {
            await releaseQueuedMessage(messageQueueTarget, messageId, claim.claimId, 'staged', claim.context).catch(() => false);
            toast.error(t('chat.queuedMessage.sendFailed'));
            return false;
        } finally {
            if (queuedMessageSendInFlightRef.current?.itemId === messageId) {
                queuedMessageSendInFlightRef.current = null;
            }
            setSendingQueuedMessageId(null);
        }
    }, [
        claimQueuedMessage,
        completeQueuedMessage,
        currentAgentName,
        currentModelId,
        currentProviderId,
        currentVariant,
        messageQueueTarget,
        releaseQueuedMessage,
        sendMessage,
        t,
    ]);

    const handleQueuedMessageSend = React.useCallback((messageId: string) => {
        void sendQueuedMessage(messageId, 'manual');
    }, [sendQueuedMessage]);

    const handleQueuedMessageQueue = React.useCallback((messageId: string) => {
        if (!messageQueueTarget) return;
        setQueuedStatus(messageQueueTarget, messageId, 'queued');
    }, [messageQueueTarget, setQueuedStatus]);

    const handleQueuedMessageEdit = React.useCallback((queuedMessage: QueuedMessage) => {
        let content = queuedMessage.content;
        if (queuedMessage.agentMentionName) {
            content = `@${queuedMessage.agentMentionName}`;
            if (queuedMessage.content) content += ` ${queuedMessage.content}`;
        }
        const inputState = useInputStore.getState();
        if (queuedMessage.attachments && queuedMessage.attachments.length > 0) {
            inputState.restoreAttachedFiles(queuedMessage.attachments, chatDraftIdentity);
        }
        if (queuedMessage.additionalParts && queuedMessage.additionalParts.length > 0) {
            inputState.setPendingSyntheticParts([
                ...queuedMessage.additionalParts.map((part) => ({ ...part })),
                ...(inputState.pendingSyntheticParts ?? []),
            ]);
        }
        messageRef.current = content;
        setMessage(content);
        writeChatDraft(chatDraftIdentity, content, confirmedMentionsRef.current);
        window.setTimeout(() => composerRef.current?.focus(), 0);
    }, [chatDraftIdentity]);

    const [queueLeaseEpoch, setQueueLeaseEpoch] = React.useState(0);
    React.useEffect(() => {
        const now = Date.now();
        let nextExpiry = Number.POSITIVE_INFINITY;
        for (const entry of queuedMessages) {
            if (entry.status !== 'queued' || !entry.claim || entry.claim.expiresAt <= now) continue;
            nextExpiry = Math.min(nextExpiry, entry.claim.expiresAt);
        }
        if (!Number.isFinite(nextExpiry)) return;
        const timer = window.setTimeout(
            () => setQueueLeaseEpoch((epoch) => epoch + 1),
            Math.max(1, nextExpiry - now + 1),
        );
        return () => window.clearTimeout(timer);
    }, [queuedMessages]);

    React.useEffect(() => {
        if (!messageQueueTarget || currentSessionPhase !== 'idle' || autoReviewRunning || hasPendingBlockingRequests) return;
        if (queuedMessageSendInFlightRef.current || queuedDrainInFlightRef.current) return;
        const now = Date.now();
        const next = queuedMessages.find((entry) => (
            entry.status === 'queued' && isFollowUpQueueClaimAvailable(entry, now)
        ));
        if (!next) return;
        queuedDrainInFlightRef.current = { itemId: next.id };
        const drain = async () => {
            if (isUnifiedNativeSessionId(messageQueueTarget.sessionId)) {
                const session = await nativeAgents.getSession(messageQueueTarget.sessionId, messageQueueTarget.directory);
                if (unifiedNativeSessionState(session.metadata)?.switchReady !== true) return;
            }
            await sendQueuedMessage(next.id, 'auto');
        };
        void drain().catch(() => undefined).finally(() => {
            if (queuedDrainInFlightRef.current?.itemId === next.id) {
                queuedDrainInFlightRef.current = null;
            }
        });
    }, [autoReviewRunning, currentSessionPhase, hasPendingBlockingRequests, messageQueueTarget, queueLeaseEpoch, queuedMessages, sendQueuedMessage, unifiedState?.switchReady, nativeAgents]);

    const handleOpenMobilePanel = React.useCallback((panel: MobileControlsPanel) => {
        if (!isMobile) {
            return;
        }
        // Set the panel state BEFORE blurring: the collapse watcher and the
        // overlay-host observer must already see the overlay as open when the
        // keyboard-close lands, otherwise the composer folds into the pill
        // under the sheet.
        setMobileControlsPanel(panel);
        composerRef.current?.blur();
    }, [isMobile]);

    // Consume pending input text (e.g., from revert action). Must stay after
    // useComposerDraft: on a draft switch the incoming draft loads first and
    // the pending text lands on top of it.
    const focusComposer = React.useCallback(() => composerRef.current?.focus(), []);
    usePendingComposerText({ enabled: !isBtwActive, target: mailboxTarget, setMessage, focus: focusComposer });

    const parallel = useParallelComposer({
        enabled: !isMobile && !isBtwActive,
        draftOpen: newSessionDraftOpen && newSessionDraft?.target !== 'chat',
        draftProjectId: newSessionDraft?.selectedProjectId ?? null,
        message,
        setMessage,
    });
    const parallelProjectId = newSessionDraft?.selectedProjectId ?? null;
    const parallelProject = useProjectsStore(React.useCallback((state) => {
        const project = state.projects.find((entry) => entry.id === (parallelProjectId ?? state.activeProjectId));
        return project ? `${project.id}\n${project.path}` : null;
    }, [parallelProjectId]));
    const parallelProjectRef = React.useMemo(() => {
        if (!parallelProject) return null;
        const [id, path] = parallelProject.split('\n');
        return { id, path };
    }, [parallelProject]);
    const enterParallel = parallel.enter;
    const { isActive: parallelActive, runCount: parallelRunCount, isLaunching: parallelLaunching, launch: launchParallel } = parallel;
    const parallelRun = React.useMemo(() => (parallelActive ? {
        runCount: parallelRunCount,
        launching: parallelLaunching,
        onLaunch: () => { void launchParallel(); },
    } : null), [launchParallel, parallelActive, parallelLaunching, parallelRunCount]);
    React.useLayoutEffect(() => {
        largeTextPasteGesture.invalidate();
    }, [largeTextPasteGesture, parallel.state?.active, parallel.isActive, newSessionDraftOpen, newSessionDraft?.target, mobileComposerExpanded, isExpandedInput]);
    const handleRunInParallel = React.useCallback(() => {
        // The picker offers it everywhere; a run always starts from a new-session draft.
        if (newSessionDraftOpen && newSessionDraft?.target !== 'chat') enterParallel();
        else openParallelComposer(messageRef.current);
    }, [enterParallel, newSessionDraft?.target, newSessionDraftOpen]);

    // A linked reference is attached context, not decoration: the submission
    // builder serializes it into the outgoing message, so a composer holding
    // only one of those chips is not empty and has to be sendable on its own.
    // BTW sends strip every reference, so the gate stays out of BTW.
    const hasLinkedReferences = linkedReferences.length > 0;
    const hasContent = message.trim().length > 0 || attachedFiles.length > 0 || hasDrafts || (!isBtwActive && hasLinkedReferences);
    const composerQueuedMessages = selectComposerQueue(queuedMessages);
    const hasQueuedMessages = !isBtwActive && composerQueuedMessages.length > 0;
    const preparingBtwSend = useBtwStore((state) => Boolean(currentSessionId && state.byParent[currentSessionId]?.pendingSend));
    const canSend = hasContent && !autoReviewRunning && !(isBtwActive && (btwPanel.creating || preparingBtwSend));

    // Background tasks a native CLI still runs after its turn show the session
    // as running in the lists; Stop ends them too.
    const abortTargetHasBackgroundTasks = useSessionHasBackgroundTasks(isBtwActive && btwSessionId ? btwSessionId : currentSessionId);
    const canAbort = sessionPhase !== 'idle' || abortTargetHasBackgroundTasks;

    const { suggestion: availableSuggestion } = useSessionAssistState(
        currentSessionId ?? '',
        currentSessionDirectoryForSync ?? currentDirectory,
    );
    const promptSuggestion = hasContent || message.length > 0 || newSessionDraftOpen || isBtwActive
        || isBtwPanelVisible || hasQueuedMessages || canAbort || inputMode !== 'normal'
        ? null : availableSuggestion;

    // Reads the text through refs, so the send and queue callbacks built on
    // it keep their identity while the user types.
    const getCurrentInputSnapshot = React.useCallback(() => {
        const currentMessage = composerRef.current?.getValue() ?? messageRef.current;
        return {
            message: currentMessage,
            hasContent: currentMessage.trim().length > 0 || attachedFiles.length > 0 || hasDrafts || (!isBtwActive && hasLinkedReferences),
        };
    }, [attachedFiles.length, hasDrafts, hasLinkedReferences, isBtwActive]);

    // Keep a ref to handleSubmit so callbacks don't depend on it.
    type SubmitOptions = {
        /** Submit this text instead of the composer input. Used by preset
            starter chips: on mobile the collapsed pill has no mounted textarea,
            so the DOM-first input snapshot would read empty content. */
        presetText?: string;
        /** Stage this submission in the follow-up queue instead of sending now. */
        forceQueue?: boolean;
        /** Deliver immediately into a busy session instead of queueing. */
        delivery?: 'steer' | 'queue';
    };
    const handleSubmitRef = React.useRef<(options?: SubmitOptions) => Promise<void>>(async () => {});
    const handleOpenAgentPanel = React.useCallback(() => {
        setMobileControlsPanel('agent');
    }, []);

    const handleToggleExpandedInput = React.useCallback(() => {
        if (isBtwActive) return;
        setExpandedInput(!isExpandedInput);
    }, [isBtwActive, isExpandedInput, setExpandedInput]);

    const openGitHubPicker = React.useCallback(() => {
        setReferencePicker({ source: 'github' });
    }, []);
    const referencePickerDirectory = currentSessionDirectoryForSync ?? currentDirectory ?? null;
    const repositoryProvider = useRepositoryReferenceProvider(isVSCodeRuntime() ? null : referencePickerDirectory);
    const addLinkedReferences = React.useCallback((references: ComposerReference[]) => {
        setLinkedReferences((current) => withComposerReferences(current, references));
    }, []);
    const attachReferences = useAttachReferences(referencePickerDirectory, addLinkedReferences);

    const openLinearPicker = React.useCallback(() => {
        setReferencePicker({ source: 'linear' });
    }, []);

    const getSubmitErrorMessage = (error: unknown, fallback: string) => {
        if (error instanceof NativeAgentsRequestError) {
            const key = nativeSessionActionErrorKey(error, currentSessionId);
            if (key) return t(key);
        }
        if (error instanceof NativeAgentsRequestError && error.code === 'NATIVE_CODEX_COMMAND_UNSUPPORTED') {
            return t('chat.codexCommand.unsupported');
        }
        const message = error instanceof Error ? error.message : '';
        return message.toLowerCase().includes('runtime changed')
            ? t('chat.chatInput.toast.messageSendFailed')
            : message || fallback;
    };

    const handleSubmit = async (options?: SubmitOptions) => {
        // Comment mode's only submit is attach; every other send path must be
        // inert while it is open.
        if (isMobileCommentOpen()) return;
        if (isBtwActive && currentSessionId && (btwPanel.creating || useBtwStore.getState().byParent[currentSessionId]?.pendingSend)) return;
        // "Run in parallel" launches the run instead of sending a message.
        if (parallel.isActive) {
            if (parallel.runCount >= 2) void parallel.launch();
            return;
        }
        const submissionRuntimeKey = getRuntimeKey();
        const submissionRuntimeGeneration = getRuntimeEndpointGeneration();
        const submitRuntimeKey = submissionRuntimeKey;
        const submissionSessionId = currentSessionId;
        const submissionDraftState = submissionSessionId === null
            ? useSessionUIStore.getState().newSessionDraft
            : null;
        // Snapshot the draft and current-session identity before the first
        // async gap so a later sidebar selection cannot reroute the send.
        const capturedDraftSnapshot = submissionDraftState?.open ? { ...submissionDraftState } : null;
        const capturedTarget = messageQueueTarget;
        const isSubmissionContextCurrent = () => {
            if (
                getRuntimeKey() !== submissionRuntimeKey
                || getRuntimeEndpointGeneration() !== submissionRuntimeGeneration
            ) return false;
            const sessionState = useSessionUIStore.getState();
            if (sessionState.currentSessionId !== submissionSessionId) return false;
            return submissionSessionId !== null || sessionState.newSessionDraft === submissionDraftState;
        };
        if (!isSubmissionContextCurrent()) return;

        // An expired session cannot deliver anything: keep the prompt in the
        // composer and point at the login banner instead of burning the send
        // on a guaranteed 401.
        if (useAuthSessionStore.getState().state !== 'ok') {
            toast.error(t('sessionAuth.expired.sendBlocked'));
            return;
        }
        let inputSnapshot = options?.presetText != null
            ? {
                message: options.presetText,
                hasContent: options.presetText.trim().length > 0 || attachedFiles.length > 0 || hasDrafts || (!isBtwActive && hasLinkedReferences),
            }
            : getCurrentInputSnapshot();

        const isAutoReviewRunningNow = () => {
            if (!submissionSessionId) return false;
            const run = useAutoReviewStore.getState().runsByOriginalSessionID[submissionSessionId];
            return run?.status === 'running' && run.runtimeKey === submissionRuntimeKey;
        };
        const restoreExplicitInput = () => {
            if (options?.presetText == null) return;
            if (!isSubmissionContextCurrent()) {
                writeChatDraft(chatDraftIdentity, options.presetText, confirmedMentionsRef.current);
                return;
            }
            messageRef.current = options.presetText;
            setMessage(options.presetText);
            writeChatDraft(chatDraftIdentity, options.presetText, confirmedMentionsRef.current);
            setTimeout(() => composerRef.current?.focus(), 0);
        };


        // Auto-review owns the original session while it is running. Typed input
        // remains untouched; text supplied outside the mounted editor (presets
        // and dictation) is inserted back into the composer instead of consumed.
        if (autoReviewRunning || isAutoReviewRunningNow()) {
            restoreExplicitInput();
            return;
        }

        if (!inputSnapshot.hasContent || (!currentSessionId && !newSessionDraftOpen)) {
            return;
        }

        const deepseekCommand = nativeTargetBackend === 'deepseek' && inputMode === 'normal' && !isBtwActive
            ? /^\/([a-z][a-z0-9_-]*)(?:\s|$)/i.exec(inputSnapshot.message.trim())
            : null;
        if (deepseekCommand && !isNativeLocalCommand(deepseekCommand[1]) && deepseekCommand[1] !== 'compact') {
            if (!currentSessionId) {
                toast.error(t('chat.deepseekCommand.needsSession'));
                return;
            }
            const directory = currentSessionDirectoryForSync ?? currentDirectory;
            if (!directory || codexCommandRunning.current) return;
            const originalText = inputSnapshot.message;
            const originalMentions = new Set(confirmedMentionsRef.current);
            codexCommandRunning.current = true;
            closeAutocomplete();
            try {
                const result = await nativeAgents.deepseekCommand({ sessionId: currentSessionId, directory, line: originalText.trim() });
                if (!isSubmissionContextCurrent()) return;
                setMessage('');
                messageRef.current = '';
                persistDraftImmediately(chatDraftIdentity, '');
                if (result.kind === 'output') setCodexCommandOutput({ cliName: 'DeepSeek Harness', command: deepseekCommand[1], output: result });
            } catch (error) {
                restoreDraft(chatDraftIdentity, originalText, originalMentions);
                if (isSubmissionContextCurrent()) toast.error(getSubmitErrorMessage(error, t('chat.deepseekCommand.failed')));
            } finally {
                codexCommandRunning.current = false;
            }
            return;
        }

        let codexAgentOverride: 'plan' | undefined;
        const codexCommand = nativeTargetBackend === 'codex' && inputMode === 'normal' && !isBtwActive
            ? parseCodexComposerCommand(inputSnapshot.message)
            : null;
        if (codexCommand) {
            if (codexCommandRunning.current) return;
            const directory = currentSessionDirectoryForSync ?? currentDirectory;
            if (!directory || !currentModelId) {
                toast.error(t('chat.chatInput.toast.noModelSelected'));
                return;
            }
            const originalText = inputSnapshot.message;
            const originalMentions = new Set(confirmedMentionsRef.current);
            codexCommandRunning.current = true;
            closeAutocomplete();
            // Clear only the command. Attached files and context belong to the
            // next prompt; a failed command restores its original draft.
            messageRef.current = '';
            setMessage('');
            persistDraftImmediately(chatDraftIdentity, '');
            try {
                const result = await executeCodexComposerCommand(codexCommand, {
                    sessionId: currentSessionId,
                    directory,
                    model: currentModelId,
                    variant: currentVariant,
                    agent: currentAgentName ?? 'build',
                    api: nativeAgents,
                    t,
                    isCurrent: isSubmissionContextCurrent,
                    openModelMenu: () => {
                        if (isMobile) setMobileControlsPanel('model');
                        useUIStore.getState().setModelSelectorOpen(true);
                    },
                });
                if (!isSubmissionContextCurrent()) return;
                if (result.kind === 'output') {
                    setCodexCommandOutput({ command: codexCommand.name, output: result });
                    return;
                }
                if (result.kind === 'done') return;
                if (result.kind === 'edit') {
                    setMessage(result.text);
                    updateAutocompleteState(result.text, result.text.length);
                    requestAnimationFrame(() => composerRef.current?.focus());
                    return;
                }
                inputSnapshot = { message: result.text, hasContent: true };
                if (result.kind === 'prompt') codexAgentOverride = result.agent;
            } catch (error) {
                restoreDraft(chatDraftIdentity, originalText, originalMentions);
                if (isSubmissionContextCurrent()) toast.error(getSubmitErrorMessage(error, t('chat.codexCommand.failed')));
                return;
            } finally {
                codexCommandRunning.current = false;
            }
        }

        // Local slash commands are planned before anything is taken or
        // consumed. An action command must leave the queue and the attached
        // context where they are; a prompt command must send that context with
        // the prompt it produces. A command the composer cannot run here is not
        // a local command at all and goes out as typed; so does every command
        // a native CLI owns.
        let commandPlan = inputSnapshot.hasContent
            ? planLocalSlashCommand(inputSnapshot.message, inputMode, hasDrafts, Boolean(currentSessionId))
            : null;
        if (commandPlan && (nativeTargetBackend === 'antigravity' || (isNativeTarget && !isNativeLocalCommand(commandPlan.command.name)))) commandPlan = null;
        if (commandPlan?.kind === 'prompt') {
            const magicCommand = findMagicPromptCommand(commandPlan.command.name);
            const commandIsAvailable = commandPlan.command.name === 'btw'
                ? Boolean(currentSessionId)
                : magicCommand !== null && canRunCommand(magicCommand, {
                    hasSession: Boolean(currentSessionId),
                    hasDraft: newSessionDraftOpen,
                });
            if (!commandIsAvailable) commandPlan = null;
        }
        if (commandPlan?.command.name === 'handoff-review' && (isMobile || isVSCodeRuntime())) commandPlan = null;

        // Enter BTW before sending so the question uses its isolated selections.
        // A bare command waits for input; an argument requests one immediate send.
        if (commandPlan?.kind === 'prompt' && commandPlan.command.name === 'btw' && currentSessionId) {
            const targetComposerId = btwSessionId ?? `btw-pending:${currentSessionId}`;
            const targetIdentity = createChatDraftIdentity(
                activeRuntimeKey,
                btwDirectory ?? currentSessionDirectoryForSync ?? currentDirectory,
                targetComposerId,
            );
            const argument = commandPlan.command.argument.trim();
            handoffDraft(targetIdentity, isBtwActive ? argument : argument || null);
            // Files pasted with the question go with it; their `[image-1.png]` citations moved above.
            useInputStore.getState().moveAttachedFiles(chatDraftIdentity, targetIdentity);
            if (argument && targetIdentity) immediateBtwSubmitRef.current = { identity: targetIdentity, text: argument };
            if (btwSessionId) {
                useBtwStore.getState().setPanelState(currentSessionId, { collapsed: false });
                return;
            }
            useBtwStore.getState().setPanelState(currentSessionId, { pending: true, creating: false, collapsed: false });
            return;
        }

        // Opening BTW is local and still works while authentication is expired.
        if (useAuthSessionStore.getState().state !== 'ok') {
            toast.error(t('sessionAuth.expired.sendBlocked'));
            return;
        }

        // A failed send returns the typed prompt no matter WHY it failed —
        // auth, network, server, anything. Losing a long prompt to a toast is
        // the one outcome this handler must never produce. The mentions are
        // snapshotted here because sending clears them before it can fail.
        const confirmedMentionsSnapshot = new Set(confirmedMentionsRef.current);
        const restoreComposerText = () => {
            if (!inputSnapshot.message) return;
            restoreDraft(chatDraftIdentity, inputSnapshot.message, confirmedMentionsSnapshot);
        };

        // An extension command never reaches the model: the extension turns
        // `/name args` into a chip, which lands through the same pending slot
        // a guest panel's `attach` uses. Nothing else in the composer moves.
        const guestRoute = !isNativeTarget && !isBtwActive && inputSnapshot.hasContent
            ? routeGuestSlashCommand(inputSnapshot.message, inputMode, guestCommands)
            : null;
        if (guestRoute) {
            setMessage('');
            confirmedMentionsRef.current.clear();
            persistDraftImmediately(chatDraftIdentity, '');
            messageHistory.reset();
            const outcome = await runGuestCommand(guestRoute);
            if (outcome.ok) {
                if (outcome.item) {
                    useInputStore.getState().setPendingGuestIssue(outcome.item);
                } else {
                    // Nothing matched: give the command back so the user can fix the argument.
                    restoreComposerText();
                    toast.info(t('chat.chatInput.toast.guestCommandNothing', { name: guestRoute.entry.guestName }));
                }
                return;
            }
            restoreComposerText();
            toast.error(outcome.reason === 'error'
                ? t('chat.chatInput.toast.guestCommandFailed', { command: guestRoute.entry.command.name, reason: outcome.message })
                : t('chat.chatInput.toast.guestCommandUnavailable', { name: guestRoute.entry.guestName }));
            return;
        }

        const providerIdToSend = isBtwActive ? effectiveBtwSelection.model?.providerId : currentProviderId;
        const modelIdToSend = isBtwActive ? effectiveBtwSelection.model?.modelId : currentModelId;
        const agentNameToSend = isBtwActive ? effectiveBtwSelection.agent : codexAgentOverride ?? currentAgentName;
        const variantToSend = isBtwActive ? effectiveBtwSelection.variant : currentVariant;

        // The isolated space the message targets, if any: a session by its directory, a draft by
        // the creation request it still waits on or by its directory.
        const spaceTarget = currentSessionId
            ? { requestId: null, directory: currentSessionDirectoryForSync ?? currentDirectory ?? null }
            : newSessionDraftOpen
                ? { requestId: newSessionDraft?.pendingWorktreeRequestId ?? null, directory: newSessionDraft?.directoryOverride ?? null }
                : null;
        // A stopped space takes no message on any model, and its catalog does not load while it is
        // stopped, so this comes before the model check. The message stays in the composer;
        // "Start", where the group's menu offers it, brings the space back and the user sends again.
        const stoppedSpace = spaceTarget ? stoppedSpaceOfTarget(spaceTarget) : null;
        if (stoppedSpace) {
            toast.error(t(stoppedSpace.reason === 'gone' ? 'spaces.draft.spaceGone' : stoppedSpace.reason === 'unreachable' ? 'spaces.draft.spaceUnreachable' : 'spaces.draft.spaceStopped'), stoppedSpace.start ? {
                action: {
                    label: t('spaces.actions.start'),
                    onClick: () => void runSpaceAction(stoppedSpace.spaceId, 'start'),
                },
            } : undefined);
            return;
        }

        if (!providerIdToSend || !modelIdToSend) {
            console.warn('Cannot send message: provider or model not selected');
            toast.error(t('chat.chatInput.toast.noModelSelected'));
            return;
        }

        // A message to an isolated space goes only on a model the space holds a key for; otherwise
        // it stays in the input with the reason and the way to the grant dialog.
        const spaceRefusal = spaceTarget ? spaceModelRefusal(spaceTarget, providerIdToSend) : null;
        if (spaceRefusal) {
            const provider = useConfigStore.getState().providers.find((entry) => entry.id === spaceRefusal.providerId)?.name ?? spaceRefusal.providerId;
            // No grant gives a space OpenCode's models, so that dialog opens on no provider.
            toast.error(spaceRefusal.reason === 'opencode'
                ? t('spaces.draft.modelOpenCode')
                : spaceRefusal.reason === 'needs_again'
                    ? t('spaces.draft.modelNeedsKeyAgain', { provider })
                    : t('spaces.draft.modelNotGranted', { provider }), {
                action: {
                    label: t('spaces.group.access.give'),
                    onClick: () => useSpacesStore.getState().openAccessDialog(spaceRefusal.spaceId, spaceRefusal.reason === 'opencode' ? null : spaceRefusal.providerId),
                },
            });
            return;
        }

        // Auto-review owns the active workflow; follow-ups wait in its queue.
        if (currentSessionId && autoReviewRunning && !isBtwActive && !commandPlan) {
            void handleQueueMessage();
            return;
        }

        // btw mode: the child fork's blocking prompts are answered inside the
        // panel; the composer send goes straight to the fork (routeMessage
        // queues if the fork's own turn is busy).
        // Sending is authoritative for blocking prompts: deny pending
        // permissions and dismiss open forms for the session subtree. The
        // deny/clear vanishes the card instantly (optimistic); rejecting
        // unblocks the agent's tool but does NOT end its turn.
        let dismissedBlockingPrompt = false;
        if (currentSessionId && !isBtwActive) {
            const [dismissedPermissions, dismissedQuestions] = await Promise.all([
                sessionActions.dismissOpenPermissionsForSession(currentSessionId),
                sessionActions.dismissOpenFormsForSession(currentSessionId),
            ]);
            if (!isSubmissionContextCurrent()) return;
            dismissedBlockingPrompt = dismissedPermissions || dismissedQuestions;
            if (isAutoReviewRunningNow()) {
                restoreExplicitInput();
                return;
            }
        }

        let authoritativeSessionPhase: 'idle' | 'busy' | 'retry' | null | undefined;
        let authoritativeUnifiedState: ReturnType<typeof unifiedNativeSessionState>;
        if (submissionSessionId && isUnifiedNativeSessionId(submissionSessionId) && !isBtwActive && inputMode === 'normal') {
            const directory = useSessionUIStore.getState().getDirectoryForSession(submissionSessionId) || currentDirectory;
            try {
                if (!directory) throw new Error('The conversation directory is unavailable');
                const session = await nativeAgents.getSession(submissionSessionId, directory);
                if (!isSubmissionContextCurrent()) return;
                authoritativeUnifiedState = unifiedNativeSessionState(session.metadata);
                authoritativeSessionPhase = authoritativeUnifiedState?.switchReady ? 'idle' : 'busy';
            } catch {
                restoreExplicitInput();
                toast.error(t('chat.chatInput.toast.sessionStatusUnavailable'));
                return;
            }
        }
        // A native CLI takes a prompt whether or not a turn runs, so there is
        // no OpenCode status to confirm first.
        if (
            submissionSessionId
            && !isNativeSessionId(submissionSessionId)
            && !isBtwActive
            && inputMode === 'normal'
            && currentSessionPhase === 'idle'
            && !dismissedBlockingPrompt
            && options?.forceQueue !== true
        ) {
            const statusDirectory = useSessionUIStore.getState().getDirectoryForSession(submissionSessionId)
                || currentDirectory
                || null;
            const statusSnapshot = await opencodeClient.getActiveSessionStatuses(statusDirectory);
            if (!isSubmissionContextCurrent()) return;
            authoritativeSessionPhase = statusSnapshot === null
                ? null
                : statusSnapshot[submissionSessionId]?.type ?? 'idle';
            if (authoritativeSessionPhase === null) {
                restoreExplicitInput();
                toast.error(t('chat.chatInput.toast.sessionStatusUnavailable'));
                return;
            }
        }

        // A native CLI compacts with its own command, which shows as the
        // compaction marker; nothing goes out as a message.
        const nativeCompaction = isNativeTarget && nativeTargetBackend !== 'antigravity' && currentSessionId && !isBtwActive && inputMode === 'normal'
            ? nativeCompactCommand(inputSnapshot.message)
            : null;
        if (nativeCompaction && currentSessionId) {
            setMessage('');
            confirmedMentionsRef.current.clear();
            persistDraftImmediately(chatDraftIdentity, '');
            messageHistory.reset();
            try {
                await sessionActions.compactNativeSession(currentSessionId, {
                    providerID: providerIdToSend,
                    modelID: modelIdToSend,
                    variant: variantToSend,
                    agent: agentNameToSend,
                    instructions: nativeCompaction.instructions,
                });
                scrollToBottom?.();
            } catch (error) {
                restoreComposerText();
                toast.error(getSubmitErrorMessage(error, t('chat.chatInput.toast.compactFailed')));
            }
            return;
        }

        // Action commands change session or UI state and send nothing. The
        // command text goes; the queue and whatever the composer had attached
        // stay exactly where they are.
        if (commandPlan?.kind === 'action' && currentSessionId) {
            const actionName = commandPlan.command.name;
            setMessage('');
            confirmedMentionsRef.current.clear();
            persistDraftImmediately(chatDraftIdentity, '');
            messageHistory.reset();
            if (!isBtwActive) setExpandedInput(false);
            if (isMobile) composerRef.current?.blur();
            try {
                if (actionName === 'undo') {
                    await useSessionUIStore.getState().handleSlashUndo(currentSessionId);
                    scrollToBottom?.();
                } else if (actionName === 'redo') {
                    await useSessionUIStore.getState().handleSlashRedo(currentSessionId);
                    scrollToBottom?.();
                } else if (actionName === 'timeline') {
                    openTimelineDialog();
                } else if (actionName === 'handoff-review') {
                    setReviewDialogOpen(true);
                } else if (actionName === 'fork') {
                    const forkOutcome = await runForkCommand(currentSessionId, commandPlan.command.argument, {
                        // The fork branches the main session, so it keeps that session's
                        // selection even while the btw panel owns the composer.
                        providerID: currentProviderId,
                        modelID: currentModelId,
                        agent: currentAgentName,
                        variant: currentVariant ?? undefined,
                    }, {
                        fork: sessionActions.forkFromLastCompletedTurn,
                        directoryFor: (session) => useSessionUIStore.getState().getDirectoryForSession(session.id) || session.directory || null,
                        send: (text, selection, target) => useSessionUIStore.getState().sendMessage(
                            text,
                            selection.providerID,
                            selection.modelID,
                            selection.agent,
                            undefined,
                            undefined,
                            undefined,
                            selection.variant,
                            'normal',
                            target,
                        ),
                        draftIdentity: (directory, sessionId) => createChatDraftIdentity(getRuntimeKey(), directory, sessionId),
                        restoreText: (target, text) => useInputStore.setState({ pendingComposerRestore: { target, text, files: [] } }),
                    });
                    if (forkOutcome === 'send-failed') toast.error(t('chat.chatInput.toast.forkSendFailed'));
                } else if (actionName === 'compact') {
                    await sessionActions.waitForConnectionOrThrow();
                    const compactDirectory = useSessionUIStore.getState().getDirectoryForSession(currentSessionId) || currentDirectory || undefined;
                    await opencodeClient.compactSession(currentSessionId, compactDirectory);
                }
            } catch (error) {
                restoreComposerText();
                if (actionName === 'fork') {
                    toast.error(error instanceof sessionActions.NothingToForkError
                        ? t('chat.chatInput.toast.forkNothingToFork')
                        : getSubmitErrorMessage(error, t('chat.chatInput.toast.forkFailed')));
                    return;
                }
                if (actionName !== 'compact') throw error;
                toast.error(getSubmitErrorMessage(error, t('chat.chatInput.toast.compactFailed')));
            }
            return;
        }

        const expectedRuntime = {
            runtimeKey: submissionRuntimeKey,
            generation: submissionRuntimeGeneration,
        };
        let sendMessageOptions: {
            userInitiated?: boolean;
            target?: NonNullable<typeof capturedTarget>;
            sessionId?: string;
            directory?: string;
            draftSnapshot?: NonNullable<typeof capturedDraftSnapshot>;
            historySubmissions?: InputHistorySubmission[];
            delivery?: 'steer';
            skills?: SkillMentions;
            expectedRuntime: typeof expectedRuntime;
        } = isBtwActive && btwSessionId && btwDirectory
            ? { sessionId: btwSessionId, directory: btwDirectory, expectedRuntime }
            : {
                ...(capturedTarget ? { target: capturedTarget } : {}),
                ...(capturedDraftSnapshot ? { draftSnapshot: capturedDraftSnapshot } : {}),
                ...(!capturedTarget && submissionSessionId ? { sessionId: submissionSessionId } : {}),
                expectedRuntime,
            };
        const sendCapturedMessage = (...args: Parameters<typeof sendMessage>) => {
            if (!isSubmissionContextCurrent()) {
                return Promise.reject(new SubmissionContextChangedError());
            }
            return sendMessage(...args);
        };

        sendMessageOptions = { ...sendMessageOptions, userInitiated: true };

        const reservedFilenames = new Set(attachedFiles.map((attachment) => attachment.filename));
        // A zip still uploading has no workspace path yet, and a failed one
        // would silently drop out of the message; both block the send so the
        // user makes an explicit call (wait / retry / remove).
        if (attachedFiles.some((file) => file.delivery === 'workspace-upload' && file.uploadState === 'uploading')) {
            toast.error(t('chat.fileAttachment.zip.sendBlockedUploading'));
            return;
        }
        const failedZipUpload = attachedFiles.find(
            (file) => file.delivery === 'workspace-upload' && file.uploadState === 'failed',
        );
        if (failedZipUpload) {
            toast.error(t('chat.fileAttachment.zip.sendBlockedFailed', { name: failedZipUpload.filename }));
            return;
        }
        const readOnSendMentions = await prepareReadOnSendMentions(
            !isBtwActive && inputSnapshot.hasContent ? [inputSnapshot.message] : [],
            reservedFilenames,
            submitRuntimeKey,
        );
        if (readOnSendMentions.status === 'runtime-changed') return;
        if (readOnSendMentions.status === 'failed') {
            toast.error(t('chat.chatInput.toast.attachNamedFailed', { name: readOnSendMentions.filename }));
            return;
        }
        const preparedMentions = readOnSendMentions.prepared;

        // This submission owns only the composer payload. Existing queue items
        // are delivered separately through sendQueuedMessage and its claims.
        const deliveryDecision = resolveFollowUpDeliveryDecision({
            sessionId: isBtwActive ? null : currentSessionId,
            inputMode,
            sessionPhase: currentSessionPhase,
            dismissedBlockingPrompt,
            authoritativeSessionPhase,
        });
        let delivery: 'steer' | 'queue' | undefined;
        if (options?.delivery === 'steer' && currentSessionPhase !== 'idle') {
            delivery = 'steer';
        } else if (options?.forceQueue === true && inputMode === 'normal' && !isBtwActive) {
            delivery = 'queue';
        } else if (deliveryDecision === 'follow-up') {
            delivery = followUpBehavior;
        }
        delivery = resolveNativeFollowUpDelivery({
            delivery,
            sessionId: isBtwActive ? null : submissionSessionId,
            providerID: providerIdToSend,
            sessionPhase: authoritativeSessionPhase ?? currentSessionPhase,
            forceQueue: options?.forceQueue,
            unifiedState: authoritativeUnifiedState,
        });

        const historySubmissions = buildChatInputHistorySubmissions({
            inputMode,
            queuedMessages: [],
            composerText: inputSnapshot.message,
            composerAttachments: attachedFiles,
            includeComposer: inputSnapshot.hasContent,
        });
        if (historySubmissions?.length) {
            sendMessageOptions = { ...sendMessageOptions, historySubmissions };
        }

        // Inline review comments and synthetic context are consumed before
        // assembly so a failed send can restore exactly what it took. What is
        // here belongs to this send: queueing took its own context with it.
        const syntheticParts = isBtwActive ? [] : consumePendingSyntheticParts(mailboxTarget);
        const consumedDraftTarget = inlineDraftTarget;
        const drafts: InlineCommentDraft[] = consumedDraftTarget
            ? consumeDrafts(consumedDraftTarget)
            : [];
        const restoreConsumedDrafts = () => {
            if (isSubmissionContextCurrent() && consumedDraftTarget && drafts.length > 0) {
                useInlineCommentDraftStore.getState().restoreDrafts(consumedDraftTarget, drafts);
            }
        };
        // Everything a prompt command consumed comes back if it fails: the
        // attached context, the typed text, and the files.
        const restoreConsumedInput = () => {
            restoreConsumedDrafts();
            if (syntheticParts?.length) {
                const inputState = useInputStore.getState();
                inputState.setPendingSyntheticParts([...syntheticParts, ...(inputState.getPendingSyntheticParts(mailboxTarget) ?? [])], mailboxTarget);
            }
            restoreComposerText();
            if (attachedFiles.length > 0) {
                useInputStore.getState().restoreAttachedFiles(attachedFiles, chatDraftIdentity);
            }
        };

        const availableSkillNames = new Set(
            selectSkillsForDirectory(useSkillsStore.getState(), currentDirectory).map((skill) => skill.name),
        );

        // Comments become synthetic context, which the send-time expansion
        // below skips, so their own words expand here.
        const expandedDrafts = await expandCommentSnippets(drafts, useSnippetsStore.getState().expandText);

        const outgoing = buildOutgoingMessage({
            composerText: inputSnapshot.message,
            composerAttachments: attachedFiles,
            inlineComments: expandedDrafts,
            syntheticTexts: [
                ...buildBtwSyntheticTexts({ isBtwActive, isPromotedBtwSession }),
                ...(syntheticParts?.map((part) => part.text) ?? []),
            ],
            references: isBtwActive ? [] : linkedReferences.map(toContextReference),
        }, {
            parseAgentMention: (text) => {
                if (isBtwActive) return { text };
                const { sanitizedText, mention } = parseAgentMentions(text, agents);
                return { text: sanitizedText, agentName: mention?.name };
            },
            extractFileMentions: (text) => {
                if (isBtwActive) return { text, attachments: [] };
                const { sanitizedText, attachments } = extractInlineFileMentions(text, preparedMentions);
                return { text: sanitizedText, attachments };
            },
            sanitizeAttachments: sanitizeAttachmentsForSend,
            collectSkillNames: (text) => collectInlineSkillMentions(text, availableSkillNames),
        });

        let primaryText = outgoing.primaryText;
        const { primaryAttachments, additionalParts, agentMentionName, skillNames } = outgoing;

        if (outgoing.isEmpty) return;

        // Skills named inline are attached to the prompt so OpenCode loads
        // them with the message, rather than hoping the model follows a hint.
        if (skillNames.length > 0 && !isNativeTarget) {
            sendMessageOptions = {
                ...sendMessageOptions,
                skills: { names: skillNames, instructionFor: buildSkillMentionInstruction },
            };
        }

        // #3898: inline @-mentions resolve to server paths without checking
        // the file exists, and OpenCode 400s the whole prompt on a missing
        // file. Silently drop the unresolvable ones and submit the rest;
        // the prompt text itself is untouched. Filtered once here so every
        // send path below (magic-prompt, btw fork, optimistic row, main send)
        // carries the same list.
        const { sendable: sendableAttachments } = await filterMissingInlineAttachments(
            primaryAttachments,
            opencodeClient,
        );

        // Workspace-uploaded zips never travel as file parts (providers reject
        // application/zip); the agent gets their paths as a synthetic note.
        const readyZipUploads = sendableAttachments.filter(
            (attachment) => attachment.delivery === 'workspace-upload'
                && attachment.uploadState === 'ready'
                && attachment.workspacePath,
        );
        if (readyZipUploads.length > 0) {
            additionalParts.push({
                text: buildZipUploadNote(readyZipUploads, currentDirectory ?? ''),
                synthetic: true,
            });
        }

        if (!isSubmissionContextCurrent()) return;

        const submittedMentions = new Set(confirmedMentionsRef.current);
        const restoreSubmittedInputAfterError = (error: unknown): boolean => {
            if (error instanceof SubmissionContextChangedError || error instanceof RuntimeContextChangedError) {
                writeChatDraft(chatDraftIdentity, inputSnapshot.message, submittedMentions);
                return true;
            }
            if (!isSubmissionContextCurrent()) {
                writeChatDraft(chatDraftIdentity, inputSnapshot.message, submittedMentions);
                return true;
            }
            const currentInput = composerRef.current?.getValue() ?? messageRef.current;
            const restoredInput = currentInput && currentInput !== inputSnapshot.message
                ? appendWithLineBreaks(inputSnapshot.message, currentInput)
                : inputSnapshot.message;
            const restoredMentions = new Set([
                ...confirmedMentionsRef.current,
                ...submittedMentions,
            ]);
            confirmedMentionsRef.current = restoredMentions;
            messageRef.current = restoredInput;
            setMessage(restoredInput);
            writeChatDraft(chatDraftIdentity, restoredInput, restoredMentions);
            return false;
        };

        if (messageRef.current) {
            messageRef.current = '';
            setMessage('');
        }
        confirmedMentionsRef.current.clear();
        // Clear per-session draft on submit
        persistDraftImmediately(chatDraftIdentity, '');
        messageHistory.reset();
        if (attachedFiles.length > 0) {
            clearAttachedFiles(chatDraftIdentity);
        }
        // Close expanded input overlay when submitting
        setExpandedInput(false);

        if (isMobile) {
            composerRef.current?.blur();
        }

        // Local slash commands, normal mode only. A native session keeps only
        // the ones that act on OpenChamber's view of it; the rest are the CLI's.
        const typedCommand = inputMode === 'normal' ? parseSlashCommand(primaryText) : null;
        const parsedCommand = typedCommand && nativeTargetBackend !== 'antigravity' && (!isNativeTarget || isNativeLocalCommand(typedCommand.name))
            ? typedCommand
            : null;
        if (parsedCommand) {
            const { name: commandName, argument } = parsedCommand;

            // Commands that manipulate session state or open UI rather than
            // sending a message.
            if (commandName === 'undo' && currentSessionId) {
                try {
                    if (!isSubmissionContextCurrent()) throw new SubmissionContextChangedError();
                    await useSessionUIStore.getState().handleSlashUndo(currentSessionId);
                    scrollToBottom?.();
                } catch (error) {
                    if (restoreSubmittedInputAfterError(error)) return;
                    toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.messageSendFailed'));
                }
                return;
            }
            else if (commandName === 'redo' && currentSessionId) {
                try {
                    if (!isSubmissionContextCurrent()) throw new SubmissionContextChangedError();
                    await useSessionUIStore.getState().handleSlashRedo(currentSessionId);
                    scrollToBottom?.();
                } catch (error) {
                    if (restoreSubmittedInputAfterError(error)) return;
                    toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.messageSendFailed'));
                }
                return;
            }
            if (commandName === 'timeline' && currentSessionId) {
                setTimelineDialogOpen(true);
                return;
            }
            if (commandName === 'handoff-review' && currentSessionId && !isMobile && !isVSCodeRuntime()) {
                setReviewDialogOpen(true);
                return;
            }
            if (commandName === 'compact' && currentSessionId) {
                try {
                    await sessionActions.waitForConnectionOrThrow();
                    const compactDirectory = useSessionUIStore.getState().getDirectoryForSession(currentSessionId) || currentDirectory || undefined;
                    await opencodeClient.compactSession(currentSessionId, compactDirectory);
                } catch (error) {
                    if (restoreSubmittedInputAfterError(error)) return;
                    toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.compactFailed'));
                }
                return;
            }
            if (commandName === 'btw' && currentSessionId) {
                const question = argument.trim();
                if (!question) {
                    toast.error(t('chat.btw.toast.emptyArgument'));
                    return;
                }
                const targetDirectory = useSessionUIStore.getState().getDirectoryForSession(currentSessionId)
                    || currentDirectory
                    || null;
                if (!targetDirectory) {
                    toast.error(t('chat.btw.toast.createFailed'));
                    return;
                }
                try {
                    // A new btw replaces this session's current one: destroy
                    // the previous fork first so forks never accumulate.
                    if (btwSessionRef) {
                        await destroyBtwSession(btwSessionRef);
                    }
                    await startBtwSession({
                        parentSessionId: currentSessionId,
                        question,
                        directory: targetDirectory,
                        providerID: providerIdToSend,
                        modelID: modelIdToSend,
                        agent: agentNameToSend,
                        variant: variantToSend,
                    });
                    scrollToBottom?.();
                } catch (error) {
                    toast.error(getSubmitErrorMessage(error, t('chat.btw.toast.createFailed')));
                }
                return;
            }

            // The rest render a visible prompt plus synthetic instructions and
            // send them as one message, the attached context riding along.
            const command = findMagicPromptCommand(commandName);
            if (command) {
                const variables = buildCommandVariables(command, argument);
                try {
                    await sessionActions.waitForConnectionOrThrow();
                    const visibleText = await renderMagicPrompt(command.visiblePrompt, variables.visible);
                    const instructionsText = await renderMagicPrompt(command.instructionsPrompt, variables.instructions);
                    // Before the sent row commits, as for a plain send below.
                    scrollToBottom?.();
                    await sendCapturedMessage(
                        visibleText,
                        providerIdToSend,
                        modelIdToSend,
                        agentNameToSend,
                        sendableAttachments,
                        agentMentionName,
                        [...additionalParts, { text: instructionsText, synthetic: true }],
                        variantToSend,
                        inputMode,
                        sendMessageOptions,
                    );
                } catch (error) {
                    if (restoreSubmittedInputAfterError(error)) return;
                    restoreConsumedInput();
                    toast.error(getSubmitErrorMessage(error, t(command.errorToastKey)));
                }
                return;
            }
        }

        const currentSessionDirectory = capturedTarget?.directory ?? currentDirectory;
        // btw mode: the fork already carries the question plus full history,
        // so the response-style instruction never applies there.
        const shouldAddResponseStyle = !isBtwActive && (newSessionDraftOpen || (currentSessionId ? !hasUserMessages(currentSessionId, currentSessionDirectory) : false));
        if (shouldAddResponseStyle) {
            const responseStyleInstruction = await fetchResponseStyleInstruction().catch(() => null);
            if (responseStyleInstruction) {
                additionalParts.push({
                    text: wrapSystemReminder(responseStyleInstruction),
                    synthetic: true,
                });
            }
        }

        const expandOutgoingSnippets = async () => {
            try {
                const expandText = useSnippetsStore.getState().expandText;
                primaryText = await expandText(primaryText);
                for (const part of additionalParts) {
                    if (!part.synthetic) part.text = await expandText(part.text);
                }
            } catch (error) {
                console.warn('[ChatInput] Failed to expand snippets, sending original text:', error);
            }
        };
        let pendingBtwSend: symbol | null = null;
        if (isBtwActive && btwPanel.pending && currentSessionId) {
            pendingBtwSend = await preparePendingBtwSend(currentSessionId, submitRuntimeKey, expandOutgoingSnippets);
            if (!pendingBtwSend) {
                if (getRuntimeKey() !== submitRuntimeKey) restoreComposerText();
                return;
            }
        } else {
            await expandOutgoingSnippets();
        }
        const ownsPendingBtwSend = () => Boolean(pendingBtwSend && currentSessionId
            && useBtwStore.getState().byParent[currentSessionId]?.pendingSend === pendingBtwSend);

        const restoreConsumedSyntheticParts = () => {
            if (!isSubmissionContextCurrent() || !syntheticParts || syntheticParts.length === 0) return;
            const pending = useInputStore.getState().pendingSyntheticParts ?? [];
            setPendingSyntheticParts([...syntheticParts, ...pending]);
        };
        const restoreComposerAttachments = () => {
            if (!isSubmissionContextCurrent() || attachedFiles.length === 0) return;
            const current = useInputStore.getState().attachedFiles;
            const currentIds = new Set(current.map((attachment) => attachment.id));
            useInputStore.getState().setAttachedFiles([
                ...current,
                ...attachedFiles.filter((attachment) => !currentIds.has(attachment.id)),
            ]);
        };

        if (delivery === 'queue') {
            // The queue stores the resolved payload; its drain has no skill registry.
            const queuedSkillInstruction = buildSkillMentionInstruction(skillNames);
            if (queuedSkillInstruction) additionalParts.push({ text: queuedSkillInstruction, synthetic: true });
            if (!currentSessionId || !messageQueueTarget) {
                restoreConsumedDrafts();
                restoreConsumedSyntheticParts();
                restoreComposerAttachments();
                restoreSubmittedInputAfterError(new Error('Unable to resolve the queue target for this session'));
                toast.error(t('chat.queuedMessage.sendFailed'));
                return;
            }
            try {
                await addToQueue(messageQueueTarget, {
                    content: primaryText,
                    attachments: primaryAttachments,
                    ...(additionalParts.length > 0 ? {
                        additionalParts: additionalParts.map((part) => ({
                            text: part.text,
                            ...(part.attachments && part.attachments.length > 0
                                ? { attachments: part.attachments }
                                : {}),
                            ...(part.synthetic !== undefined ? { synthetic: part.synthetic } : {}),
                            ...(part.metadata ? { metadata: part.metadata } : {}),
                        })),
                    } : {}),
                    ...(agentMentionName ? { agentMentionName } : {}),
                    status: 'staged',
                    sendConfig: {
                        providerID: providerIdToSend,
                        modelID: modelIdToSend,
                        ...(agentNameToSend ? { agent: agentNameToSend } : {}),
                        ...(variantToSend ? { variant: variantToSend } : {}),
                    },
                });
                // The queued message owns the references it was captured with
                // (they travel in its context parts), so the composer drops
                // them the way a direct send does.
                if (linkedReferences.length > 0) setLinkedReferences([]);
                scrollToLatest?.();
                if (!isMobile) composerRef.current?.focus();
                return;
            } catch (error) {
                restoreConsumedDrafts();
                restoreConsumedSyntheticParts();
                restoreComposerAttachments();
                if (restoreSubmittedInputAfterError(error)) return;
                toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.messageSendFailed'));
                return;
            }
        }

        // Re-submitting the same restored text after a failed send reuses the
        // previous message ID: OpenCode merges a repeated ID into the original
        // message, so a retry can never spawn a duplicate user message and a
        // second AI response. New or edited text starts a fresh message.
        const submissionMessageId = lastSubmitRef.current && lastSubmitRef.current.text === primaryText
            ? lastSubmitRef.current.messageId
            : createOpenCodeIdentifier('msg');

        // Arm the timeline anchor before the optimistic user row can commit.
        scrollToBottom?.();

        if (isBtwActive && btwPanel.pending && currentSessionId && btwComposerSessionId) {
            const targetDirectory = useSessionUIStore.getState().getDirectoryForSession(currentSessionId)
                || currentDirectory
                || null;
            if (!targetDirectory) {
                useBtwStore.getState().setPanelState(currentSessionId, { pendingSend: undefined });
                restoreConsumedInput();
                toast.error(t('chat.btw.toast.createFailed'));
                return;
            }
            try {
                const fork = await startBtwSession({
                    parentSessionId: currentSessionId,
                    expectedRuntimeKey: submitRuntimeKey,
                    question: primaryText,
                    directory: targetDirectory,
                    providerID: providerIdToSend,
                    modelID: modelIdToSend,
                    agent: agentNameToSend,
                    variant: variantToSend,
                    attachments: sendableAttachments,
                    additionalParts,
                    skills: sendMessageOptions?.skills,
                    permissionMode: pendingBtwPermissionMode,
                });
                if (!ownsPendingBtwSend()) return;
                if (getRuntimeKey() !== submitRuntimeKey) {
                    useBtwStore.getState().clearPanelState(currentSessionId);
                    return;
                }
                const forkDirectory = fork.directory ?? targetDirectory;
                migrateDraft(chatDraftIdentity, createChatDraftIdentity(activeRuntimeKey, forkDirectory, fork.id));
                if (inlineDraftTarget) {
                    const drafts = useInlineCommentDraftStore.getState();
                    drafts.restoreDrafts({ directory: forkDirectory, sessionKey: fork.id }, drafts.consumeDrafts(inlineDraftTarget));
                }
                useBtwStore.getState().setPanelState(currentSessionId, { pending: false, creating: false, pendingSend: undefined });
                scrollToBottom?.();
            } catch (error) {
                if (!ownsPendingBtwSend()) return;
                if (getRuntimeKey() !== submitRuntimeKey) {
                    useBtwStore.getState().clearPanelState(currentSessionId);
                    restoreComposerText();
                    return;
                }
                // Preserve the pending owner before restoring text so a failed
                // first send never drops back into the parent draft.
                useBtwStore.getState().setPanelState(currentSessionId, { pending: true, creating: false, collapsed: false, pendingSend: undefined });
                restoreConsumedInput();
                toast.error(getSubmitErrorMessage(error, t('chat.btw.toast.createFailed')));
            }
            return;
        }

        const sendPromise = sendCapturedMessage(
            primaryText,
            providerIdToSend,
            modelIdToSend,
            agentNameToSend,
            sendableAttachments,
            agentMentionName,
            additionalParts.length > 0 ? additionalParts : undefined,
            variantToSend,
            inputMode,
            delivery
                ? { ...sendMessageOptions, delivery, messageId: submissionMessageId }
                : { ...sendMessageOptions, messageId: submissionMessageId },
        );
        const handledSendPromise = sendPromise.then(() => {
            lastSubmitRef.current = undefined;
            if (isBtwActive) return;
            // Record what this session was pointed at, so the work-status panel
            // can show it as a context source long after the message scrolled
            // away. A snapshot only — never re-fetched, never authoritative.
            // Failures are swallowed: the message went out, and a missing
            // bookkeeping entry must not surface as a send error.
            // On a draft there is no session yet in this closure: the send path
            // creates one and makes it current before resolving, so the id is
            // read from the store. The fallback is used only when the closure
            // had no session at all, so a mid-send session switch cannot
            // redirect the write to an unrelated session.
            const sessionState = useSessionUIStore.getState();
            const linkTargetSessionId = currentSessionId ?? sessionState.currentSessionId;
            const linkTargetDirectory = currentSessionId
                ? currentSessionDirectoryForSync ?? currentDirectory
                : sessionState.currentSessionDirectory
                    ?? (linkTargetSessionId ? sessionState.getDirectoryForSession(linkTargetSessionId) : null)
                    ?? currentDirectory;
            if (linkTargetSessionId) {
                recordLinkedReferences(linkTargetSessionId, linkTargetDirectory, linkedReferences);
            }
            // A session that starts with a Linear issue attached reports itself
            // on that issue (the Linear card's Session comments), however it
            // was started: a draft, a worktree made from the issue.
            if (!currentSessionId && linkTargetSessionId) {
                for (const reference of linkedReferences) {
                    if (reference.kind !== 'linear-issue') continue;
                    postLinearSessionStarted(runtimeLinear, { sessionId: linkTargetSessionId, issueIdentifier: reference.identifier });
                }
            }

            // The sent references leave the composer; one attached while the
            // send was out stays for the next message.
            const sentKeys = new Set(linkedReferences.map(composerReferenceKey));
            setLinkedReferences((current) => current.filter((reference) => !sentKeys.has(composerReferenceKey(reference))));
        }).catch((error: unknown) => {
            if (sessionActions.isUnconfirmedSendError(error)) {
                // The send outcome could not be confirmed: the optimistic
                // message stays in the transcript and the composer stays
                // cleared so a retry cannot duplicate a prompt the engine may
                // already be answering. A delayed rollback (definitively not
                // sent) restores the input through the rollback listener.
                lastSubmitRef.current = { messageId: submissionMessageId, text: primaryText };
                restoreConsumedDrafts();
                restoreConsumedSyntheticParts();
                restoreComposerAttachments();
                toast.warning(t('chat.chatInput.toast.sendUnconfirmed'));
                return;
            }

            const rawMessage =
                error instanceof Error
                    ? error.message
                    : typeof error === 'string'
                        ? error
                        : String(error ?? '');
            const normalized = rawMessage.toLowerCase();
            const isSoftNetworkError = sessionActions.isAmbiguousSendFailure(error);

            // Keep the ID so a retry of the restored text merges into the
            // original message instead of duplicating it.
            lastSubmitRef.current = { messageId: submissionMessageId, text: primaryText };
            restoreConsumedDrafts();
            restoreConsumedSyntheticParts();
            restoreComposerAttachments();
            if (restoreSubmittedInputAfterError(error)) return;
            console.error('Message send failed:', rawMessage || error);
            restoreComposerText();

            if (error instanceof NativeAgentsRequestError) {
                const key = nativeSessionActionErrorKey(error, currentSessionId);
                if (key) { toast.error(t(key)); return; }
            }

            if (normalized.includes('payload too large') || normalized.includes('413') || normalized.includes('entity too large')) {
                toast.error(t('chat.chatInput.toast.attachmentsTooLarge'));
                return;
            }

            if (error instanceof NativeAgentsRequestError && error.code === 'NATIVE_HISTORY_NOT_PORTABLE') {
                toast.error(t('chat.chatInput.toast.historyNotPortable'));
                return;
            }

            if (isSoftNetworkError) {
                if (attachedFiles.length > 0) {
                    toast.error(t('chat.chatInput.toast.sendAttachmentsFailed'));
                }
                return;
            }

            toast.error(rawMessage || t('chat.chatInput.toast.messageSendFailed'));
        });

        if (!isMobile) {
            composerRef.current?.focus();
        }

        await handledSendPromise;
    };

    // Update ref with latest handleSubmit on every render
    handleSubmitRef.current = handleSubmit;

    // Every send surface routes through the same command-aware submit path.
    const handlePrimaryAction = React.useCallback(() => {
        void handleSubmitRef.current();
    }, []);

    const handleQueueMessage = React.useCallback(() => {
        void handleSubmitRef.current({ forceQueue: true });
    }, []);

    // Draft welcome presets: submit immediately.
    const submitPresetPrompt = React.useCallback((text: string, type: 'command' | 'skill') => {
        // The text goes straight into the submit (see SubmitOptions.presetText)
        // instead of through the composer input — the collapsed mobile pill has
        // no mounted textarea to stage it in.
        const draft = (composerRef.current?.getValue() ?? messageRef.current).trim();
        // OpenCode recognizes slash commands only when their arguments follow
        // the command on the same line. Skills retain the multiline prompt form.
        const presetText = draft ? `${text}${type === 'command' ? ' ' : '\n'}${draft}` : text;
        void handleSubmitRef.current({ presetText });
    }, []);
    const handlePresetChipSubmit = React.useCallback((starter: ResolvedStarter) => {
        submitPresetPrompt(starter.submitText, starter.ref.type);
    }, [submitPresetPrompt]);

    const { markDictationStart, keepTranscriptForOrigin } = useDictationOrigin({
        identityRef: currentChatDraftIdentityRef,
        restoreDraft,
        onKeptForOrigin: () => {
            toast.info(t('chat.chatInput.toast.dictationKeptForOriginalSession'));
        },
    });

    // Dictation: insert the transcript inline; optionally submit immediately.
    // getCurrentInputSnapshot reads composerRef.current.getValue() first, so setting
    // it synchronously lets handleSubmit pick up the text in the same tick.
    // A transcript belongs to the draft that was on screen when recording
    // started. After a session switch it is kept for that draft and must not
    // be inserted or sent here.
    const handleDictationInsert = React.useCallback((text: string) => {
        if (keepTranscriptForOrigin(text)) return;
        dictationSendEndRef.current?.();
        setMessage((prev) => {
            // The editor is controlled by this state; getCurrentInputSnapshot
            // reads it back, so no imperative write is needed.
            return appendInlineText(prev, text);
        });
        setTimeout(() => {
            composerRef.current?.focus();
        }, 0);
    }, [keepTranscriptForOrigin]);

    const handleDictationInsertAndSend = React.useCallback((text: string) => {
        if (keepTranscriptForOrigin(text)) return;
        // Read the pending draft from the ref, NOT from the editor: the
        // transcript resolves asynchronously, and on mobile the shell may have
        // already collapsed into the pill by then, so the editor is unmounted
        // and getValue() returns '' — which silently dropped the user's typed
        // text and (once the composer cleared) the transcript with it.
        const next = appendInlineText(messageRef.current, text);
        // Land the composed text in the composer state first, so a failed send
        // restores exactly what the user dictated, then submit it as an
        // explicit override (the textarea may be unmounted at this point).
        setMessage(next);
        dictationSendInFlightRef.current = true;
        void handleSubmitRef.current({ presetText: next }).finally(() => {
            dictationSendEndRef.current?.();
        });
    }, [keepTranscriptForOrigin]);

    // A command with an argument sends once the isolated composer owns its draft.
    React.useEffect(() => {
        const pending = immediateBtwSubmitRef.current;
        if (!pending || !isBtwActive || !chatDraftIdentity) return;
        if (getChatDraftIdentityKey(pending.identity) !== getChatDraftIdentityKey(chatDraftIdentity)) {
            immediateBtwSubmitRef.current = null;
            return;
        }
        immediateBtwSubmitRef.current = null;
        void handleSubmit({ presetText: pending.text });
    });

    // Preset chips rendered outside this component (e.g. under the welcome
    // message on narrow surfaces) request a submit via the input store; consume
    // it here so it routes through the same command-aware submit path.
    React.useEffect(() => {
        if (pendingPresetSubmit == null || columnPinned) return;
        const text = useInputStore.getState().consumePendingPresetSubmit();
        if (text) submitPresetPrompt(text.text, text.type);
    }, [columnPinned, pendingPresetSubmit, submitPresetPrompt]);

    // A first message a native Shortcuts request left for this draft goes out
    // once the draft's project has its models and agents and one is selected,
    // so it is sent with the project's defaults, the way a typed first message
    // would be. A request for another draft is dropped, never sent from here.
    // The text goes into the composer before the send, so a send that stops
    // early (a stopped space, no model) leaves it there. A draft that already
    // holds something (text, files, comments, references, context) gets the
    // text appended and nothing is sent: the shortcut never sends or clears
    // what the user put there.
    const draftSubmitDraftId = newSessionDraftOpen ? newSessionDraft.draftId : null;
    React.useEffect(() => {
        if (pendingDraftSubmit == null || columnPinned) return;
        if (draftSubmitDraftId === pendingDraftSubmit.draftId && (!configCatalogLoaded || !currentProviderId || !currentModelId)) return;
        const text = useInputStore.getState().consumePendingDraftSubmit(draftSubmitDraftId);
        if (!text) return;
        const composerHolds = getCurrentInputSnapshot().hasContent
            || (useInputStore.getState().getPendingSyntheticParts(mailboxTarget)?.length ?? 0) > 0;
        if (composerHolds) {
            setMessage((prev) => appendWithLineBreaks(prev, text));
            return;
        }
        setMessage(text);
        messageRef.current = text;
        void handleSubmitRef.current({ presetText: text });
    }, [columnPinned, configCatalogLoaded, currentModelId, currentProviderId, draftSubmitDraftId, getCurrentInputSnapshot, mailboxTarget, pendingDraftSubmit]);

    const handleKeyDown = (e: KeyboardEvent) => {
        // Early return during IME composition to prevent interference with autocomplete.
        // Uses keyCode === 229 fallback for WebKit where compositionend fires before keydown.
        if (isIMECompositionEvent(e)) {
            largeTextPasteGesture.invalidate();
            return;
        }
        if (largeTextPasteBehavior === 'inline-double-paste') largeTextPasteGesture.keyDown(e);

        // Enter shell mode before CodeMirror inserts the trigger. Keeping the
        // document unchanged also keeps the caret at the start for the first
        // command character.
        if (!isBtwActive && !isNativeTarget && inputMode === 'normal' && e.key === '!') {
            const selection = composerRef.current?.getSelection();
            if (selection?.start === 0 && selection.end === 0) {
                e.preventDefault();
                setInputMode('shell');
                closeAutocomplete();
                return;
            }
        }

        if (inputMode === 'shell' && e.key === 'Escape') {
            e.preventDefault();
            setInputMode('normal');
            return;
        }

        if (inputMode === 'shell' && e.key === 'Backspace' && message.length === 0) {
            e.preventDefault();
            setInputMode('normal');
            return;
        }

        const autocomplete = openAutocomplete === 'command' ? commandRef.current
            : openAutocomplete === 'skill' ? skillRef.current
                : openAutocomplete === 'snippet' ? snippetRef.current
                    : openAutocomplete === 'mention' ? mentionRef.current
                        : null;
        const autocompleteKey = getDropdownNavigationKey(e) ?? e.key;
        if (autocomplete && (autocompleteKey === 'Enter' || autocompleteKey === 'ArrowUp' || autocompleteKey === 'ArrowDown' || autocompleteKey === 'Escape' || autocompleteKey === 'Tab')) {
            e.preventDefault();
            e.stopPropagation();
            autocomplete.handleKeyDown(autocompleteKey);
            return;
        }

        if (isBtwActive && currentSessionId && e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            handleExitBtw();
            return;
        }

        if (isDesktopExpanded && e.key === 'Escape') {
            e.preventDefault();
            setExpandedInput(false);
            return;
        }

        const cycleAgentBackwardShortcut = cycleAgentShortcut && !cycleAgentShortcut.includes('shift')
            ? normalizeCombo(`shift+${cycleAgentShortcut}`)
            : '';
        const cycleAgentDirection = cycleAgentBackwardShortcut && eventMatchesShortcut(e, cycleAgentBackwardShortcut)
            ? -1
            : eventMatchesShortcut(e, cycleAgentShortcut)
                ? 1
                : 0;

        if (!isBtwActive && cycleAgentDirection !== 0 && openAutocomplete === null) {
            e.preventDefault();
            e.stopPropagation();
            handleCycleAgent(cycleAgentDirection);
            return;
        }

        // Handle ArrowUp/ArrowDown for message history navigation
        // ArrowUp: only when cursor at start (position 0) or input is empty
        // ArrowDown: also works when cursor at end (to cycle forward through history)
        const isAnyAutocompleteOpen = openAutocomplete !== null;
        const cursorAtStart = composerRef.current?.getSelection().start === 0 && composerRef.current?.getSelection().end === 0;
        const cursorAtEnd = composerRef.current?.getSelection().start === message.length && composerRef.current?.getSelection().end === message.length;
        const canNavigateHistoryUp = !isAnyAutocompleteOpen && (message.length === 0 || cursorAtStart);
        const canNavigateHistoryDown = !isAnyAutocompleteOpen && (message.length === 0 || cursorAtEnd);

        // Markdown-aware auto-pairing (source mode), normal input only.
        if (inputMode === 'normal' && !isAnyAutocompleteOpen && !e.metaKey && !e.ctrlKey && !e.altKey) {
            const ta = composerRef.current;
            const selStart = ta?.getSelection().start ?? -1;
            const selEnd = ta?.getSelection().end ?? -1;

            if (ta && selStart >= 0) {
                const edit = getMarkdownAutoPairEdit(message, e.key, selStart, selEnd);
                if (edit) {
                    e.preventDefault();
                    ta.replaceRange(
                        edit.from,
                        edit.to,
                        edit.insert,
                        edit.selectionStart,
                        edit.selectionEnd,
                    );
                    return;
                }
            }
        }

        if (e.key === 'ArrowUp' && canNavigateHistoryUp) {
            e.preventDefault();
            const recalled = messageHistory.older({ text: message, attachments: attachedFiles });
            if (recalled !== null) {
                setMessage(recalled.text);
                useInputStore.getState().setAttachedFiles([...recalled.attachments]);
                // Caret to the start, so the recalled message reads from its
                // beginning rather than from wherever the draft's caret was.
                requestAnimationFrame(() => composerRef.current?.setSelection(0, 0));
            }
            return;
        }

        if (e.key === 'ArrowDown' && canNavigateHistoryDown) {
            e.preventDefault();
            const recalled = messageHistory.newer({ text: message, attachments: attachedFiles });
            if (recalled !== null) {
                setMessage(recalled.text);
                useInputStore.getState().setAttachedFiles([...recalled.attachments]);
                requestAnimationFrame(() => composerRef.current?.setSelection(recalled.text.length, recalled.text.length));
            }
            return;
        }

        // Preserve each surface's existing default until the user changes the
        // setting. Once configured, the choice applies consistently everywhere.
        // Queue-versus-steer is decided by the authoritative follow-up decision
        // inside handleSubmit; Ctrl/Cmd+Enter is an explicit send-now.
        const isCtrlEnter = e.ctrlKey || e.metaKey;
        if (e.key === 'Enter' && shouldSubmitEnter({
            isMobile,
            isDesktopExpanded,
            enterToSend,
            enterToSendConfigured,
            shiftKey: e.shiftKey,
            ctrlKey: e.ctrlKey,
            metaKey: e.metaKey,
        })) {
            e.preventDefault();
            // An empty composer sends nothing from the keyboard. Flushing the
            // queue is the send button's job; a stray Enter must not push
            // every queued message into the running turn.
            if (!hasContent) return;

            if (isCtrlEnter) {
                handleSubmit({ delivery: 'steer' });
            } else {
                handleSubmit();
            }
        }
    };

    // Focus mode places the open picker at the caret; elsewhere each picker
    // anchors to the composer itself.
    const {
        position: autocompleteOverlayPosition,
        update: updateAutocompleteOverlayPosition,
    } = useAutocompletePosition({
        enabled: isDesktopExpanded,
        openAutocomplete,
        message,
        editorRef: composerRef,
        containerRef: dropZoneRef,
    });


    const handleAbort = React.useCallback(() => {
        clearAbortPrompt();

        // btw mode: the stop button stops the fork's turn, not the main
        // session's.
        const abortTarget = isBtwActive && btwSessionId ? btwSessionId : currentSessionId;
        void abortCurrentOperation(abortTarget || undefined);
    }, [abortCurrentOperation, btwSessionId, clearAbortPrompt, currentSessionId, isBtwActive]);

    const handleCycleAgent = React.useCallback((direction: 1 | -1 = 1) => {
        // Auto hides the agent control, so the shortcut must not change a
        // choice the user cannot see.
        if (isAutoModel(currentProviderId, currentModelId)) return;
        const cyclableAgents = isNativeTarget ? agents.filter((agent) => NATIVE_AGENT_NAMES.has(agent.name)) : agents;
        const nextAgentName = getCycledPrimaryAgentName(cyclableAgents, currentAgentName, direction, useUIStore.getState().favoriteAgents);
        if (!nextAgentName) return;

        // A pinned column's agent is its own session's choice only.
        if (!columnPinned) setAgent(nextAgentName);

        if (currentSessionId) {
            saveSessionAgentSelection(currentSessionId, nextAgentName);
        }
    }, [agents, columnPinned, currentAgentName, currentModelId, currentProviderId, currentSessionId, isNativeTarget, setAgent, saveSessionAgentSelection]);

    // Height the failed-dictation salvage text needs. Its overlay sits
    // absolutely over the composer, so the composer must be able to grow for
    // it. Apply the editor's line and screen bounds before using that height as
    // a floor, otherwise long salvage text can push the action row off-screen.
    const dictationHeightHostRef = React.useRef<HTMLDivElement | null>(null);
    const [dictationContentHeight, setDictationContentHeight] = React.useState<number | null>(null);
    const handleDictationContentHeightChange = React.useCallback((height: number | null) => {
        setDictationContentHeight((prev) => (prev === height ? prev : height));
    }, []);
    const dictationHeightLimit = useComposerHeightLimit({
        active: dictationContentHeight !== null,
        disabled: isComposerExpanded,
        hostRef: dictationHeightHostRef,
        maxLines: isMobile ? MAX_MOBILE_COMPOSER_LINES : MAX_VISIBLE_COMPOSER_LINES,
        boundSelector: isMobile ? '[data-composer-bound]' : undefined,
        boundGapPx: isMobile ? MOBILE_COMPOSER_BOUND_GAP_PX : 0,
    });

    const updateAutocompleteState = React.useCallback((
        value: string,
        cursorPosition: number,
        inputSource: FileMentionAutocompleteInputSource = 'manual',
        insertedText?: string,
    ) => {
        const trigger = resolveAutocompleteTrigger(value, cursorPosition, {
            inputMode,
            mentionsEnabled: !isBtwActive,
            inputSource,
            insertedText,
        });
        // OpenCode's skills mean nothing to a native CLI; its command picker
        // offers the CLI's own commands, which go out as typed.
        const offered = trigger && isNativeTarget && trigger.kind === 'skill' ? null : trigger;
        setOpenAutocomplete(offered?.kind ?? null);
        setAutocompleteQuery(offered?.query ?? '');
    }, [inputMode, isBtwActive, isNativeTarget]);

    const insertTextAtSelection = React.useCallback((
        text: string,
        inputSource: FileMentionAutocompleteInputSource = 'manual',
    ) => {
        if (!text) {
            return;
        }

        const editor = composerRef.current;
        if (!editor) {
            // No mounted editor (collapsed mobile pill): append to the state
            // the editor will be seeded from.
            const nextValue = messageRef.current + text;
            setMessage(nextValue);
            updateAutocompleteState(nextValue, nextValue.length, inputSource, text);
            return;
        }

        const { start, end } = editor.getSelection();
        // Read the live document — delayed toast actions must not use a
        // paste-time React `message` closure.
        const currentMessage = editor.getValue();
        const nextValue = `${currentMessage.substring(0, start)}${text}${currentMessage.substring(end)}`;
        const cursorPosition = start + text.length;

        // One dispatch places both the text and the caret, so there is no
        // frame where the caret sits at a stale offset.
        editor.insertText(text);
        updateAutocompleteState(nextValue, cursorPosition, inputSource, text);
    }, [updateAutocompleteState]);

    const clearDropTextSuppression = React.useCallback(() => {
        suppressNextFileDropTextInsertRef.current = false;
        pendingDroppedAbsolutePathsRef.current = [];
        if (suppressNextFileDropTextInsertTimeoutRef.current) {
            clearTimeout(suppressNextFileDropTextInsertTimeoutRef.current);
            suppressNextFileDropTextInsertTimeoutRef.current = null;
        }
    }, []);

    const scheduleDropTextSuppressionExpiry = React.useCallback(() => {
        if (suppressNextFileDropTextInsertTimeoutRef.current) {
            clearTimeout(suppressNextFileDropTextInsertTimeoutRef.current);
        }
        suppressNextFileDropTextInsertTimeoutRef.current = setTimeout(() => {
            clearDropTextSuppression();
        }, 700);
    }, [clearDropTextSuppression]);

    const clearFileMentionPasteSuppression = React.useCallback(() => {
        suppressNextFileMentionPasteRef.current = false;
        if (suppressNextFileMentionPasteTimeoutRef.current) {
            clearTimeout(suppressNextFileMentionPasteTimeoutRef.current);
            suppressNextFileMentionPasteTimeoutRef.current = null;
        }
    }, []);

    const markFileMentionPasteSuppression = React.useCallback(() => {
        suppressNextFileMentionPasteRef.current = true;
        if (suppressNextFileMentionPasteTimeoutRef.current) {
            clearTimeout(suppressNextFileMentionPasteTimeoutRef.current);
        }
        suppressNextFileMentionPasteTimeoutRef.current = setTimeout(() => {
            suppressNextFileMentionPasteRef.current = false;
            suppressNextFileMentionPasteTimeoutRef.current = null;
        }, 700);
    }, []);

    const handleComposerChange = ({ value, selection, fromPaste, insertedText, fromValueProp }: ComposerChange) => {
        if (largeTextPasteBehavior === 'inline-double-paste') {
            largeTextPasteGesture.change({
                value, selection, fromPaste, insertedText,
                scope: getLargeTextPasteScope(),
            });
        }
        if (shellTriggerNormalizationRef.current) {
            shellTriggerNormalizationRef.current = false;
            setMessage(value);
            return;
        }

        // VS Code drops the dragged path as text as well as firing the drop
        // handler; swallow that duplicate insertion.
        if (isVSCodeRuntime() && suppressNextFileDropTextInsertRef.current) {
            const candidateAbsolutePaths = pendingDroppedAbsolutePathsRef.current;
            if (candidateAbsolutePaths.some((path) => path.length > 0 && value.includes(path))) {
                clearDropTextSuppression();
                return;
            }
        }

        const pastedInsertedText = fromPaste ? insertedText : '';
        const isPasteInput = pastedInsertedText.includes('@') || suppressNextFileMentionPasteRef.current;
        if (suppressNextFileMentionPasteRef.current) {
            clearFileMentionPasteSuppression();
        }
        const inputSource: FileMentionAutocompleteInputSource = isPasteInput ? 'paste' : 'manual';

        // A leading `!` switches the composer into shell mode and is consumed.
        // Mobile keyboards and paste may update the document without a usable
        // keydown, so consume the trigger in the same editor transaction rather
        // than moving the caret in a later frame against stale text.
        if (!isBtwActive && !isNativeTarget && inputMode === 'normal' && value.startsWith('!')) {
            const shellCommand = value.slice(1);
            const nextCursor = Math.max(0, selection.start - 1);
            setInputMode('shell');
            closeAutocomplete();
            const editor = composerRef.current;
            if (editor) {
                shellTriggerNormalizationRef.current = true;
                editor.replaceRange(0, 1, '', nextCursor);
            } else {
                setMessage(shellCommand);
            }
            return;
        }

        messageRef.current = value;
        setMessage(value);
        // Text the app set (a restored draft, a prepared prompt) is not a
        // trigger being typed: a `#` line in it must not open the snippet list.
        if (fromValueProp) {
            closeAutocomplete();
            return;
        }
        updateAutocompleteState(value, selection.start, inputSource, pastedInsertedText);
    };

    React.useEffect(() => {
        return () => {
            clearDropTextSuppression();
            clearFileMentionPasteSuppression();
        };
    }, [clearDropTextSuppression, clearFileMentionPasteSuppression]);

    /**
     * Attach files that arrived by paste or drop and cite each one in the
     * draft as `[name]`, the same way pasted images are cited. Images get a
     * generated unique name up front; other files keep their own name and are
     * cited only once they attached, so a rejected file leaves no dangling
     * citation.
     */
    const attachFilesWithCitation = React.useCallback(async (
        files: File[],
        leadingText: string = '',
    ): Promise<void> => {
        const attachmentDraftKey = useInputStore.getState().attachmentDraftKey;
        const imageFiles = files.filter((file) => file.type.startsWith('image/'));
        const otherFiles = files.filter((file) => !file.type.startsWith('image/'));

        const insertCitation = (filenames: string[], text: string) => {
            if (filenames.length === 0 && !text) return;
            const citationText = buildAttachmentCitationText(filenames);
            const editor = composerRef.current;
            const currentMessage = editor?.getValue() ?? messageRef.current;
            const selectionStart = editor?.getSelection().start ?? currentMessage.length;
            const selectionEnd = editor?.getSelection().end ?? currentMessage.length;
            const insertionText = withInlineInsertionBoundaries(
                buildImagePasteInsertion(text, citationText),
                currentMessage.slice(0, selectionStart),
                currentMessage.slice(selectionEnd),
            );
            insertTextAtSelection(insertionText, getFileMentionInputSourceForInsertedText(insertionText));
        };

        const assignedImageNames = assignImageAttachmentFilenames(
            imageFiles,
            [
                ...useInputStore.getState().attachedFiles.map((file) => file.filename),
                ...pendingPastedAttachmentFilenamesRef.current,
            ],
        );
        // Pending before the text lands, so the editor draws the citation as a
        // chip in the same transaction that inserts it.
        for (const filename of assignedImageNames) pendingPastedAttachmentFilenamesRef.current.add(filename);
        insertCitation(assignedImageNames, leadingText);

        let attached = false;
        for (let index = 0; index < imageFiles.length; index += 1) {
            const filename = assignedImageNames[index];
            const file = renameFileForAttachmentCitation(imageFiles[index], filename);
            try {
                attached = (await addAttachedFile(file)) || attached;
            } catch (error) {
                console.error('Clipboard image attach failed', error);
                toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.clipboardAttachFailed'));
            } finally {
                pendingPastedAttachmentFilenamesRef.current.delete(filename);
            }
            if (useInputStore.getState().attachmentDraftKey !== attachmentDraftKey) {
                // The draft changed under the paste: the rest never attach here.
                for (const rest of assignedImageNames.slice(index + 1)) pendingPastedAttachmentFilenamesRef.current.delete(rest);
                return;
            }
        }

        const attachedOtherNames: string[] = [];
        for (const file of otherFiles) {
            try {
                if (await addAttachedFile(file)) {
                    attached = true;
                    attachedOtherNames.push(file.name);
                }
            } catch (error) {
                console.error('File attach failed', error);
            }
            if (useInputStore.getState().attachmentDraftKey !== attachmentDraftKey) return;
        }
        insertCitation(attachedOtherNames, '');

        if (files.length > 0 && !attached) {
            toast.error(t('chat.chatInput.toast.attachFileFailed'));
        }
    }, [addAttachedFile, insertTextAtSelection, t]);

    const handlePaste = React.useCallback(async (event: ClipboardEvent) => {
        const clipboardData = event.clipboardData;
        if (!clipboardData) return;
        // Narrowed alias so the rest of the handler reads as it did when this
        // was a React synthetic event, whose clipboardData is never null.
        const e = { ...event, clipboardData, preventDefault: () => event.preventDefault() };

        // Pasting a URL over a selection wraps it as a markdown link:
        // [selected text](pasted url).
        if (inputMode === 'normal' && (currentSessionId || newSessionDraftOpen)) {
            const ta = composerRef.current;
            const selStart = ta?.getSelection().start ?? -1;
            const selEnd = ta?.getSelection().end ?? -1;
            if (ta && selEnd > selStart) {
                const clipboardText = e.clipboardData.getData('text');
                const url = clipboardText.trim();
                const selected = message.slice(selStart, selEnd);
                if (shouldWrapSelectionAsLink(url, selected)) {
                    e.preventDefault();
                    const next = `${message.slice(0, selStart)}[${selected}](${url})${message.slice(selEnd)}`;
                    const caret = selStart + 1 + selected.length + 2 + url.length + 1;
                    setMessage(next);
                    composerRef.current?.setSelection(caret, caret);
                    updateAutocompleteState(next, caret, getFileMentionInputSourceForInsertedText(url), url);
                    largeTextPasteGesture.invalidate();
                    return;
                }
            }
        }

        // Images get a citation and a generated name; every other clipboard
        // file (Finder/Explorer copy, a saved document) attaches as picked.
        const imageMap = new Map<string, File>();
        const otherFileMap = new Map<string, File>();
        const collectClipboardFile = (file: File) => {
            const target = file.type.startsWith('image/') ? imageMap : otherFileMap;
            target.set(`${file.name}-${file.size}`, file);
        };

        Array.from(e.clipboardData.files || []).forEach(collectClipboardFile);

        Array.from(e.clipboardData.items || []).forEach(item => {
            if (item.kind !== 'file') return;
            const file = item.getAsFile();
            if (file) collectClipboardFile(file);
        });

        const imageFiles = Array.from(imageMap.values());
        const otherFiles = Array.from(otherFileMap.values());
        const pastedText = e.clipboardData.getData('text');
        const sessionReady = Boolean(currentSessionId || newSessionDraftOpen);

        let conversion: LargeTextPasteCandidate | null = null;
        if (largeTextPasteBehavior === 'inline-double-paste') {
            const snapshot = readLargeTextPasteSnapshot();
            if (snapshot && sessionReady && inputMode === 'normal' && imageFiles.length === 0 && otherFiles.length === 0) {
                conversion = largeTextPasteGesture.beginPaste(pastedText, snapshot);
            } else {
                largeTextPasteGesture.invalidate();
            }
        }

        if (imageFiles.length === 0 && otherFiles.length > 0) {
            // A copied file also carries its name as text; keep it out of the draft.
            e.preventDefault();
            if (!sessionReady) return;
            await attachFilesWithCitation(otherFiles);
            return;
        }

        if (imageFiles.length === 0) {
            const behavior: LargeTextPasteBehavior = largeTextPasteBehavior;
            const shouldOfferLargePaste = sessionReady
                && inputMode === 'normal'
                && behavior !== 'inline'
                && (behavior !== 'inline-double-paste' || conversion !== null)
                && isLargePlainTextPaste(pastedText);

            if (!shouldOfferLargePaste) {
                if (pastedText.includes('@')) {
                    markFileMentionPasteSuppression();
                }
                return;
            }

            // Must run synchronously — ComposerEditor does not consume paste.
            e.preventDefault();

            const pasteInline = () => {
                if (pastedText.includes('@')) {
                    markFileMentionPasteSuppression();
                }
                insertTextAtSelection(
                    pastedText,
                    getFileMentionInputSourceForInsertedText(pastedText),
                );
            };

            const attachAsFile = async (candidate: LargeTextPasteCandidate | null = null) => {
                // Read live attachment + composer state at action time — the ask
                // toast can outlive the paste while the user types or attaches more.
                const liveAttachedFiles = useInputStore.getState().attachedFiles;
                const filename = nextPastedContextFilename([
                    ...liveAttachedFiles.map((file) => file.filename),
                    ...pendingPastedAttachmentFilenamesRef.current,
                ]);
                const citationText = buildAttachmentCitationText([filename]);
                const editor = composerRef.current;
                const currentMessage = editor?.getValue() ?? messageRef.current;
                const selectionStart = editor?.getSelection().start ?? currentMessage.length;
                const selectionEnd = editor?.getSelection().end ?? currentMessage.length;
                const insertionText = withInlineInsertionBoundaries(
                    citationText,
                    currentMessage.slice(0, candidate?.from ?? selectionStart),
                    currentMessage.slice(candidate?.to ?? selectionEnd),
                );

                const file = createPastedContextFile(pastedText, filename);
                // Pending before the citation lands, so it shows as a chip at once.
                pendingPastedAttachmentFilenamesRef.current.add(filename);
                try {
                    if (!candidate) {
                        insertTextAtSelection(
                            insertionText,
                            getFileMentionInputSourceForInsertedText(insertionText),
                        );
                    }

                    if (candidate) {
                        await largeTextPasteGesture.convert(
                            candidate, async () => {
                                const accepted = await addAttachedFile(file);
                                if (!accepted && readLargeTextPasteSnapshot()?.scope === candidate.scope) {
                                    toast.error(t('chat.chatInput.toast.clipboardTextAttachFailed'));
                                }
                                return accepted;
                            }, readLargeTextPasteSnapshot,
                            (from, to, citation) => composerRef.current?.replaceRange(from, to, citation),
                            insertionText,
                        );
                    } else {
                        await addAttachedFile(file);
                    }
                } catch (error) {
                    console.error('Clipboard text attach failed', error);
                    toast.error(
                        error instanceof Error
                            ? error.message
                            : t('chat.chatInput.toast.clipboardTextAttachFailed'),
                    );
                } finally {
                    pendingPastedAttachmentFilenamesRef.current.delete(filename);
                }
            };

            if (conversion) {
                await attachAsFile(conversion);
                return;
            }

            if (behavior === 'attach') {
                await attachAsFile();
                return;
            }

            // A newer large paste replaces an unanswered choice.
            const offerId = beginLargeTextPasteOffer(largeTextPasteOfferIdRef.current);
            largeTextPasteOfferIdRef.current = offerId;

            const resolveLargePaste = (action: LargeTextPasteChoiceAction, explicitlyChosen: boolean, typedText?: string) => {
                const resolution = resolveLargeTextPasteOffer(
                    largeTextPasteOfferIdRef.current,
                    offerId,
                    { explicitlyChosen },
                );
                largeTextPasteOfferIdRef.current = resolution.nextOfferId;
                if (!resolution.accepted) {
                    return;
                }
                setLargeTextPasteOffer(null);
                if (action === 'attach') {
                    void attachAsFile();
                } else {
                    pasteInline();
                }
                if (typedText) {
                    insertTextAtSelection(typedText);
                }
                // Keep this in the tap's gesture: iOS won't raise the
                // keyboard when focus is restored after the attachment awaits.
                if (resolution.restoreFocus) {
                    if (composerRef.current) {
                        composerRef.current.focus({ preventScroll: isCapacitorApp() });
                    } else {
                        // The editor may have collapsed since the paste. The
                        // insertion above appends to its draft; expand mounts
                        // and focuses the editor with the platform's keyboard timing.
                        mobileShell.expand();
                    }
                }
            };

            setLargeTextPasteOffer({ id: offerId, resolve: resolveLargePaste });
            return;
        }

        if (!sessionReady) {
            if (pastedText.includes('@')) {
                markFileMentionPasteSuppression();
            }
            return;
        }

        e.preventDefault();
        await attachFilesWithCitation([...imageFiles, ...otherFiles], pastedText);
    }, [addAttachedFile, attachFilesWithCitation, currentSessionId, inputMode, largeTextPasteBehavior, largeTextPasteGesture, readLargeTextPasteSnapshot, markFileMentionPasteSuppression, message, mobileShell, newSessionDraftOpen, insertTextAtSelection, setMessage, t, updateAutocompleteState]);

    // Android commits an image through the IME instead of the page (see nativeImagePaste).
    React.useEffect(() => {
        setNativeImagePasteEnabled(mobileShell.focused);
    }, [mobileShell.focused]);

    // A composer unmounted while focused must not leave image commits enabled
    // for whatever field gets the keyboard next.
    React.useEffect(() => () => setNativeImagePasteEnabled(false), []);

    React.useEffect(() => subscribeToNativeImagePastes((paste) => {
        // Backstop for the window around the shell re-reading the declaration.
        if (!mobileShell.focused) return;
        if (!paste.ok) {
            toast.error(t('chat.chatInput.toast.clipboardAttachFailed'));
            return;
        }
        if (!currentSessionId && !newSessionDraftOpen) return;
        void attachFilesWithCitation([paste.file]);
    }), [attachFilesWithCitation, currentSessionId, mobileShell.focused, newSessionDraftOpen, t]);

    const handleFileSelect = useStableHandler((file: { name: string; path: string; relativePath?: string }) => {

        const cursorPosition = composerRef.current?.getSelection().start || 0;
        const textBeforeCursor = message.substring(0, cursorPosition);
        const lastAtSymbol = textBeforeCursor.lastIndexOf('@');

        const mentionPath = (file.relativePath && file.relativePath.trim().length > 0)
            ? file.relativePath.trim()
            : (toMentionPath(file.path) || file.name);

        confirmedMentionsRef.current.add(mentionPath);

        if (lastAtSymbol !== -1) {
            const newMessage =
                message.substring(0, lastAtSymbol) +
                `@${mentionPath} ` +
                message.substring(cursorPosition);
            setMessage(newMessage);
            const nextCursor = lastAtSymbol + mentionPath.length + 2;
            requestAnimationFrame(() => {
                if (composerRef.current) {
                    composerRef.current.setSelection(nextCursor);
                }
                updateAutocompleteState(newMessage, nextCursor);
            });
        } else if (composerRef.current) {
            const newMessage =
                message.substring(0, cursorPosition) +
                `@${mentionPath} ` +
                message.substring(cursorPosition);
            setMessage(newMessage);
            const nextCursor = cursorPosition + mentionPath.length + 2;
            requestAnimationFrame(() => {
                if (composerRef.current) {
                    composerRef.current.setSelection(nextCursor);
                }
                updateAutocompleteState(newMessage, nextCursor);
            });
        }

        closeAutocomplete();

        composerRef.current?.focus();
    });

    const handleAgentSelect = useStableHandler((agentName: string) => {
        const textarea = composerRef.current;
        const cursorPosition = textarea?.getSelection().start ?? message.length;
        const textBeforeCursor = message.substring(0, cursorPosition);
        const lastAtSymbol = textBeforeCursor.lastIndexOf('@');

        if (lastAtSymbol !== -1) {
            const newMessage =
                message.substring(0, lastAtSymbol) +
                `@${agentName} ` +
                message.substring(cursorPosition);
            setMessage(newMessage);

            const nextCursor = lastAtSymbol + agentName.length + 2;
            requestAnimationFrame(() => {
                if (composerRef.current) {
                    composerRef.current.setSelection(nextCursor);
                }
                updateAutocompleteState(newMessage, nextCursor);
            });
        } else if (composerRef.current) {
            const newMessage =
                message.substring(0, cursorPosition) +
                `@${agentName} ` +
                message.substring(cursorPosition);
            setMessage(newMessage);

            const nextCursor = cursorPosition + agentName.length + 2;
            requestAnimationFrame(() => {
                if (composerRef.current) {
                    composerRef.current.setSelection(nextCursor);
                }
                updateAutocompleteState(newMessage, nextCursor);
            });
        }

        closeAutocomplete();

        composerRef.current?.focus();
    });

    const handleSkillSelect = useStableHandler((skillName: string) => {
        const textarea = composerRef.current;
        const cursorPosition = textarea?.getSelection().start ?? message.length;
        const textBeforeCursor = message.substring(0, cursorPosition);
        const lastDollarSymbol = textBeforeCursor.lastIndexOf('$');

        if (lastDollarSymbol !== -1) {
            const newMessage =
                message.substring(0, lastDollarSymbol) +
                `$${skillName} ` +
                message.substring(cursorPosition);
            setMessage(newMessage);

            const nextCursor = lastDollarSymbol + skillName.length + 2;
            requestAnimationFrame(() => {
                if (composerRef.current) {
                    composerRef.current.setSelection(nextCursor);
                }
                updateAutocompleteState(newMessage, nextCursor);
            });
        }

        closeAutocomplete();

        composerRef.current?.focus();
    });

    const handleSnippetSelect = useStableHandler((_snippet: unknown, trigger: string) => {
        const textarea = composerRef.current;
        const cursorPosition = textarea?.getSelection().start ?? message.length;
        const textBeforeCursor = message.substring(0, cursorPosition);
        const lastHashSymbol = textBeforeCursor.lastIndexOf('#');
        const startIndex = lastHashSymbol !== -1 ? lastHashSymbol : cursorPosition;
        const newMessage = `${message.substring(0, startIndex)}#${trigger} ${message.substring(cursorPosition)}`;
        setMessage(newMessage);
        const nextCursor = startIndex + trigger.length + 2;
        requestAnimationFrame(() => {
            if (composerRef.current) {
                composerRef.current.setSelection(nextCursor);
            }
            updateAutocompleteState(newMessage, nextCursor);
        });
        closeAutocomplete();
        composerRef.current?.focus();
    });

    const handleCommandSelect = useStableHandler((command: CommandInfo) => {
        if (command.name === 'btw' && currentSessionId) {
            closeAutocomplete();
            void handleSubmitRef.current({ presetText: '/btw' });
            return;
        }
        setMessage(`/${command.name} `);

        closeAutocomplete();

        const refocus = () => {
            if (composerRef.current) {
                try {
                    composerRef.current.focus({ preventScroll: true });
                } catch {
                    composerRef.current.focus();
                }
                composerRef.current.setSelection(composerRef.current.getValue().length, composerRef.current.getValue().length);
            }
        };

        requestAnimationFrame(() => {
            refocus();
            requestAnimationFrame(refocus);
        });
        setTimeout(refocus, 60);
    });

    React.useEffect(() => {
        if (!active || !currentSessionId || isMobile) return;
        // Focusing forces layout. Right after a session switch the layout is
        // dirty from the whole timeline mounting, so the focus call would pay
        // for that layout inside the commit; a frame later it is nearly free.
        const frame = window.requestAnimationFrame(() => {
            // A chat pinned in the side panel opens on its own time, often
            // while the user already types in the main chat; focusing then
            // would pull the keystrokes into the panel. It takes focus only
            // when the user is already working inside its column (e.g. opened
            // a subtask from there).
            if (columnPinned && !composerFormRef.current?.closest('[data-chat-column]')?.contains(document.activeElement)) return;
            composerRef.current?.focus();
        });
        return () => window.cancelAnimationFrame(frame);
    }, [active, columnPinned, currentSessionId, isMobile]);

    React.useEffect(() => {
        if (!isMobile) {
            setMobileControlsPanel(null);
        }
    }, [isMobile]);

    // A prompt armed for the session this composer leaves goes with it. Only
    // that one: another chat open beside this one arms prompts of its own.
    const abortPromptOwnerRef = React.useRef(currentSessionId);
    React.useEffect(() => {
        const previous = abortPromptOwnerRef.current;
        abortPromptOwnerRef.current = currentSessionId;
        if (previous !== currentSessionId && previous && useSessionUIStore.getState().abortPromptSessionId === previous) {
            clearAbortPrompt();
        }
    }, [currentSessionId, clearAbortPrompt]);

    React.useEffect(() => {
        canAcceptDropRef.current = Boolean(currentSessionId || newSessionDraftOpen);
    }, [currentSessionId, newSessionDraftOpen]);

    // Mention paths are shown relative to the project the chat searches.
    const toMentionPath = React.useCallback(
        (absolutePath: string) => toProjectRelativeMentionPath(absolutePath, chatSearchDirectory || ""),
        [chatSearchDirectory],
    );

    const addVSCodeDroppedUrisAsMentions = React.useCallback((uris: string[]) => {
        if (uris.length === 0) return;

        const paths = uris
            .map((entry) => normalizeDroppedPath(entry))
            .map((entry) => toMentionPath(entry))
            .map((entry) => entry.trim().replace(/^\.\//, ''))
            .filter((entry) => entry.length > 0);

        for (const p of paths) {
            confirmedMentionsRef.current.add(p);
        }

        const mentions = Array.from(new Set(paths.map((entry) => `@${entry}`)));

        if (mentions.length === 0) {
            return;
        }

        setPendingInputText(mentions.join(' '), 'append-inline', mailboxTarget);
        toast.success(t('chat.chatInput.toast.addedFileMentions', { count: mentions.length }));
    }, [mailboxTarget, setPendingInputText, t, toMentionPath]);

    const handleDragEnter = (e: React.DragEvent) => {
        if (!hasDraggedFiles(e.dataTransfer)) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        dragEnterCountRef.current++;
        const isInternal = e.dataTransfer.types?.includes('application/x-openchamber-file-path') ?? false;
        if (isInternal !== isInternalDrag) {
            setIsInternalDrag(isInternal);
        }
        if ((currentSessionId || newSessionDraftOpen) && !isDragging) {
            setIsDragging(true);
        }
    };

    const handleDragOver = (e: React.DragEvent) => {
        if (!hasDraggedFiles(e.dataTransfer)) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
        if ((currentSessionId || newSessionDraftOpen) && !isDragging) {
            setIsDragging(true);
        }
    };

    const handleDragLeave = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        dragEnterCountRef.current--;
        if (dragEnterCountRef.current <= 0) {
            dragEnterCountRef.current = 0;
            setIsDragging(false);
            setIsInternalDrag(false);
            clearDropTextSuppression();
        }
    };

    const handleDragEnd = () => {
        dragEnterCountRef.current = 0;
        setIsDragging(false);
        setIsInternalDrag(false);
        clearDropTextSuppression();
    };

    const handleDrop = async (e: React.DragEvent) => {
        dragEnterCountRef.current = 0;
        const draggedFiles = hasDraggedFiles(e.dataTransfer);
        if (!draggedFiles) {
            clearDropTextSuppression();
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);

        if (!currentSessionId && !newSessionDraftOpen) return;

        // Internal drag: file tree → chat input (relative path as @mention)
        const internalPath = e.dataTransfer.getData('application/x-openchamber-file-path');
        if (internalPath && internalPath !== '.') {
            confirmedMentionsRef.current.add(internalPath);
            const mention = `@${internalPath}`;
            const textarea = composerRef.current;
            const currentMessage = messageRef.current;
            if (textarea) {
                const { start: pos, end } = textarea.getSelection();
                const before = currentMessage.slice(0, pos);
                const after = currentMessage.slice(end);
                const needSpaceBefore = before.length > 0 && !/\s$/.test(before);
                const needSpaceAfter = after.length > 0 && !/^\s/.test(after);
                const insert = `${needSpaceBefore ? ' ' : ''}${mention}${needSpaceAfter ? ' ' : ''}`;
                // Insert through the editor rather than setMessage: an editor
                // dispatch places the caret right after the mention, while the
                // external-rewrite path would send it to the end of the
                // message and pin the scroll to the bottom.
                textarea.replaceRange(pos, end, insert);
                cursorPosRef.current = pos + insert.length;
                textarea.focus();
            } else {
                setMessage((prev) => appendInlineText(prev, mention));
            }
            clearDropTextSuppression();
            return;
        }

        const files = collectDroppedFiles(e.dataTransfer);

        if (files.length === 0 && isVSCodeRuntime()) {
            const droppedUris = collectDroppedFileUris(e.dataTransfer);
            if (droppedUris.length > 0) {
                pendingDroppedAbsolutePathsRef.current = droppedUris
                    .map((entry) => normalizeDroppedPath(entry))
                    .map((entry) => entry.trim())
                    .filter((entry) => entry.length > 0);
                addVSCodeDroppedUrisAsMentions(droppedUris);
            } else {
                clearDropTextSuppression();
            }
            return;
        }

        if (files.length > 0) {
            await attachFilesWithCitation(files);
        }
        clearDropTextSuppression();
    };

    const handleDropCapture = (e: React.DragEvent) => {
        if (!hasDraggedFiles(e.dataTransfer)) {
            return;
        }
        // Prevent native textarea drop text insertion for all runtimes
        e.preventDefault();
        if (isVSCodeRuntime()) {
            suppressNextFileDropTextInsertRef.current = true;
            scheduleDropTextSuppressionExpiry();
        }
    };

    const fileInputRef = React.useRef<HTMLInputElement>(null);

    const attachFiles = React.useCallback(async (files: FileList | File[]) => {
        const attachmentDraftKey = useInputStore.getState().attachmentDraftKey;
        const list = Array.isArray(files) ? files : Array.from(files);
        let attached = false;

        for (const file of list) {
            try {
                attached = (await addAttachedFile(file)) || attached;
            } catch (error) {
                console.error('File attach failed', error);
            }
            if (useInputStore.getState().attachmentDraftKey !== attachmentDraftKey) return;
        }
        if (list.length > 0 && !attached) {
            toast.error(t('chat.chatInput.toast.attachFileFailed'));
        }
    }, [addAttachedFile, t]);

    const handleVSCodePickFiles = React.useCallback(async () => {
        try {
            const data = (await vscodeApi?.pickFiles?.({ extensions: ACCEPTED_ATTACHMENT_EXTENSIONS })) as {
                files?: Array<{ name: string; mimeType?: string; dataUrl?: string }>;
                skipped?: Array<{ name?: string; reason?: string }>;
            } | undefined;
            const picked = Array.isArray(data?.files) ? data.files : [];
            const skipped = Array.isArray(data?.skipped) ? data.skipped : [];

            if (skipped.length > 0) {
                const summary = skipped
                    .map((s: { name?: string; reason?: string }) => `${s?.name || 'file'}: ${s?.reason || 'skipped'}`)
                    .join('\n');
                toast.error(t('chat.chatInput.toast.someFilesSkipped', { summary }));
            }

            const asFiles = picked
                .map((file: { name: string; mimeType?: string; dataUrl?: string }) => {
                    if (!file?.dataUrl) return null;
                    try {
                        const [meta, base64] = file.dataUrl.split(',');
                        const mime = file.mimeType || (meta?.match(/data:(.*);base64/)?.[1] || 'application/octet-stream');
                        if (!base64) return null;
                        const binary = atob(base64);
                        const bytes = new Uint8Array(binary.length);
                        for (let i = 0; i < binary.length; i++) {
                            bytes[i] = binary.charCodeAt(i);
                        }
                        const blob = new Blob([bytes], { type: mime });
                        return new File([blob], file.name || 'file', { type: mime });
                    } catch (err) {
                        console.error('Failed to decode VS Code picked file', err);
                        return null;
                    }
                })
                .filter(Boolean) as File[];

            if (asFiles.length > 0) {
                await attachFiles(asFiles);
            }
        } catch (error) {
            console.error('VS Code file pick failed', error);
            toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.vscodePickFailed'));
        }
    }, [attachFiles, t, vscodeApi]);

    const handlePickLocalFiles = React.useCallback(() => {
        if (isVSCodeRuntime()) {
            void handleVSCodePickFiles();
            return;
        }
        fileInputRef.current?.click();
    }, [handleVSCodePickFiles]);

    const handleLocalFileSelect = React.useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = event.target.files;
        if (!files) return;
        await attachFiles(files);
        event.target.value = '';
    }, [attachFiles]);

    const footerGapClass = 'gap-x-1.5 gap-y-0';
    const isVSCode = isVSCodeRuntime();
    const guestAttachItems = useGuestAttachItems();
    const openGuestAttach = React.useCallback((guestId: string) => {
        const item = guestAttachItems.find((guest) => guest.id === guestId);
        if (item?.mode === 'dialog') {
            setAttachDialogItem(null);
            setAttachDialogGuestId(guestId);
            return;
        }
        useUIStore.getState().openContextSurface(currentDirectory || '', pluginModeFromId(guestId));
    }, [currentDirectory, guestAttachItems]);
    // Clicking the guest chip reopens that guest with the chip as `ready.item`,
    // so it can show the item's details instead of its whole list. A panel
    // guest gets it through the rail hand-off store; a dialog guest as a prop.
    const reopenGuestItem = React.useCallback((reference: Extract<ComposerReference, { kind: 'guest' }>) => {
        const issue: AttachIssueRequest = {
            providerId: reference.providerId,
            id: reference.id,
            title: reference.title,
            url: reference.url,
            text: reference.contextText,
            kind: reference.thread,
        };
        if (reference.author) issue.author = reference.author;
        if (reference.head && reference.base) {
            issue.branches = { head: reference.head, base: reference.base };
        }
        if (reference.data !== undefined) issue.data = reference.data;
        // A chip can outlive the place it was attached in: the session may be
        // open on mobile or VS Code, where extensions never load, or the
        // extension may be paused or removed here. Say so instead of opening
        // an empty surface.
        const installed = useGuestsStore.getState().guests.find((entry) => entry.id === issue.providerId);
        if (!installed || !isGuestActive(installed)) {
            toast.info(t('chat.chatInput.toast.guestUnavailableHere'));
            return;
        }
        if (!installed.entry) {
            toast.info(t('chat.chatInput.toast.guestHasNoPanel'));
            return;
        }
        const guest = guestAttachItems.find((entry) => entry.id === issue.providerId);
        // Only an extension that declared a dialog gets one; everything else
        // (panel mode, no attach declared) opens the rail with the item.
        if (guest?.mode !== 'dialog') {
            useGuestItemStore.getState().setPendingItem(issue.providerId, issue);
            useUIStore.getState().openContextSurface(currentDirectory || '', pluginModeFromId(issue.providerId));
            return;
        }
        setAttachDialogItem(issue);
        setAttachDialogGuestId(issue.providerId);
    }, [currentDirectory, guestAttachItems, t]);
    const handleGuestAttach = React.useCallback((issue: AttachIssueRequest) => {
        const contextText = issue.text
            ?? `Attached ${issue.providerId} ${issue.id}: ${issue.title}\n${issue.url}`;
        const reference: ComposerReference = {
            kind: 'guest',
            providerId: issue.providerId,
            id: issue.id,
            title: issue.title,
            url: issue.url,
            contextText,
            thread: issue.kind === 'pull' ? 'pull' : 'issue',
            author: issue.author,
            head: issue.branches?.head,
            base: issue.branches?.base,
            data: issue.data,
        };
        setLinkedReferences((current) => withComposerReferences(current, [reference]));
        setAttachDialogGuestId(null);
        setAttachDialogItem(null);
        // A message or session action may have opened the guest in the
        // layout-level dialog; attaching from there closes it the same way.
        useGuestDialogStore.getState().close();
    }, []);
    React.useEffect(() => {
        if (!pendingGuestIssue || columnPinned) {
            return;
        }
        const issue = consumePendingGuestIssue();
        if (issue) {
            handleGuestAttach(issue);
        }
    }, [columnPinned, consumePendingGuestIssue, handleGuestAttach, pendingGuestIssue]);
    React.useEffect(() => {
        if (pendingComposerReferenceCount === 0 || columnPinned) return;
        const references = usePendingComposerReferences.getState().consume();
        if (references.length > 0) {
            setLinkedReferences((current) => withComposerReferences(current, references));
        }
    }, [columnPinned, pendingComposerReferenceCount]);
    const showLinearPicker = Boolean(runtimeLinear) && !isVSCode;
    const showDraftTargetSelectors = newSessionDraftOpen && !isVSCode;

    // Which project and directory a new session will target.
    const {
        projects: draftProjects,
        selectedDraftProject,
        draftProjectLabel,
        selectedDraftDirectory,
        selectedDraftBranchLabel,
        selectedDraftBranchIsKnown,
        selectedDraftDirectoryHasUncommittedChanges,
        projectRootBranchOption,
        worktreeBranchOptions,
        draftBranchItems,
        shouldShowDraftBranchSelector,
        handleDraftProjectChange,
        handleDraftDirectoryChange,
    } = useDraftTarget(showDraftTargetSelectors);

    // The one entry to an isolated space: while the feature's switch is on, for a project the
    // branch selector serves, never in VS Code (decision 16). The dialog keeps the project it
    // was opened for, whatever the draft picks after.
    const isolatedSpacesEnabled = useUIStore((state) => state.isolatedSpacesEnabled);
    const [newSpaceProject, setNewSpaceProject] = React.useState<{ id: string; path: string } | null>(null);
    const draftRequestId = newSessionDraft?.pendingWorktreeRequestId ?? null;
    const messageWaitsForSpace = React.useSyncExternalStore(
        subscribeDraftSendWaiting,
        () => isDraftSendWaiting(draftRequestId) && isSpaceCreationRequest(draftRequestId),
    );
    const handleCreateSpace = React.useMemo(() => {
        if (!isolatedSpacesEnabled || isVSCode || !selectedDraftProject || selectedDraftProject.kind === 'chat') return undefined;
        const project = { id: selectedDraftProject.id, path: selectedDraftProject.path };
        return () => setNewSpaceProject(project);
    }, [isVSCode, isolatedSpacesEnabled, selectedDraftProject]);

    // The full New Worktree dialog for the draft's project, so a named worktree, an existing
    // branch or a PR branch can be made where the sidebar has no project headers (Timeline).
    const [newWorktreeProject, setNewWorktreeProject] = React.useState<{ id: string; path: string } | null>(null);
    const handleCreateCustomWorktree = React.useMemo(() => {
        if (!selectedDraftProject || selectedDraftProject.kind === 'chat') return undefined;
        const project = { id: selectedDraftProject.id, path: selectedDraftProject.path };
        return () => setNewWorktreeProject(project);
    }, [selectedDraftProject]);
    const handleCustomWorktreeCreated = React.useCallback((worktreePath: string) => {
        const project = newWorktreeProject;
        if (!project) return;
        // Pin the draft to the new directory: until the worktree list refreshes,
        // the draft's validity check would otherwise reset it to the project root.
        const sessionStore = useSessionUIStore.getState();
        if (sessionStore.newSessionDraft.open) {
            sessionStore.overrideNewSessionDraftTarget({
                projectId: project.id,
                directoryOverride: worktreePath,
                pendingWorktreeRequestId: null,
                bootstrapPendingDirectory: worktreePath,
                preserveDirectoryOverride: true,
            });
        } else {
            sessionStore.openNewSessionDraft({
                selectedProjectId: project.id,
                directoryOverride: worktreePath,
                bootstrapPendingDirectory: worktreePath,
                preserveDirectoryOverride: true,
            });
        }
        useDirectoryStore.getState().setDirectory(worktreePath, { showOverlay: false });
    }, [newWorktreeProject]);

    const chatSurfaceMode = useChatSurfaceMode();
    const isMiniChatSurface = chatSurfaceMode === 'mini-chat';
    const showDesktopDraftPresentation = (newSessionDraftOpen || draftPresentationExiting)
        && !isDesktopExpanded
        && !isMobile
        && !isVSCode
        && !isMiniChatSurface;
    const draftPresentationClassName = cn(
        'transition-opacity duration-[120ms] ease-out motion-reduce:transition-none',
        draftPresentationExiting && 'pointer-events-none opacity-0',
    );

    React.useEffect(() => {
        if (!showDraftTargetSelectors || !selectedDraftProject || selectedDraftProject.kind === 'chat' || !selectedDraftDirectory) {
            return;
        }
        if (newSessionDraft?.pendingWorktreeRequestId || newSessionDraft?.bootstrapPendingDirectory || newSessionDraft?.preserveDirectoryOverride) {
            return;
        }
        const valid = draftBranchItems.some((option) => option.value === selectedDraftDirectory);
        if (valid) {
            return;
        }
        setNewSessionDraftTarget({
            projectId: selectedDraftProject.id,
            directoryOverride: selectedDraftProject.path,
        });
    }, [draftBranchItems, newSessionDraft?.bootstrapPendingDirectory, newSessionDraft?.pendingWorktreeRequestId, newSessionDraft?.preserveDirectoryOverride, selectedDraftDirectory, selectedDraftProject, setNewSessionDraftTarget, showDraftTargetSelectors]);


    // The record-and-send overlay holds the composer open until its submit
    // settles; the hold is released here (both handlers cover every exit).
    const dictationSendEndRef = React.useRef<(() => void) | null>(null);
    dictationSendEndRef.current = () => {
        dictationSendInFlightRef.current = false;
        mobileShell.holdDictationSend(false);
    };
    const handleDictationSendStart = React.useCallback(() => {
        // Only the mobile shell collapses on dictation end, and only its
        // dictation reports when it ends, which is what releases a hold
        // that never reaches a submit.
        if (isMobile) mobileShell.holdDictationSend(true);
    }, [isMobile, mobileShell]);
    // A record-and-send that never reaches a submit (failed or empty
    // transcript, cancel, a transcript kept for another draft) still releases
    // the hold once dictation ends. The transcript callback runs in the same
    // tick the status turns idle, so a real send is already in flight here.
    const { onDictationActiveChange } = mobileShell;
    const handleDictationActiveChange = React.useCallback((active: boolean) => {
        onDictationActiveChange(active);
        if (!active && !dictationSendInFlightRef.current) dictationSendEndRef.current?.();
    }, [onDictationActiveChange]);

    // Mobile comment mode: subscription, scope ownership and the attach/cancel
    // transitions live in the hook; ChatInput only renders from it.
    const mobileComment = useMobileCommentComposerMode({
        isMobile,
        runtimeKey: activeRuntimeKey,
        directory: inlineDraftDirectory,
        sessionKey: inlineDraftSessionKey,
        mobileShell,
    });
    const mobileCommentActive = mobileComment.active;
    attachMobileCommentRef.current = mobileComment.submit;


    const applyAssistSuggestion = React.useCallback(() => {
        if (!promptSuggestion || (composerRef.current?.getValue() ?? messageRef.current).length > 0) return;
        const editor = composerRef.current;
        if (editor) {
            editor.insertText(promptSuggestion);
            editor.focus();
        } else {
            messageRef.current = promptSuggestion;
            setMessage(promptSuggestion);
        }
        if (isMobile && !mobileComposerExpanded) {
            mobileShell.expand();
        }
    }, [isMobile, mobileComposerExpanded, mobileShell, promptSuggestion]);

    const suggestionRow = promptSuggestion ? (
        <PromptSuggestion
            text={promptSuggestion}
            onAccept={applyAssistSuggestion}
        />
    ) : null;

    // Linked references render as chips beside the attached files, inside the
    // composer box and inside the mobile pill.
    const linkedReferenceChips = !isVSCode && hasLinkedReferences ? (
        <div className="flex flex-wrap items-center gap-2 pt-2">
            {linkedReferences.map((reference) => {
                const key = composerReferenceKey(reference);
                const remove = () => setLinkedReferences((current) => withoutComposerReference(current, key));
                switch (reference.kind) {
                    case 'repository-issue':
                        return (
                            <LinkedReferenceRow
                                key={key}
                                numberLabel={`#${reference.number}`}
                                title={reference.title}
                                url={reference.url}
                                author={reference.author}
                                openInBrowserLabel={t('chat.chatInput.linked.issue.openInBrowserAria')}
                                removeLabel={t('chat.chatInput.linked.issue.removeAria')}
                                onReopenPicker={() => setReferencePicker({ source: 'github', kind: 'issue' })}
                                onRemove={remove}
                            />
                        );
                    case 'change-request':
                        return (
                            <LinkedReferenceRow
                                key={key}
                                numberLabel={reference.provider === 'github'
                                    ? t('chat.chatInput.linked.pr.number', { number: reference.number })
                                    : formatChangeRequestReference(reference.provider, reference.number)}
                                title={reference.title}
                                url={reference.url}
                                author={reference.author}
                                branches={reference.head && reference.base ? { head: reference.head, base: reference.base } : undefined}
                                openInBrowserLabel={t(changeRequestCopy('chat.chatInput.linked.pr.openInBrowserAria', reference.provider))}
                                removeLabel={t(changeRequestCopy('chat.chatInput.linked.pr.removeAria', reference.provider))}
                                onReopenPicker={() => setReferencePicker({ source: 'github', kind: 'pull' })}
                                onRemove={remove}
                            />
                        );
                    case 'linear-issue':
                        return (
                            <LinkedReferenceRow
                                key={key}
                                numberLabel={reference.identifier}
                                title={reference.title}
                                url={reference.url}
                                author={reference.author}
                                openInBrowserLabel={t('chat.chatInput.linked.linearIssue.openInBrowserAria')}
                                removeLabel={t('chat.chatInput.linked.linearIssue.removeAria')}
                                onReopenPicker={() => setReferencePicker({ source: 'linear' })}
                                onRemove={remove}
                            />
                        );
                    case 'guest':
                        return (
                            <LinkedReferenceRow
                                key={key}
                                numberLabel={reference.thread === 'pull'
                                    ? t('chat.chatInput.linked.guest.pr.number', { id: reference.id })
                                    : reference.id}
                                title={reference.title}
                                url={reference.url}
                                author={reference.author ? { login: reference.author } : undefined}
                                branches={reference.thread === 'pull' && reference.head && reference.base
                                    ? { head: reference.head, base: reference.base }
                                    : undefined}
                                openInBrowserLabel={t('chat.chatInput.linked.guest.openInBrowserAria', { id: reference.id })}
                                removeLabel={t('chat.chatInput.linked.guest.removeAria', { id: reference.id })}
                                onReopenPicker={() => reopenGuestItem(reference)}
                                onRemove={remove}
                            />
                        );
                }
            })}
        </div>
    ) : null;
    // Pending context (review comments, quotes, terminal selections) sits in
    // the attachment row like any attachment; its preview opens above the
    // composer, outside the clipping box.
    const contextChips = hasDrafts ? (
        <ComposerContextChips
            draftTarget={inlineDraftTarget}
            colors={currentTheme.colors}
            previewHost={contextPreviewHost}
        />
    ) : null;
    // Jev's "looks done" hint shares the composer's top row slot, above the
    // suggestion, so nothing below the input moves.
    const doneHintRow = !isBtwActive && !newSessionDraftOpen ? (
        <SessionDoneHintRow
            sessionId={currentSessionId}
            directory={currentSessionDirectoryForSync ?? currentDirectory}
        />
    ) : null;
    // The offer to look over what the last turn changed takes the same slot;
    // the server writes either it or the done hint, never both. Neither the
    // AI review nor the walkthrough is offered on a mobile layout.
    const openReviewDialog = React.useCallback(() => setReviewDialogOpen(true), []);
    const reviewHintRow = !isBtwActive && !newSessionDraftOpen && !isMobile ? (
        <SessionReviewHintRow
            sessionId={currentSessionId}
            directory={currentSessionDirectoryForSync ?? currentDirectory}
            onAIReview={openReviewDialog}
        />
    ) : null;
    // Commands the agent left running sit in the same slot, first, so a
    // forgotten dev server is visible without scrolling the chat. Keyed by
    // session so an expanded list collapses on a session switch.
    const backgroundShellsRow = !isBtwActive && !newSessionDraftOpen ? (
        <BackgroundShellsStrip
            key={currentSessionId ?? ''}
            sessionId={currentSessionId}
            directory={currentSessionDirectoryForSync ?? currentDirectory}
        />
    ) : null;
    // A new worktree still running its setup commands, first of all: until it
    // ends, a first prompt can wait with nothing else saying why.
    const worktreeSetupDirectory = currentSessionDirectoryForSync ?? currentDirectory ?? null;
    const worktreeSetupPending = useWorktreeBootstrapPending(isBtwActive ? null : worktreeSetupDirectory);
    const worktreeSetupRow = worktreeSetupPending
        ? <ComposerStatusStrip icon="loader-4" spin text={t('chat.worktreeSetup.running')} />
        : null;
    // A message sent while its space is still being made waits for it; the
    // composer is empty then, so this row is the only sign it was not lost.
    const spaceWaitRow = showDraftTargetSelectors && messageWaitsForSpace
        ? <ComposerStatusStrip icon="time" text={t('spaces.draft.queued')} />
        : null;
    const autoReviewRow = !isBtwActive && !newSessionDraftOpen ? <AutoReviewStrip /> : null;
    // The session's goal, then what is still running, then what waits for it.
    const goalRow = !isBtwActive ? (
        <SessionGoalRow
            sessionId={currentSessionId}
            directory={currentSessionDirectoryForSync ?? currentDirectory}
        />
    ) : null;
    // The queue and the staged revert dock render inside the composer column
    // (see QueuedMessageChips and RevertedMessageDock below), not in this stack.
    // Null exactly when the suggestion row alone would have been: the mobile
    // pill picks its shape from whether a top row exists.
    const composerTopRows = worktreeSetupRow || spaceWaitRow || goalRow || autoReviewRow || backgroundShellsRow || doneHintRow || reviewHintRow || suggestionRow ? (
        <>
            {worktreeSetupRow}
            {spaceWaitRow}
            {goalRow}
            {autoReviewRow}
            {backgroundShellsRow}
            {doneHintRow}
            {reviewHintRow}
            {suggestionRow}
        </>
    ) : null;
    const mobileModelAgentRow = isMobile && !isBtwActive ? (
        // px-3.5 lines the model logo and the agent label up with the attach
        // and mic icons above them; the buttons drop their own padding so the
        // row alone owns the inset.
        <div className="flex items-center justify-between gap-x-2 px-3.5 pb-2 pt-0.5">
            <MemoMobileModelButton onOpenModel={() => handleOpenMobilePanel('model')} className="min-w-0 px-0" />
            <MemoMobileAgentButton
                onOpenAgentPanel={handleOpenAgentPanel}
                onCycleAgent={handleCycleAgent}
                className="flex-shrink-0 px-0"
            />
        </div>
    ) : null;

    /** The dictation engine listens for this globally; the composer only asks. */
    const toggleDictation = React.useCallback(() => {
        window.dispatchEvent(new CustomEvent('openchamber:dictation-toggle'));
    }, []);

    const openMobileAttachSheet = React.useCallback(() => {
        // Same order as handleOpenMobilePanel: mark the sheet open BEFORE the
        // blur so the collapse watcher sees an overlay when the keyboard-close
        // lands. The trigger button blocks the tap's own focus transfer, so
        // the keyboard must be dismissed explicitly here.
        setMobileAttachMenuOpen(true);
        composerRef.current?.blur();
    }, []);


    // Mobile browsers pan the visual viewport instead of resizing the layout,
    // so the composer form is pinned to it explicitly.
    useMobileViewportPin({
        isMobile,
        isFullscreen: isMobileExpanded,
        isDraftScreen: newSessionDraftOpen,
        isFocused: mobileTextareaFocused,
        formRef: composerFormRef,
        editorRef: composerRef,
    });

    // The footer's objective counter shows only while a goal is armed; passing
    // the length otherwise would re-render the whole footer on every keystroke.
    const goalArmed = useSessionGoalArmStore((state) => state.armed);
    // Set by the footer's desktop dictation; the mobile overlay lives outside the box.
    const [desktopDictating, setDesktopDictating] = React.useState(false);
    const goalObjectiveLength = goalArmed ? message.length : 0;
    const waitingForOpenCode = useOpenCodeStartupStore((state) => state.waitingSends > 0);

    const footerPaddingClass = isMobile ? 'px-1.5 py-1.5' : (isVSCode ? 'px-1.5 py-1' : 'px-2.5 py-1.5');
    const buttonSizeClass = isMobile ? 'h-8 w-8' : (isVSCode ? 'h-5 w-5' : 'h-6 w-6');
    const sendIconSizeClass = isMobile ? 'h-4 w-4' : (isVSCode ? 'h-3.5 w-3.5' : 'h-4 w-4');
    const stopIconSizeClass = isMobile ? 'h-6 w-6' : (isVSCode ? 'h-4 w-4' : 'h-5 w-5');
    const iconSizeClass = isMobile ? 'h-[18px] w-[18px]' : (isVSCode ? 'h-4 w-4' : 'h-[18px] w-[18px]');

    const iconButtonBaseClass = 'flex cursor-pointer items-center justify-center text-foreground transition-none outline-none focus:outline-none flex-shrink-0 disabled:cursor-not-allowed';
    const footerIconButtonClass = cn(iconButtonBaseClass, buttonSizeClass);
    const permissionScopeSessionId = isBtwActive ? btwSessionId : currentSessionId ?? currentManagementSessionId;
    const safetyNetAvailable = useRoutingStore(selectSafetyNetAvailable);
    // A session not created yet (a draft, an unsent btw fork) shows its own
    // choice, else the mode the server will give it: the Settings default.
    // VS Code has no server to apply one.
    const defaultPermissionMode = useUIStore((state) => (isVSCode ? 'ask' : state.permissionDefaultMode));
    const permissionMode = usePermissionStore((state) => {
        if (isBtwActive && !btwSessionId) return pendingBtwPermissionMode ?? defaultPermissionMode;
        if (!permissionScopeSessionId) {
            return draftPermissionMode ?? defaultPermissionMode;
        }
        return state.getSessionMode(permissionScopeSessionId);
    });
    const shownPermissionMode = displayedPermissionMode(permissionMode, safetyNetAvailable);
    const isPermissionAutoAcceptInteractive = Boolean(permissionScopeSessionId || newSessionDraftOpen);

    const handlePermissionModeCycle = React.useCallback(() => {
        if (isBtwActive && !btwSessionId && currentSessionId) {
            useBtwStore.getState().setPanelState(currentSessionId, {
                pendingPermissionMode: nextPermissionMode(permissionMode, safetyNetAvailable),
            });
            return;
        }
        cyclePermissionMode({
            permissionScopeSessionId,
            newSessionDraftOpen,
            currentMode: permissionMode,
            safetyAvailable: safetyNetAvailable,
            setDraftPermissionMode,
            setSessionMode,
            onOpenSessionFirst: () => toast.error(t('chat.chatInput.toast.openSessionFirst')),
            onToggleFailed: () => toast.error(t('chat.chatInput.toast.togglePermissionAutoAcceptFailed')),
        });
    }, [
        newSessionDraftOpen,
        permissionMode,
        permissionScopeSessionId,
        safetyNetAvailable,
        isBtwActive,
        btwSessionId,
        currentSessionId,
        setDraftPermissionMode,
        setSessionMode,
        t,
    ]);

    useKeybind('toggle_permission_auto_accept', () => {
        // A native CLI approves every tool itself; there is nothing to toggle.
        if (!isPermissionAutoAcceptInteractive || isNativeTarget) return false;
        handlePermissionModeCycle();
    });

    // Acknowledging the abort record is what lets the working chip resume for
    // the next run; the old "Aborted" banner that used to accompany it is gone.
    React.useEffect(() => {
        const pendingAbort = Boolean(abortPromptSessionId) && abortPromptSessionId === currentSessionId;
        if (!prevWasAbortedRef.current && pendingAbort && currentSessionId) {
            acknowledgeSessionAbort(currentSessionId);
        }
        prevWasAbortedRef.current = pendingAbort;
    }, [abortPromptSessionId, acknowledgeSessionAbort, currentSessionId]);

    return (
        <>
        <form
            ref={composerFormRef}
            data-btw-composer={isBtwActive ? 'true' : undefined}
            onContextMenuCapture={() => largeTextPasteGesture.invalidate()}
            // Whichever composer the user works in holds the selected
            // attachment slot, so its paste, drop, picker and remove act on
            // its own files when a second chat is open beside it.
            onPointerDownCapture={claimAttachmentSlot}
            onFocusCapture={claimAttachmentSlot}
            onDragEnterCapture={claimAttachmentSlot}
            onKeyDownCapture={(event) => {
                if (!isBtwActive || event.key !== 'Escape' || isIMECompositionEvent(event) || hasOpenDropdown()) return;
                if (!(event.target instanceof Element) || !event.target.closest('[data-chat-input-footer]')) return;
                // Footer tooltips must not consume the only exit key for a pending BTW.
                event.preventDefault();
                event.stopPropagation();
                handleExitBtw();
            }}
            onSubmit={(e) => {
                e.preventDefault();
                // Comment mode owns the form: submit attaches the comment and
                // must never reach the send path.
                if (mobileCommentActive) {
                    attachMobileCommentRef.current();
                    return;
                }
                handlePrimaryAction();
            }}
            className={cn(
                "relative w-full pt-0 pb-4",
                isDesktopExpanded && 'flex h-full min-h-0 flex-col pt-4',
                isMobileExpanded && 'flex h-full min-h-0 flex-col pt-2',
                isMobile && 'bottom-safe-area oc-mobile-composer'
            )}
            style={isMobile && inputBarOffset > 0 ? { marginBottom: `${inputBarOffset}px` } : undefined}
        >
            {showDesktopDraftPresentation ? (
                <div className={cn('chat-input-column mb-7 text-center', draftPresentationClassName)}>
                    <h1 className="text-balance text-2xl font-normal tracking-tight text-foreground md:text-3xl">
                        {renderDraftTitle(
                            draftProjectLabel
                                ? t('chat.emptyState.draftTitleWithProject', { project: draftProjectLabel })
                                : t('chat.emptyState.draftTitle'),
                            draftProjectLabel,
                        )}
                    </h1>
                </div>
            ) : null}
            <div className={cn('chat-input-column relative overflow-visible', isComposerExpanded && 'flex flex-1 min-h-0 flex-col')}>
                {/* Comment mode shows only its own shell: the normal composer's
                    furniture (chips, banners, draft selectors) stays in state
                    and returns unchanged when the comment exits. */}
                {!mobileCommentActive ? (<>
                <QueuedMessageChips
                    target={messageQueueTarget}
                    hidden={isBtwPanelVisible || !currentSessionId || newSessionDraftOpen || hasPendingForm}
                    onEditMessage={handleQueuedMessageEdit}
                    onQueueMessage={handleQueuedMessageQueue}
                    onSendMessage={handleQueuedMessageSend}
                    sendingMessageId={sendingQueuedMessageId}
                />
                <RevertedMessageDock
                    sessionId={currentSessionId}
                    directory={currentSessionDirectoryForSync ?? currentDirectory}
                />
                {!isMobile && (showDraftTargetSelectors || draftPresentationExiting) && selectedDraftProject ? (
                    <div className={draftPresentationClassName}>
                        <DraftTargetSelectors
                            projects={draftProjects}
                            selectedProject={selectedDraftProject}
                            selectedDirectory={selectedDraftDirectory}
                            selectedBranchLabel={selectedDraftBranchLabel}
                            selectedBranchIsKnown={selectedDraftBranchIsKnown}
                            hasUncommittedChanges={selectedDraftDirectoryHasUncommittedChanges}
                            projectRootBranchOption={projectRootBranchOption}
                            worktreeBranchOptions={worktreeBranchOptions}
                            branchItems={draftBranchItems}
                            showBranchSelector={shouldShowDraftBranchSelector}
                            onProjectChange={handleDraftProjectChange}
                            onDirectoryChange={handleDraftDirectoryChange}
                            onCreateSpace={handleCreateSpace}
                            onCreateCustomWorktree={handleCreateCustomWorktree}
                            theme={currentTheme}
                        />
                    </div>
                ) : null}
                {isMobile && showDraftTargetSelectors && selectedDraftProject ? (
                    <MobileDraftTargetTriggers
                        selectedProject={selectedDraftProject}
                        selectedBranchLabel={selectedDraftBranchLabel}
                        showBranchSelector={shouldShowDraftBranchSelector}
                        theme={currentTheme}
                        onOpenPicker={setMobileDraftPicker}
                    />
                ) : null}
                </>) : null}
                <div
                    // Desktop: layout-transparent. Mobile: positioning host for
                    // the wrapper-level dictation overlay across pill/full states.
                    data-dictation-host="true"
                    // Mobile: the context-chip preview opens above this host.
                    ref={isMobile ? setContextPreviewHost : undefined}
                    className={cn(
                        !isMobile && 'contents',
                        isMobile && 'relative',
                        isMobileExpanded && 'flex min-h-0 flex-1 flex-col',
                    )}
                >
                {mobileCommentActive && mobileComment.draft.status === 'open' ? (
                    // Keyed by generation: a replaced open remounts the shell
                    // so its dictation callbacks can never target the
                    // previous quote.
                    <MobileCommentComposer
                        key={mobileComment.draft.generation}
                        draft={mobileComment.draft}
                        theme={currentTheme}
                        handlers={mobileComment.handlers}
                    />
                ) : isMobile && !mobileComposerExpanded && !isBtwActive ? (
                    <MobilePillComposer
                        followUpDelivery={followUpDelivery}
                        message={message}
                        sessionId={currentSessionId}
                        newSessionDraftOpen={newSessionDraftOpen}
                        hasContent={Boolean(hasContent)}
                        isVSCode={isVSCode}
                        canAbort={canAbort}
                        footerIconButtonClass={footerIconButtonClass}
                        iconSizeClass={iconSizeClass}
                        sendIconSizeClass={sendIconSizeClass}
                        stopIconSizeClass={stopIconSizeClass}
                        topRow={composerTopRows}
                        attachments={(
                            <div className="px-3 pt-1">
                                <AttachedFilesList draftIdentity={chatDraftIdentity} onShowPopup={handleShowAttachmentPreview} className="pt-2" />
                                {linkedReferenceChips}
                                {contextChips}
                            </div>
                        )}
                        bottomRow={mobileModelAgentRow}
                        onExpand={mobileShell.expand}
                        onPrimaryAction={handlePrimaryAction}
                        onQueueMessage={() => { void handleQueueMessage(); }}
                        onPickLocalFiles={handlePickLocalFiles}
                        onOpenGitHubPicker={openGitHubPicker}
                        repositoryProvider={repositoryProvider}
                        showLinearPicker={showLinearPicker}
                        onOpenLinearPicker={openLinearPicker}
                        onOpenAttachSheet={openMobileAttachSheet}
                        onStartDictation={toggleDictation}
                        onAbort={handleAbort}
                    />
                ) : (
                <>
                {/* The autocomplete popups anchor to this wrapper, not to the
                    box, which clips its contents. */}
                <div
                    ref={isMobile ? undefined : setContextPreviewHost}
                    className={cn('relative', isComposerExpanded && 'flex flex-1 min-h-0 flex-col')}
                >
                    {largeTextPasteOffer ? (
                        <LargeTextPasteChoice
                            key={largeTextPasteOffer.id}
                            takeFocus={!isMobile}
                            onChoose={(action, explicitlyChosen) => largeTextPasteOffer.resolve(action, explicitlyChosen)}
                            onTypeThrough={(text) => largeTextPasteOffer.resolve('inline', true, text)}
                        />
                    ) : null}
                    <ComposerAutocompletePopups
                        open={openAutocomplete}
                        query={autocompleteQuery}
                        overlayPosition={isDesktopExpanded ? autocompleteOverlayPosition : null}
                        commandRef={commandRef}
                        nativeBackend={nativeTargetBackend}
                        skillRef={skillRef}
                        snippetRef={snippetRef}
                        mentionRef={mentionRef}
                        onCommandSelect={handleCommandSelect}
                        onSkillSelect={handleSkillSelect}
                        onSnippetSelect={handleSnippetSelect}
                        onFileSelect={handleFileSelect}
                        onAgentSelect={handleAgentSelect}
                        onClose={closeAutocomplete}
                    />
                {/* The lift shadow lives on this wrapper, apart from the
                    box. */}
                <div
                    className={cn(
                        'flex flex-col',
                        isComposerExpanded && 'flex-1 min-h-0',
                        'shadow-[0_4px_16px_-4px_rgb(0_0_0_/_0.12)]',
                    )}
                    style={{ borderRadius: chatInputRadius }}
                >
                <div
                    className={cn(
                        "flex flex-col relative overflow-visible",
                        isComposerExpanded && 'flex-1 min-h-0',
                        "border border-border/80",
                        // Opaque: always on screen over the moving transcript
                        // (see .oc-surface-floating in design-system.css).
                        'oc-surface-floating',
                        isDragging && "ring-2 ring-primary ring-offset-2"
                    )}
                    style={{ borderRadius: chatInputRadius }}
                    ref={dropZoneRef}
                    // The mobile pill morph measures and animates this box.
                    data-composer-box={isMobile ? 'true' : undefined}
                    // The desktop dictation overlay is up: the box hides its
                    // other contents (see design-system.css).
                    data-dictating={desktopDictating && !isMobile && !isBtwActive ? 'true' : undefined}
                    onDropCapture={handleDropCapture}
                    onDragEnter={handleDragEnter}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    onDragEnd={handleDragEnd}
                >
                    {isDragging && (
                        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/90 rounded-xl">
                            <div className="text-center">
                                <div className="inline-flex justify-center">
                                    <button
                                        type="button"
                                        className={iconButtonBaseClass}
                                        onClick={() => handlePickLocalFiles()}
                                        title={t('chat.chatInput.actions.attachFiles')}
                                        aria-label={t('chat.chatInput.actions.attachFiles')}
                                    >
                                        <Icon name="attachment-2" className={cn(iconSizeClass, 'text-current')} />
                                    </button>
                                </div>
                                <p className="mt-2 typography-ui-label text-muted-foreground">
                                    {isInternalDrag ? t('chat.chatInput.drop.insertMention') : t('chat.chatInput.drop.attachFiles')}
                                </p>
                            </div>
                        </div>
                    )}

                    {/* Positioning context for the dictation overlay: covers the
                        text area + footer exactly. */}
                    <div className={cn('relative flex flex-col', isComposerExpanded && 'flex-1 min-h-0')} data-dictation-chain="true">
                    <div className={cn("overflow-hidden", isComposerExpanded && 'flex flex-1 min-h-0 flex-col')}>
                        {parallel.isActive ? <ParallelComposerStrip parallel={parallel} project={parallelProjectRef} /> : null}
                        {composerTopRows}
                        {isMobile && isBtwActive ? (
                            <div className="scrollbar-none relative z-10 flex items-center gap-x-2 overflow-x-auto px-3 pb-0.5 pt-1.5">
                                <ModelControls
                                    className="flex-1 min-w-0"
                                    sessionId={btwComposerSessionId}
                                    selection={effectiveBtwSelection}
                                />
                            </div>
                        ) : null}
                        <div className="flex items-center gap-1 px-3 pt-1 flex-wrap relative z-10">
                            <AttachedFilesList draftIdentity={chatDraftIdentity} onShowPopup={handleShowAttachmentPreview} className="pt-2" />
                            {!isBtwActive ? linkedReferenceChips : null}
                            {contextChips}
                            <AttachedVSCodeFileChips draftIdentity={chatDraftIdentity} onShowPopup={handleShowAttachmentPreview} />
                            {!isBtwActive ? <ActiveEditorFileSuggestion /> : null}
                        </div>
                        <div
                            ref={dictationHeightHostRef}
                            className={cn("relative overflow-hidden", isComposerExpanded && 'flex flex-1 min-h-0 flex-col')}
                            // The mobile pill morph moves this block from the
                            // pill's text line and unfurls it.
                            data-composer-morph-prompt={isMobile ? 'true' : undefined}
                            onDragEnter={handleDragEnter}
                            onDragOver={handleDragOver}
                            onDropCapture={handleDropCapture}
                            onDrop={handleDrop}
                            onDragEnd={handleDragEnd}
                            style={dictationContentHeight !== null && !isComposerExpanded
                                ? {
                                    minHeight: `${Math.min(
                                        dictationContentHeight,
                                        dictationHeightLimit ?? dictationContentHeight,
                                    )}px`,
                                }
                                : undefined}
                        >
                            <ComposerEditor
                                ref={composerRef}
                                viewStore={composerViewStore}
                                data-testid="chat-input"
                                value={message}
                                languageContext={languageContext}
                                onChange={handleComposerChange}
                                onKeyDown={(event) => {
                                    // Every interception branch calls
                                    // preventDefault, so the event itself
                                    // reports whether the composer consumed it.
                                    handleKeyDown(event);
                                    return event.defaultPrevented;
                                }}
                                onPaste={handlePaste}
                                onKeyUp={(event) => largeTextPasteGesture.keyUp(event)}
                                onSelectionChange={(selection) => {
                                    largeTextPasteGesture.invalidate();
                                    cursorPosRef.current = selection.start;
                                    updateAutocompleteOverlayPosition();
                                }}
                                onFocus={mobileShell.onEditorFocus}
                                onBlur={() => {
                                    largeTextPasteGesture.invalidate();
                                    mobileShell.onEditorBlur();
                                }}
                                placeholder={isBtwActive
                                    ? t('chat.btw.mainComposerPlaceholder')
                                    : currentSessionId || newSessionDraftOpen
                                        ? inputMode === 'shell'
                                            ? t('chat.chatInput.placeholder.shell')
                                            : isNativeTarget
                                                ? t(useCompactChatPlaceholder ? 'chat.chatInput.placeholder.nativeCliCompact' : 'chat.chatInput.placeholder.nativeCli')
                                                : t(useCompactChatPlaceholder ? 'chat.chatInput.placeholder.chatCompact' : 'chat.chatInput.placeholder.chat')
                                        : t('chat.chatInput.placeholder.selectSession')}
                                editable={Boolean(currentSessionId || newSessionDraftOpen)}
                                autoCorrect={composerAutoCorrect({ isMobile })}
                                autoCapitalize={isMobile ? 'sentences' : 'none'}
                                preserveDeferredEnterShift={!enterToSendConfigured || !isMobile}
                                spellCheck={isMobile || inputSpellcheckEnabled}
                                fillContainer={isComposerExpanded}
                                maxLines={isMobile ? MAX_MOBILE_COMPOSER_LINES : MAX_VISIBLE_COMPOSER_LINES}
                                boundSelector={isMobile ? '[data-composer-bound]' : undefined}
                                boundGapPx={MOBILE_COMPOSER_BOUND_GAP_PX}
                                className={cn(
                                    'min-h-[52px] px-3 relative z-10',
                                    isComposerExpanded
                                        ? cn('h-full min-h-0', isMobile ? 'py-2.5' : 'py-4')
                                        : isMobile
                                            ? 'pt-4 pb-2.5'
                                            : 'pt-4 pb-2',
                                    inputMode === 'shell' ? 'font-mono' : 'typography-markdown md:typography-ui-label',
                                )}
                            />
                        </div>
                    </div>
                    <ComposerFooter
                        followUpDelivery={followUpDelivery}
                        isMobile={isMobile}
                        isVSCode={isVSCode}
                        sessionId={currentSessionId}
                        directory={currentSessionDirectoryForSync ?? currentDirectory}
                        newSessionDraftOpen={newSessionDraftOpen}
                        messageLength={goalObjectiveLength}
                        radius={chatInputRadius}
                        footerPaddingClass={footerPaddingClass}
                        footerGapClass={footerGapClass}
                        footerIconButtonClass={footerIconButtonClass}
                        iconSizeClass={iconSizeClass}
                        sendIconSizeClass={sendIconSizeClass}
                        stopIconSizeClass={stopIconSizeClass}
                        canSend={canSend}
                        canAbort={canAbort}
                        hasContent={Boolean(hasContent)}
                        isExpandedInput={isExpandedInput}
                        permissionMode={shownPermissionMode}
                        isPermissionAutoAcceptInteractive={isPermissionAutoAcceptInteractive}
                        dictationActive={mobileShell.dictationActive}
                        onOpenSettings={onOpenSettings}
                        onPickLocalFiles={handlePickLocalFiles}
                        onOpenGitHubPicker={openGitHubPicker}
                        repositoryProvider={repositoryProvider}
                        showLinearPicker={showLinearPicker}
                        onOpenLinearPicker={openLinearPicker}
                        attachGuests={isMobile ? NO_ATTACH_GUESTS : guestAttachItems}
                        onOpenGuestAttach={openGuestAttach}
                        onOpenAttachSheet={openMobileAttachSheet}
                        onToggleExpandedInput={handleToggleExpandedInput}
                        onCyclePermissionMode={handlePermissionModeCycle}
                        onPrimaryAction={handlePrimaryAction}
                        onQueueMessage={handleQueueMessage}
                        onAbort={handleAbort}
                        onStartDictation={toggleDictation}
                        onDictationInsert={handleDictationInsert}
                        onDictationInsertAndSend={handleDictationInsertAndSend}
                        onDictationSendStart={handleDictationSendStart}
                        onDictationStart={markDictationStart}
                        onDictationContentHeightChange={handleDictationContentHeightChange}
                        onDictationActiveChange={setDesktopDictating}
                        isBtw={isBtwActive}
                        nativeTarget={isNativeTarget}
                        modelSessionId={btwComposerSessionId}
                        btwSelection={effectiveBtwSelection}
                        pinnedSelection={pinnedComposerSelection}
                        onRunInParallel={!isMobile && !isBtwActive && !columnPinned ? handleRunInParallel : undefined}
                        parallelRun={parallelRun}
                        waitingForOpenCode={waitingForOpenCode}
                    />
                    {mobileModelAgentRow}
                    </div>

                </div>
                </div>
                </div>
                </>
                )}
                {/* Wrapper-level dictation engine + overlay: stays mounted across
                    the pill ↔ composer swap so a recording started from the pill
                    survives the morph. Its absolute overlay covers whichever
                    shape the wrapper currently has. NOT mounted during comment
                    mode: the comment shell runs its own comment-scoped engine,
                    and two engines would both answer the global dictation
                    toggle (an in-flight recording is discarded by the swap —
                    its transcript must never reach the normal draft). */}
                {isMobile && !isBtwActive && !mobileCommentActive ? (
                    <MemoComposerDictation
                        radius={chatInputRadius}
                        isMobile={isMobile}
                        footerIconButtonClass={footerIconButtonClass}
                        footerPaddingClass={footerPaddingClass}
                        iconSizeClass={iconSizeClass}
                        sendIconSizeClass={sendIconSizeClass}
                        onInsert={handleDictationInsert}
                        onInsertAndSend={handleDictationInsertAndSend}
                        onSendStart={handleDictationSendStart}
                        onStart={markDictationStart}
                        onActiveChange={handleDictationActiveChange}
                        onContentHeightChange={handleDictationContentHeightChange}
                        renderTrigger={false}
                    />
                ) : null}
                </div>
                {/* Hidden host for the model/agent/variant bottom sheets. Kept
                    outside the pill conditional so an open panel survives (and
                    stays visible over) the collapsed composer. */}
                {isMobile && !isBtwActive ? (
                    <MemoModelControls
                        className="hidden"
                        mobilePanel={mobileControlsPanel}
                        onMobilePanelChange={setMobileControlsPanel}
                    />
                ) : null}
            </div>
            {showDesktopDraftPresentation ? (
                <DraftPresetChips
                    onSubmit={handlePresetChipSubmit}
                    className={cn('chat-input-column mt-4', draftPresentationClassName)}
                />
            ) : null}
            {/* One floating panel at a time: BTW, then a permission, then the form. */}
            <PermissionDock
                sessionId={currentSessionId}
                directory={currentSessionDirectoryForSync ?? currentDirectory ?? undefined}
                hidden={newSessionDraftOpen || isBtwActive || isBtwPanelVisible}
            />
            <FormDock
                sessionId={currentSessionId}
                directory={currentSessionDirectoryForSync ?? currentDirectory ?? undefined}
                hidden={newSessionDraftOpen || isBtwActive || isBtwPanelVisible || hasPendingPermission}
            />
            {currentSessionId ? <BtwPanel parentSessionId={currentSessionId} panel={btwPanel} onExit={handleExitBtw} /> : null}
        </form>

        <CodexCommandOutput
            value={codexCommandOutput}
            onClose={() => setCodexCommandOutput(null)}
            onCommand={(text) => {
                setCodexCommandOutput(null);
                setMessage((current) => current ? appendWithLineBreaks(current, text) : text);
                requestAnimationFrame(() => composerRef.current?.focus());
            }}
        />
        {referencePicker ? (
            <ReferencePickerDialog
                open
                onOpenChange={(open) => {
                    if (!open) setReferencePicker(null);
                }}
                source={referencePicker.source}
                purpose="attach"
                selection="multiple"
                directory={referencePickerDirectory}
                initialGitHubKind={referencePicker.source === 'github' ? referencePicker.kind : undefined}
                onConfirm={attachReferences}
            />
        ) : null}
        {attachDialogGuestId && !isMobile ? (
            <React.Suspense fallback={null}>
                <GuestAttachDialog
                    guestId={attachDialogGuestId}
                    item={attachDialogItem}
                    onOpenChange={(open) => {
                        if (!open) {
                            setAttachDialogGuestId(null);
                            setAttachDialogItem(null);
                        }
                    }}
                />
            </React.Suspense>
        ) : null}
        {reviewDialogMounted ? <ReviewFlowDialog
            open={reviewDialogOpen}
            onOpenChange={setReviewDialogOpen}
            projectDirectory={currentSessionDirectoryForSync ?? currentDirectory ?? null}
            submitting={reviewFlowSubmitting}
            onConfirm={handleStartReviewFlow}
        /> : null}
        {attachmentPreviewMounted ? (
            <React.Suspense fallback={null}>
                <ToolOutputDialog
                    popup={attachmentPreview}
                    onOpenChange={handleAttachmentPreviewOpenChange}
                    isMobile={isMobile}
                />
            </React.Suspense>
        ) : null}

        {/* Single always-mounted picker input. It must NOT live inside
            ComposerAttachmentControls: that component mounts once per composer
            variant (pill / expanded footer), so a shared ref got nulled when a
            variant unmounted, and a variant swap while the OS file picker was
            open detached the clicked input — its change event was silently
            lost and the picked files never attached. */}
        <AttachmentPickerInput ref={fileInputRef} onChange={handleLocalFileSelect} />

        {/* Mobile attachment sheet: replaces the dropdown (which stole focus and
            dismissed the keyboard) and leaves room for more actions later. */}
        {isMobile ? (
            <MobileOverlayPanel
                open={mobileAttachMenuOpen}
                title={t('chat.chatInput.actions.addAttachment')}
                onClose={() => setMobileAttachMenuOpen(false)}
            >
                <div className="flex flex-col px-3 pb-4 pt-1">
                    <button
                        type="button"
                        className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-3 text-start typography-ui-label hover:bg-[var(--interactive-hover)]"
                        onClick={() => {
                            // The native file/photo picker takes over next — restoring
                            // the keyboard in between would flash it open and shut.
                            mobileShell.cancelOverlayCloseRestore();
                            setMobileAttachMenuOpen(false);
                            requestAnimationFrame(handlePickLocalFiles);
                        }}
                    >
                        <Icon name="attachment-2" className="h-[18px] w-[18px] flex-shrink-0 text-muted-foreground" />
                        {t('chat.chatInput.actions.attachFiles')}
                    </button>
                    <button
                        type="button"
                        className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-3 text-start typography-ui-label hover:bg-[var(--interactive-hover)]"
                        onClick={() => {
                            // Hand-off to the picker: don't sync-restore the
                            // keyboard under the overlay that opens next frame.
                            mobileShell.skipNextOverlayCloseRestore();
                            setMobileAttachMenuOpen(false);
                            requestAnimationFrame(openGitHubPicker);
                        }}
                    >
                        <Icon name={repositoryProvider === 'gitlab' ? 'gitlab' : 'github'} className="h-[18px] w-[18px] flex-shrink-0 text-muted-foreground" />
                        {t(repositoryProvider === 'gitlab' ? 'chat.chatInput.actions.linkGitlab' : 'chat.chatInput.actions.linkGithub')}
                    </button>
                    {showLinearPicker ? (
                        <button
                            type="button"
                            className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-3 text-start typography-ui-label hover:bg-[var(--interactive-hover)]"
                            onClick={() => {
                                mobileShell.skipNextOverlayCloseRestore();
                                setMobileAttachMenuOpen(false);
                                requestAnimationFrame(openLinearPicker);
                            }}
                        >
                            <Icon name="linear" className="h-[18px] w-[18px] flex-shrink-0 text-muted-foreground" />
                            {t('chat.chatInput.actions.linkLinearIssue')}
                        </button>
                    ) : null}
                </div>
            </MobileOverlayPanel>
        ) : null}

        {/* Mobile draft target pickers: bottom sheets replacing the inline
            project/branch Selects (which desktop keeps). */}
        {isMobile && showDraftTargetSelectors && selectedDraftProject ? (
            <MobileDraftTargetSheets
                projects={draftProjects}
                selectedProject={selectedDraftProject}
                selectedDirectory={selectedDraftDirectory}
                selectedBranchLabel={selectedDraftBranchLabel}
                selectedBranchIsKnown={selectedDraftBranchIsKnown}
                hasUncommittedChanges={selectedDraftDirectoryHasUncommittedChanges}
                projectRootBranchOption={projectRootBranchOption}
                worktreeBranchOptions={worktreeBranchOptions}
                branchItems={draftBranchItems}
                showBranchSelector={shouldShowDraftBranchSelector}
                onProjectChange={handleDraftProjectChange}
                onDirectoryChange={handleDraftDirectoryChange}
                onCreateSpace={handleCreateSpace}
                onCreateCustomWorktree={handleCreateCustomWorktree}
                theme={currentTheme}
                openPicker={mobileDraftPicker}
                onOpenPickerChange={setMobileDraftPicker}
            />
        ) : null}
        {newSpaceProject ? (
            <NewSpaceDialog open onOpenChange={(open) => { if (!open) setNewSpaceProject(null); }} project={newSpaceProject} />
        ) : null}
        {newWorktreeProject ? (
            <NewWorktreeDialog
                open
                onOpenChange={(open) => { if (!open) setNewWorktreeProject(null); }}
                project={newWorktreeProject}
                onWorktreeCreated={handleCustomWorktreeCreated}
            />
        ) : null}
        </>
    );
};

ChatInputComponent.displayName = 'ChatInput';

export const ChatInput = React.memo(ChatInputComponent);
