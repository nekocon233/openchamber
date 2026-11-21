import { registerFsRoutes } from '../fs/routes.js';
import { registerEnvironmentRoutes } from '../environment/routes.js';
import { registerSessionWarmingRoutes } from '../session-warming/routes.js';
import { registerSessionTodosRoutes } from '../session-todos/routes.js';
import { registerGuestRoutes } from '../guests/routes.js';
import { registerDevServerRoutes } from '../dev-servers/routes.js';
import { registerProjectContextRoutes } from '../project-context/routes.js';
import { registerAgentMemoryRoutes } from '../agent-memory/routes.js';
import { registerSessionKnowledgeRoutes } from '../session-knowledge/routes.js';
import { registerMessageSearchRoutes } from '../message-search/routes.js';
import { registerPermissionAutoAcceptRoutes } from '../permission-auto-accept/runtime.js';
import { registerMessageQueueRoutes } from '../message-queue/runtime.js';
import { registerAutoReviewRoutes } from '../auto-review/runtime.js';
import { registerPrWatchRoutes } from '../pr-watch/runtime.js';
import { registerExtensionWaitsRoutes } from '../extension-waits/runtime.js';
import { registerWorkflowRoutes } from '../workflows/routes.js';
import { registerNativeAgentRoutes } from '../native-agents/routes.js';
import { registerRoutingRoutes } from '../routing/routes.js';
import { registerSettingsUtilityRoutes } from './core-routes.js';
import { registerProjectIconRoutes } from '../appearance/project-icon-routes.js';
import { registerScheduledTaskRoutes } from '../scheduled-tasks/routes.js';
import { fillScheduledWorktreeBridge } from '../scheduled-tasks/worktree-bridge.js';
import { registerOpenChamberSessionRoutes } from '../openchamber-sessions/routes.js';
import { registerOpenChamberControlRoutes } from '../openchamber-control/routes.js';
import { registerSkillRoutes } from '../opencode/skill-routes.js';
import { registerOpenCodeRoutes } from '../opencode/routes.js';
import type { createNotificationEmitterRuntime } from '../notifications/emitter-runtime.js';
import type { SseWriter } from '../notifications/contracts.js';
import type { GlobalMessageStreamHub } from '../event-stream/global-hub.js';
import type { createSettingsRuntime } from '../settings/settings-runtime.js';
import type { createSettingsHelpers } from '../settings/settings-helpers.js';
import type { createProjectDirectoryRuntime } from '../projects/project-directory-runtime.js';
import type { createOpenCodeNetworkRuntime } from '../opencode/network-runtime.js';
import type { createExtensionNotificationChannels } from '../notifications/extension-channels.js';
import type { createWorktreeBootstrapStore } from '../git/worktree-bootstrap-storage.js';
import type { createMergeFollowRuntime } from '../github/merge-follow.js';
import type { SidebarStateServerRuntime } from '../sidebar-state/server-runtime.js';
import type { FollowUpQueueServerRuntime } from '../follow-up-queue/server-runtime.js';
import type { NativeAgentsRuntime } from '../native-agents/runtime.js';

type FsOptions = Parameters<typeof registerFsRoutes>[1];

type IconOptions = Parameters<typeof registerProjectIconRoutes>[1];

type SessionOptions = Parameters<typeof registerOpenChamberSessionRoutes>[1];

type GuestOptions = Parameters<typeof registerGuestRoutes>[1];

type SettingsRuntime = ReturnType<typeof createSettingsRuntime>;

export interface ChangeRequestWorktreeInput<Source> {
  mode: 'existing';
  branchName: string;
  worktreeName: string;
  changeRequestSource: Source;
  startCommand?: string;
  createCommand?: string;
}

type ScheduledTaskOptions = Parameters<typeof registerScheduledTaskRoutes>[1];

type EventClient = ReturnType<ScheduledTaskOptions['getOpenChamberEventClients']> extends Set<infer Client> ? Client & SseWriter & { openchamberConnectionId?: string } : never;

export type RouteDependencies =
  & Pick<FsOptions, 'os' | 'path' | 'fsPromises' | 'spawn' | 'normalizeDirectoryPath' | 'buildAugmentedPath' | 'resolveGitBinaryForSpawn' | 'openchamberUserConfigRoot'>
  & Required<Pick<FsOptions, 'managedChatsRoot'>>
  & Pick<IconOptions, 'createFsSearchRuntime' | 'openchamberDataDir'>
  & Required<Pick<SessionOptions, 'validateDirectoryPath' | 'waitForOpenCodeReady' | 'emitSessionCreatedEvent'>>
  & Required<Pick<GuestOptions, 'onGuestDeactivated' | 'surfaceViewerHeaders' | 'openchamberVersion'>>
  & Pick<SettingsRuntime, 'readSettingsFromDisk' | 'readSettingsFromDiskMigrated' | 'persistSettings' | 'persistResolvedSettings'>
  & Pick<ReturnType<typeof createProjectDirectoryRuntime>, 'resolveProjectDirectory' | 'resolveOptionalProjectDirectory'>
  & Pick<Parameters<typeof registerSettingsUtilityRoutes>[1], 'readCustomThemesFromDisk' | 'saveImportedTheme' | 'deleteImportedTheme' | 'refreshOpenCodeAfterConfigChange'>
  & Pick<Parameters<typeof registerOpenCodeRoutes>[1], 'crypto' | 'getOpenCodeResolutionSnapshot' | 'getOpenCodeUpgradeCapability' | 'upgradeOpenCodeCli' | 'getOpenCodeCompatibility' | 'installOpenCodeV2'>
  & Pick<ScheduledTaskOptions, 'projectConfigRuntime' | 'scheduledTasksRuntime' | 'sanitizeProjects'>
  & Required<Pick<ScheduledTaskOptions, 'scheduledTaskService'>>
  & Pick<Parameters<typeof registerSkillRoutes>[1], 'sanitizeSkillCatalogs' | 'isUnsafeSkillRelativePath' | 'getOpenCodePort'>
  & {
    fs: typeof import('node:fs');
    formatSettingsResponse: ReturnType<typeof createSettingsHelpers>['formatSettingsResponse'];
    buildOpenCodeUrl: ReturnType<typeof createOpenCodeNetworkRuntime>['buildOpenCodeUrl'];
    getOpenCodeAuthHeaders: () => Record<string, string>;
    messageSearchRuntime: Parameters<typeof registerMessageSearchRoutes>[1]['messageSearchRuntime'];
    sessionWarmingRuntime: Parameters<typeof registerSessionWarmingRoutes>[1]['sessionWarmingRuntime'];
    sessionTodosRuntime: Parameters<typeof registerSessionTodosRoutes>[1]['sessionTodosRuntime'];
    onExtensionSessionEventsChanged?: () => void | Promise<void>;
    onExtensionWaitsChanged?: () => void | Promise<void>;
    extensionNotificationChannels?: ReturnType<typeof createExtensionNotificationChannels> | null;
    getOpenCodePluginDelivery?: NonNullable<NonNullable<GuestOptions['opencodePlugins']>['delivery']>;
    builtInExtensionsDir?: string | undefined;
    customThemesDir?: string | null;
    getOwnPorts: Parameters<typeof registerDevServerRoutes>[1]['getOwnPorts'];
    getActivePort?: () => number | null;
    getActiveHost?: () => string | null;
    devServerScanner: Parameters<typeof registerDevServerRoutes>[1]['scanner'];
    environmentStore: Parameters<typeof registerEnvironmentRoutes>[1]['store'];
    environmentRuntime: NonNullable<FsOptions['environmentRuntime']>;
    listConfiguredProjects: Parameters<typeof registerEnvironmentRoutes>[1]['listProjects'];
    projectContextRuntime: Parameters<typeof registerProjectContextRoutes>[1]['projectContextRuntime'];
    agentMemoryRuntime: Parameters<typeof registerAgentMemoryRoutes>[1]['agentMemoryRuntime'];
    isAgentMemoryEnabled: NonNullable<Parameters<typeof registerAgentMemoryRoutes>[1]['isAgentMemoryEnabled']>;
    sessionKnowledgeRuntime: Parameters<typeof registerSessionKnowledgeRoutes>[1]['sessionKnowledgeRuntime'];
    openChamberSessionService: NonNullable<SessionOptions['sessionService']>;
    openChamberControlService: Parameters<typeof registerOpenChamberControlRoutes>[1]['controlService'];
    getOpenChamberEventClients: () => Set<EventClient>;
    writeSseEvent: ReturnType<typeof createNotificationEmitterRuntime>['writeSseEvent'];
    permissionAutoAcceptRuntime: Parameters<typeof registerPermissionAutoAcceptRoutes>[1];
    sidebarStateRuntime: SidebarStateServerRuntime;
    followUpQueueRuntime: FollowUpQueueServerRuntime;
    isExternalOpenCode: () => boolean;
    isLocalManagementRequest: Parameters<typeof registerNativeAgentRoutes>[1]['isLocalManagementRequest'];
    nativeAgentsRuntime: NativeAgentsRuntime;
    worktreeBootstrapStore: ReturnType<typeof createWorktreeBootstrapStore>;
    scheduledWorktreeBridge: Parameters<typeof fillScheduledWorktreeBridge>[0];
    messageQueueRuntime: Parameters<typeof registerMessageQueueRoutes>[1];
    autoReviewRuntime: Parameters<typeof registerAutoReviewRoutes>[1];
    prWatchRuntime?: Parameters<typeof registerPrWatchRoutes>[1] | null;
    extensionWaitsRuntime?: Parameters<typeof registerExtensionWaitsRoutes>[1] | null;
    laterPagesRuntime?: Parameters<typeof registerOpenChamberControlRoutes>[1]['laterPages'];
    mergeFollowRuntime?: ReturnType<typeof createMergeFollowRuntime> | null;
    routingRuntime: Parameters<typeof registerRoutingRoutes>[1];
    globalEventHub: GlobalMessageStreamHub | null;
    workflowRuntime?: Parameters<typeof registerWorkflowRoutes>[1] | null;
  };
