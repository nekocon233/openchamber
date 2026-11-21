import { z } from 'zod';
import { agentCombinationsSchema } from '../native-agents/agent-configuration.js';
import type { PermissionMode } from '../permission-auto-accept/modes.js';
import type { JsonValue } from '../shared/json-values.js';
import type { createSettingsNormalizationRuntime } from './settings-normalization-runtime.js';
import { idleStopSchema } from '../spaces/idle-stop.js';
import { PROVIDER_LOGO_MIMES } from '../appearance/provider-logo-routes.js';

export type Normalization = ReturnType<typeof createSettingsNormalizationRuntime>;

const SIDEBAR_BUILTIN_SECTION_IDS = ['pages', 'chats', 'pinned', 'work', 'projects'];

const SIDEBAR_SECTIONS_STORED_MAX = 24 + SIDEBAR_BUILTIN_SECTION_IDS.length;

export const sidebarSectionIdSchema = z.string().trim().min(1).max(64);

const sidebarSectionNameSchema = z.string().trim().min(1).transform((value) => value.slice(0, 60));

const sidebarChips = (values: string[]) => z.array(z.unknown()).transform((entries) => (
  [...new Set(entries.flatMap((entry) => {
    const parsed = z.enum(values).safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  }))]
));

const sidebarIdList = (schema: z.ZodString) => z.array(z.unknown()).transform((entries) => (
  [...new Set(entries.flatMap((entry) => {
    const parsed = schema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  }))]
));

const sidebarIds = sidebarIdList(sidebarSectionIdSchema);

const sidebarProjectIds = sidebarIdList(z.string().trim().min(1).max(4096));

const sidebarSectionSchema = z.union([
  z.object({ kind: z.literal('builtin'), id: z.enum(SIDEBAR_BUILTIN_SECTION_IDS) }),
  z.object({
    kind: z.literal('custom'),
    id: sidebarSectionIdSchema,
    name: sidebarSectionNameSchema,
    grouping: z.enum(['time', 'project']).catch('time'),
    filter: z.object({
      states: sidebarChips(['running', 'needs-answer', 'unread', 'failed', 'looks-done']).catch([]),
      work: sidebarChips(['in-work', 'done']).catch([]),
      pins: sidebarIds.catch([]),
      kinds: sidebarChips(['session', 'worktree', 'space', 'run', 'scheduled']).catch([]),
      links: sidebarChips(['pr', 'issue', 'tracker', 'plan', 'goal']).catch([]),
      projectIds: sidebarProjectIds.catch([]),
      folders: sidebarIds.catch([]),
      activity: z.enum(['any', 'today', 'two-days', 'week', 'stalled']).catch('any'),
      text: z.union([z.string().transform((value) => [value]), z.array(z.unknown())]).transform((entries) => (
        [...new Set(entries.flatMap((entry) => {
          const phrase = z.string().trim().transform((value) => value.slice(0, 100)).safeParse(entry);
          return phrase.success && phrase.data ? [phrase.data] : [];
        }))].slice(0, 12)
      )).catch([]),
    }).partial().catch({}),
    claims: z.boolean().catch(false),
    hideWhenEmpty: z.boolean().catch(true),
  }),
]);

export type SidebarSection = z.infer<typeof sidebarSectionSchema>;

export const sanitizeSidebarSections = (entries: readonly JsonValue[] | readonly unknown[]) => {
  const result: SidebarSection[] = [];
  const seen = new Set();
  for (const entry of entries) {
    const parsed = sidebarSectionSchema.safeParse(entry);
    if (!parsed.success || seen.has(parsed.data.id) || result.length >= SIDEBAR_SECTIONS_STORED_MAX) continue;
    if (parsed.data.kind === 'custom' && SIDEBAR_BUILTIN_SECTION_IDS.includes(parsed.data.id)) continue;
    seen.add(parsed.data.id);
    result.push(parsed.data);
  }
  return result;
};

export const keepOmittedBuiltinSections = (stored: SidebarSection[], incoming: SidebarSection[]) => {
  const result = [...incoming];
  const has = (id: string) => result.some((entry) => entry.id === id);
  stored.forEach((entry, index) => {
    if (entry?.kind !== 'builtin' || has(entry.id)) return;
    const previous = stored.slice(0, index).reverse().find((candidate) => has(candidate?.id));
    const at = previous ? result.findIndex((candidate) => candidate.id === previous.id) + 1 : 0;
    result.splice(at, 0, entry);
  });
  return result;
};

export const sanitizeSidebarPinLists = (entries: readonly unknown[]) => {
  const result: { id: string; name: string }[] = [];
  const seen = new Set(['pinned']);
  for (const entry of entries) {
    const parsed = z.object({ id: sidebarSectionIdSchema, name: sidebarSectionNameSchema }).safeParse(entry);
    if (!parsed.success || seen.has(parsed.data.id) || result.length >= 24) continue;
    seen.add(parsed.data.id);
    result.push(parsed.data);
  }
  return result;
};

export const AGENT_TOOL_BOOLEAN_KEYS = [
  'agentControlToolEnabled', 'agentScheduleToolEnabled', 'agentMemoryToolEnabled', 'agentMemoryDreamingEnabled',
  'agentKnowledgeToolEnabled', 'agentWorkflowToolEnabled', 'agentWorkflowAutoApprove', 'agentNotifyToolEnabled',
  'agentRenderToolEnabled', 'agentImageToolEnabled', 'agentSecretToolEnabled', 'agentUsageToolEnabled', 'agentTerminalToolEnabled',
] as const;

export const customProviderIconsSchema = z.record(
  z.string().trim().min(1).max(128),
  z.enum(['server', 'cloud', 'database', 'terminal', 'code', 'ai']),
);

export const customProviderLogosSchema = z.record(
  z.string().trim().min(1).max(128),
  z.object({
    mime: z.enum(PROVIDER_LOGO_MIMES),
    updatedAt: z.number().int().positive(),
  }),
);

type BooleanSettingsKey =
  | 'showExpandedBashTools' | 'showExpandedEditTools' | 'conciseTranscript' | 'transcriptFileChangesOnly'
  | 'useSystemTheme' | 'workStatusPanelEnabled' | 'workStatusHiddenSectionsExplicit' | 'workStatusSectionOrderExplicit'
  | 'desktopLanAccessEnabled' | 'desktopKeepAwakeEnabled' | 'desktopMinimizeToTrayEnabled' | 'desktopMacMenuBarEnabled'
  | 'desktopLinuxNativeFrame' | 'messageSearchEnabled' | 'messageSearchReasoningEnabled'
  | 'sidebarKeepWorkInPlace' | 'sidebarKeepPinnedInPlace' | 'sidebarShowChatsSection' | 'sidebarShowWorkSection'
  | 'sidebarShowPinnedSection' | 'sidebarDetailedZoneRows' | 'sidebarWorktreeNameByBranch'
  | 'draftStartersVisible' | 'draftStartersCraftGoalAdded' | 'draftStartersScheduleTaskAdded'
  | 'showReasoningTraces' | 'streamingAutoFollowEnabled' | 'expandReasoningWhileStreaming'
  | 'codeBlockLineWrap' | 'tableCellWrap' | 'copyMessagesAsPlainText' | 'autoSaveEnabled' | 'fileEditorWrapLines'
  | 'confirmFileTreeMove' | 'layoutAnimations' | 'openLinksInBrowserPanel' | 'agentBrowserSharesLogins'
  | 'openTrackerLinksOnBoard' | 'diffWrapLines' | 'diffHideWhitespace' | 'allowPromptingSubagentSessions'
  | 'savePastedImagesAsFiles' | 'showOpenCodeRestartConfirm' | 'sessionTabsEnabled' | 'sessionTabsPerWorkspace'
  | 'terminalCloseOnExit' | 'terminalOpenOnProjectAction' | 'sessionRecapEnabled' | 'sessionSuggestionEnabled'
  | 'sessionWorkEnabled' | 'sessionReviewOfferEnabled' | 'sessionGoalEnabled' | 'sessionGoalDefaultBudgetEnabled'
  | 'collapsibleThinkingBlocks' | 'showTextJustificationActivity' | 'showDeletionDialog' | 'nativeNotificationsEnabled'
  | 'notifyOnSubtasks' | 'notifyOnCompletion' | 'notifyOnPullRequests' | 'notifyOnError' | 'notifyOnQuestion'
  | 'summarizeLastMessage' | 'autoDeleteEnabled' | 'sessionRetentionOnlyArchived' | 'sessionRetentionIncludeInWork'
  | 'mergedWorktreeCleanupEnabled' | 'worktreeArchiveOnDoneEnabled' | 'smallModelUseDefault' | 'autoCreateWorktree'
  | 'gitmojiEnabled' | 'defaultFileViewerPreview' | 'inputSpellcheckEnabled' | 'enterToSend' | 'enterToSendConfigured'
  | 'mobileReturnKeySends' | 'showOpenCodeUpdateNotifications' | 'agentWebToolEnabled' | 'isolatedSpacesEnabled'
  | 'showToolFileIcons' | 'showTurnChangedFiles' | 'collapsibleUserMessages' | 'stickyUserHeader'
  | 'promptNavigatorEnabled' | 'wideChatLayoutEnabled' | 'showSplitAssistantMessageActions' | 'directoryShowHidden'
  | 'filesViewShowGitignored' | 'reportUsage' | 'responseStyleEnabled' | 'dictationEnabled' | 'dictationAutoSend'
  | 'sttCorrectTranscript' | (typeof AGENT_TOOL_BOOLEAN_KEYS)[number];

type StringSettingsKey =
  | 'themeId' | 'locale' | 'lightThemeId' | 'darkThemeId' | 'splashBgLight' | 'splashFgLight' | 'splashBgDark'
  | 'splashFgDark' | 'lastDirectory' | 'homeDirectory' | 'opencodeBinary' | 'desktopUiPassword' | 'activeProjectId'
  | 'uiFont' | 'monoFont' | 'customUiFont' | 'customMonoFont' | 'uiFontWeight' | 'githubClientId' | 'githubScopes'
  | 'gitlabClientId' | 'fileEditorVimMappings' | 'tunnelProvider' | 'tunnelMode' | 'lastSelectedModel'
  | 'pwaAppName' | 'pwaOrientation' | 'mobileKeyboardMode' | 'browserProvider' | 'agentMemoryDreamingModel'
  | 'agentMemoryDreamingVariant' | 'agentImageModel' | 'isolatedSpacesSshHost' | 'openCodeUpdateToastDismissedVersion'
  | 'terminalShell' | 'openInAppId' | 'globalBehaviorPrompt' | 'responseStylePreset' | 'responseStyleCustomInstructions'
  | 'sttServerUrl' | 'sttModel' | 'sttEndpointPath' | 'sttLocalModel' | 'sttLanguage' | 'sidebarProjectDisplayMode'
  | 'sidebarViewMode' | 'sidebarListSessionGrouping' | 'sidebarGrouping' | 'sidebarProjectSortOrder'
  | 'selectionApprovalText';

type ClearableStringSettingsKey =
  | 'managedRemoteTunnelHostname' | 'managedRemoteTunnelSelectedPresetId' | 'defaultModel' | 'defaultVariant'
  | 'defaultAgent' | 'smallModelOverride' | 'smallModelVariant' | 'walkthroughModelOverride' | 'walkthroughModelVariant'
  | 'fallbackModel' | 'fallbackVariant' | 'defaultGitIdentityId' | 'zenModel';

type NumberSettingsKey =
  | 'inputHistoryLimit' | 'sidebarSessionBatchSize' | 'liveBrowserTabLimit' | 'sessionGoalMaxAutoTurns'
  | 'sessionGoalDefaultBudget' | 'summaryThreshold' | 'summaryLength' | 'maxLastMessageLength' | 'autoDeleteAfterDays'
  | 'tunnelSessionTtlMs' | 'tunnelHttpsPort' | 'fontSize' | 'chatFontSize' | 'terminalFontSize' | 'editorFontSize'
  | 'padding' | 'cornerRadius' | 'inputBarOffset';

type StringArraySettingsKey =
  | 'favoritePickerOrder' | 'agentCombinationOrder' | 'favoriteAgentCombinations'
  | 'workStatusHiddenSections' | 'workStatusSectionOrder' | 'sidebarHiddenSections' | 'securityScopedBookmarks'
  | 'pinnedDirectories' | 'providerOrder' | 'usageDropdownProviders' | 'accountSwitchProviders'
  | 'terminalLoginShells' | 'collapsedModelProviders' | 'recentAgents' | 'favoriteAgents';

export interface UsageModelGroups {
  customGroups?: { id: string; label: string; models: string[]; order: number }[];
  modelAssignments?: Record<string, string>;
  renamedGroups?: Record<string, string>;
}

export interface AppNameFields {
  pwaAppName?: string;
}

export interface DesktopSettingsFields {
  desktopLanAccessActive?: boolean;
  desktopLanAccessBlockedReason?: 'missing-password' | 'enterprise-mode' | null;
}

export type SanitizedSettings = Partial<Record<BooleanSettingsKey, boolean>>
  & Partial<Record<StringSettingsKey, string>>
  & Partial<Record<ClearableStringSettingsKey, string | undefined>>
  & Partial<Record<NumberSettingsKey, number>>
  & Partial<Record<StringArraySettingsKey, string[]>>
  & {
    themeVariant?: 'light' | 'dark';
    workspaceLayout?: 'classic' | 'editor';
    nativeAgentCombinations?: z.infer<typeof agentCombinationsSchema>;
    defaultAgentCombinationId?: string | undefined;
    typographySizes?: NonNullable<ReturnType<Normalization['sanitizeTypographySizesPartial']>>;
    frpcProxyType?: 'tcp' | 'http';
    frpcServerAddress?: string | null;
    frpcServerPort?: number | null;
    frpcRemotePort?: number | null;
    frpcPublicUrl?: string | null;
    frpcCustomDomain?: string | null;
    frpcPublicHostname?: string | null;
    inputHistoryScope?: 'session' | 'global';
    desktopUpdateChannel?: 'stable' | 'canary';
    serverUpdateChannel?: 'stable' | 'canary';
    desktopWindowControlsPosition?: 'left' | 'right';
    desktopWindowControlsStyle?: 'classic' | 'traffic-lights';
    permissionAutoAccept?: { sessions: Record<string, PermissionMode | boolean>; revision: number };
    permissionDefaultMode?: PermissionMode;
    projects?: NonNullable<ReturnType<Normalization['sanitizeProjects']>>;
    sidebarSections?: SidebarSection[];
    sidebarPinLists?: { id: string; name: string }[];
    draftStarters?: { type: 'command' | 'skill'; name: string }[];
    fileTreeSide?: 'left' | 'right';
    largeTextPasteBehavior?: 'ask' | 'attach' | 'inline' | 'inline-double-paste';
    fileEditorKeymap?: 'default' | 'vim';
    sessionGoalChecker?: 'classifier' | 'small-model';
    notificationMode?: 'always' | 'hidden-only';
    notificationTemplates?: object;
    usageDisplayMode?: 'usage' | 'remaining';
    sessionRetentionAction?: 'archive' | 'delete';
    tunnelBootstrapTtlMs?: number | null;
    managedLocalTunnelConfigPath?: string | null | undefined;
    managedRemoteTunnelToken?: string | null;
    managedRemoteTunnelPresets?: NonNullable<ReturnType<Normalization['normalizeManagedRemoteTunnelPresets']>>;
    managedRemoteTunnelPresetTokens?: NonNullable<ReturnType<Normalization['normalizeManagedRemoteTunnelPresetTokens']>>;
    followUpBehavior?: 'steer' | 'queue';
    isolatedSpacesIdleStop?: z.infer<typeof idleStopSchema>;
    timeFormatPreference?: 'auto' | '12h' | '24h';
    weekStartPreference?: 'auto' | 'sunday' | 'monday';
    chatRenderMode?: 'sorted' | 'live';
    messageStreamTransport?: 'auto' | 'ws' | 'sse';
    activityRenderMode?: 'collapsed' | 'summary';
    mermaidRenderingMode?: 'svg' | 'ascii';
    userMessageRenderingMode?: 'markdown' | 'plain';
    chatWidth?: 'default' | 'wider' | 'full';
    shortcutOverrides?: Record<string, string>;
    favoriteModels?: NonNullable<ReturnType<Normalization['sanitizeModelRefs']>>;
    recentModels?: NonNullable<ReturnType<Normalization['sanitizeModelRefs']>>;
    hiddenModels?: NonNullable<ReturnType<Normalization['sanitizeModelRefs']>>;
    customProviderIcons?: z.infer<typeof customProviderIconsSchema>;
    customProviderLogos?: z.infer<typeof customProviderLogosSchema>;
    recentEfforts?: Record<string, string[]>;
    lastUsedEfforts?: Record<string, string | null>;
    diffLayoutPreference?: 'dynamic' | 'inline' | 'side-by-side';
    gitChangesViewMode?: 'flat' | 'tree';
    toolJsonViewMode?: 'summary' | 'formatted' | 'raw';
    skillCatalogs?: NonNullable<ReturnType<Normalization['sanitizeSkillCatalogs']>>;
    usageSelectedModels?: Record<string, string[]>;
    usageCollapsedFamilies?: Record<string, string[]>;
    usageExpandedFamilies?: Record<string, string[]>;
    usageModelGroups?: Record<string, UsageModelGroups>;
    sttProvider?: 'local' | 'openai-compatible';
  };
