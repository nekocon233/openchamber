import type {
  ClaudeConnection, ClaudeConnectionWrite, CodexConnection, CodexConnectionWrite,
} from '@/lib/native-agents/connections';
import type { SessionMetadataRecord } from '@/lib/sessionReviewMetadata';
import type { WorktreeMetadata } from '@/types/worktree';
import type { ContextPartMetadata } from '@/lib/messages/contextParts';
import type { DesktopSettings } from '@/lib/settings/registry';
import type { Session } from '@/lib/opencode/model';
import type { NativeMemoryStatus, NativeMemoryConnection } from '@/lib/native-agents/memory-schemas';
import type { z } from 'zod';
import type {
  nativeBackgroundTaskSnapshotSchema,
  nativeCapabilitiesSchema,
  nativeCatalogSchema,
  nativeCommandListSchema,
  nativeCommandResultSchema,
  nativeMessagePageSchema,
  nativeQuestionSnapshotSchema,
  nativeRevertResultSchema,
  nativeSessionListSchema,
  nativeStatusSnapshotSchema,
} from '@/lib/native-agents/schemas';
import type { NativeBackend } from '@/lib/native-agents/ids';
import type { NativeAgentConfigurationWrite, NativeAgentModel } from '@/lib/native-agents/combinations';
import type { NativeStatistics, NativeStatisticsQuery } from '@/lib/native-agents/stats-schemas';
import type { DeepseekSetupStatus } from '@/lib/native-agents/deepseek';
import type { NativeChecklistSnapshot, NativePlanSnapshot, NativeTaskOutput, NativeTaskSnapshot, NativeTodosSnapshot } from '@/lib/native-agents/task-schemas';
import type { GitIdentityProfile, GitIdentitySummary } from './git-identity';
import type { GitPathUnavailableReason } from './git-path-diff';
import type { GitHubPendingReviewInput, GitHubPendingReviewState } from '../source-control/pendingReview';
import type { PushAPI } from './push';
import type {
  ChangeRequest,
  ChangeRequestContext,
  ChangeRequestRevision,
  ChangeRequestSubmitRequirement,
  ChangeRequestVoteLabel,
  CISummary,
  CiJobLogResult,
  CiRunStatusFilter,
  CiWorkflowRunDetail,
  CiWorkflowRunPage,
  Label,
  ChangeRequestStatus,
  CreateChangeRequestInput,
  Issue,
  IssueComment,
  MergeChangeRequestInput,
  PageResult,
  PullRequestStack,
  ProjectUpstream,
  ReadyChangeRequestInput,
  DraftChangeRequestInput,
  CommentInput,
  CommentUpdateInput,
  CommentDeleteInput,
  DiscussionCloseReason,
  DiscussionCommentInput,
  ChangeRequestReviewStateResult,
  ReviewChangeRequestInput,
  ReviewCommentDeleteInput,
  ReviewCommentInput,
  ReviewCommentUpdateInput,
  ReviewDiscardInput,
  SetDiscussionAnswerInput,
  SetDiscussionStateInput,
  SetStateInput,
  SetLabelsInput,
  SetReviewersInput,
  ThreadReplyInput,
  ThreadResolveInput,
  SourceControlAuthStatus,
  SourceControlCapabilities,
  SourceControlDeviceFlowComplete,
  SourceControlDeviceFlowStart,
  SourceControlIdentity,
  SourceControlEmptyMutationResult,
  SourceControlCreateMutationResult,
  SourceControlMergeMutationResult,
  SourceControlMutationReceipt,
  SourceControlReadyMutationResult,
  SourceControlDraftMutationResult,
  SourceControlReviewMutationResult,
  SourceControlStateMutationResult,
  SourceControlBindingRead,
  SourceControlProvider,
  SourceControlProviderBindingMutation,
  SourceControlReadContext,
  SourceControlRepositoryBindingResetIntent,
  SourceControlRepositoryContext,
  GitTransportBindingIntent,
  GitTransportBindingResult,
  GitTransportBindingRemovalIntent,
  GitTransportBindingRemovalResult,
  GitAuxiliaryBindingIntent,
  GitAuxiliaryBindingResult,
  UpdateChangeRequestInput,
  UpdateIssueInput,
  UpdateDiscussionInput,
} from '../source-control/types';
import type { SourceControlProviderDescriptor } from '../source-control/providers/descriptor';
import type { TrackerAPI } from '../trackers/types';

export type * from '../source-control/types';
export type * from '../trackers/types';
export type {
  GitIdentityProfile,
  GitIdentitySummary,
  GitIdentityTransport,
} from './git-identity';

type RuntimePlatform = 'web' | 'desktop' | 'vscode';

interface RuntimeDescriptor {
  platform: RuntimePlatform;

  isDesktop: boolean;

  isVSCode: boolean;

  label?: string;
}

interface Subscription {

  close: () => void;
}

export interface TerminalSession {
  sessionId: string;
  cols: number;
  rows: number;
  status: 'running' | 'exited' | 'error';
  mode?: 'interactive' | 'command';
  purpose?: TerminalSessionPurpose;
}

export type TerminalSessionPurpose =
  | { type: 'terminal' }
  | { type: 'project-action'; actionId: string; executionId: string };

export type TerminalShell = 'auto' | 'bash' | 'zsh' | 'sh' | 'fish' | 'pwsh' | 'powershell' | 'cmd' | 'dash' | 'ksh' | 'nu';

export interface TerminalShellOption {
  id: TerminalShell;
  name: string;
  supportsLogin: boolean;
}

export interface TerminalStreamEvent {
  type: 'snapshot' | 'data' | 'exit' | 'reconnecting';
  sequence?: number;
  data?: string;
  replayData?: string;
  cols?: number;
  rows?: number;
  status?: 'running' | 'exited' | 'error';
  exitCode?: number;
  signal?: number | null;
  attempt?: number;
  maxAttempts?: number;

  runtime?: 'node' | 'bun';
  ptyBackend?: string;
  mode?: 'interactive' | 'command';
  purpose?: TerminalSessionPurpose;
}

export interface TerminalError extends Error {
  code?: string;
}

interface BaseCreateTerminalOptions {
  cwd: string;
  sessionId?: string;
  cols?: number;
  rows?: number;
  themeMode?: 'light' | 'dark';
  terminalBackground?: string;
  terminalForeground?: string;
  shell?: TerminalShell;
  loginShell?: boolean;
  purpose?: TerminalSessionPurpose;
}

interface InteractiveCreateTerminalOptions extends BaseCreateTerminalOptions {
  mode?: 'interactive';
}

interface CommandCreateTerminalOptions extends BaseCreateTerminalOptions {
  mode: 'command';
  command: string;
}

export type CreateTerminalOptions = InteractiveCreateTerminalOptions | CommandCreateTerminalOptions;
export type RestartTerminalOptions = InteractiveCreateTerminalOptions;

export interface ResizeTerminalPayload {
  sessionId: string;
  cols: number;
  rows: number;
  directory?: string | null;
}

export interface TerminalHandlers {
  onEvent: (event: TerminalStreamEvent) => void;
  onError?: (error: TerminalError, fatal?: boolean) => void;
}

export interface ForceKillOptions {
  sessionId?: string;
  cwd?: string;
}

export interface TerminalServerSession {
  sessionId: string;
  cwd: string;
  status: 'running' | 'exited';
  createdAt: number | null;
  mode?: 'interactive' | 'command';
  purpose?: TerminalSessionPurpose;
}

export interface TerminalAPI {
  listShells?(): Promise<TerminalShellOption[]>;
  listSessions?(cwd: string): Promise<TerminalServerSession[]>;
  touchSessions?(sessionIds: string[], directory?: string | null): Promise<void>;
  createSession(options: CreateTerminalOptions): Promise<TerminalSession>;
  connect(sessionId: string, handlers: TerminalHandlers, directory?: string | null): Subscription;
  sendInput(sessionId: string, input: string, directory?: string | null): Promise<void>;
  resize(payload: ResizeTerminalPayload): Promise<void>;
  updateAppearance?(sessionId: string, appearance: Pick<CreateTerminalOptions, 'themeMode' | 'terminalBackground' | 'terminalForeground'>, directory?: string | null): Promise<void>;
  close(sessionId: string, directory?: string | null): Promise<void>;
  restartSession?(currentSessionId: string, options: RestartTerminalOptions): Promise<TerminalSession>;
  forceKill?(options: ForceKillOptions): Promise<void>;
}

interface GitStatusFile {
  path: string;
  index: string;
  working_dir: string;
  previousPath?: string;
}

export interface GitMergeInProgress {
  head: string;
  message: string;
}

export interface GitRebaseInProgress {
  headName: string;
  onto: string;
}

export interface GitRemoteComparison {
  remote: string;
  branch: string;
  ahead: number;
  behind: number;
}

export interface GitStatus {
  current: string;
  tracking: string | null;
  ahead: number;
  behind: number;
  aheadBase?: string | null;
  upstreamComparison?: GitRemoteComparison | null;
  files: GitStatusFile[];
  isClean: boolean;
  unborn?: boolean;
  diffStats?: {
    staged: Record<string, { insertions: number; deletions: number }>;
    working: Record<string, { insertions: number; deletions: number }>;
  };
  mergeInProgress?: GitMergeInProgress | null;
  rebaseInProgress?: GitRebaseInProgress | null;
  attentionReason?: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null;
}

export interface GitUnpushedBranchCounts {
  counts: Record<string, number>;
}

export interface GitDiffResponse {
  diff: string;
}

export interface GitSubmoduleState {
  headCommit: string | null;
  indexCommit: string | null;
  worktreeCommit: string | null;
  hasTrackedChanges: boolean;
  hasUntrackedFiles: boolean;
  hasConflict: boolean;
}

export interface GitPathDiffResponse extends GitDiffResponse {
  submodule: GitSubmoduleState | null;
}

export interface GetGitDiffOptions {
  path: string;
  staged?: boolean;
  contextLines?: number;
  previousPath?: string;
}

export interface GetGitDiffsOptions {
  paths: string[];
  staged?: boolean;
  contextLines?: number;
}

export type GitPathDiffBatchEntry =
  | { path: string; ok: true; diff: GitPathDiffResponse }
  | { path: string; ok: false; error: string; reason: GitPathUnavailableReason | null };

export interface GetGitRangeDiffOptions {
  base: string;
  head: string;
  path?: string;
  contextLines?: number;
  includeWorkingTree?: boolean;
  previousPath?: string;
}

export interface GetGitRangeFilesOptions {
  base: string;
  head: string;
  includeWorkingTree?: boolean;
}

export interface GitRangeFileEntry {
  path: string;
  status: string;
  previousPath?: string;
  revision?: string;
}

export interface GitBranchBaseResponse {
  base: string | null;
}

export interface GitFileDiffResponse {
  original: string;
  modified: string;
  path: string;
  isBinary?: boolean;
  submodule: GitSubmoduleState | null;
}

export interface GetGitFileDiffOptions {
  path: string;
  staged?: boolean;
  previousPath?: string;
}

export interface GitBranchDetails {
  current: boolean;
  name: string;
  commit: string;
  label: string;
  tracking?: string;
  ahead?: number;
  behind?: number;
}

export type GitBranchListOptions = { remote?: 'local' | 'live' };

export interface GitBranch {
  all: string[];
  current: string;
  branches: Record<string, GitBranchDetails>;
  defaultBranches?: Record<string, string>;
}

interface GitCommitSummary {
  changes: number;
  insertions: number;
  deletions: number;
}

export interface GitCommitResult {
  success: boolean;
  commit: string;
  branch: string;
  summary: GitCommitSummary;
}

export interface GitPushResult {
  success: boolean;
  pushed: Array<{
    local: string;
    remote: string;
  }>;
  repo: string;
  ref: unknown;
}

export interface GitPullResult {
  success: boolean;
  summary: GitCommitSummary;
  files: string[];
  insertions: number;
  deletions: number;
  conflict?: boolean;
  conflictFiles?: string[];
}

export interface GitPullOptions {
  remote?: string;
  branch?: string;
  rebase?: boolean;
}

export type GitNetworkTransportMode = 'managed' | 'system' | 'anonymous';

export interface GitNetworkRedactedEndpoint {
  displayUrl: string;
  fingerprint: string;
}

export interface GitNetworkRedactedDestination {
  displayName: string;
  fingerprint: string;
}

interface GitNetworkRuntimeIdentity {
  id: string;
  platform: RuntimePlatform;
  label?: string;
}

export type GitNetworkTransportActor =
  | {
      kind: 'provider';
      provider: string;
      instance: string;
      accountId: string;
      login?: string;
    }
  | {
      kind: 'ssh-key';
      fingerprint: string;
    };

export type GitNetworkTransport =
  | { mode: 'anonymous'; verification: { status: 'anonymous' } }
  | {
      mode: 'managed';
      verification: { status: 'verified'; method: 'credential' | 'git-identity' };
      actor?: GitNetworkTransportActor;
    }
  | {
      mode: 'system';
      verification: { status: 'unverified'; reason: 'system-credentials' };
    };

export interface GitNetworkRemoteTarget {
  name: string;
  endpoint: GitNetworkRedactedEndpoint;
}

export interface GitCheckoutHydrationRequirement {
  kind: 'submodule' | 'lfs';
  path: string;
  endpoint: GitNetworkRedactedEndpoint;
}

type ExistingRepositoryNetworkOperationRequest = {
  directory: string;
  repositoryId: string;
  bindingRevision: number;
  configRevision: string;
  remote: GitNetworkRemoteTarget;
  sourceRef: string;
  destinationRef: string;
  transportMode: GitNetworkTransportMode;
};

type GitNetworkSyncRemoteRequest = {
  remote: GitNetworkRemoteTarget;
  sourceRef: string;
  destinationRef: string;
  transportMode: GitNetworkTransportMode;
};

export type GitNetworkOperationRequest =
  | (ExistingRepositoryNetworkOperationRequest & {
      operation: 'push';
      forceWithLease?: { expectedRemoteSha: string };
      configureUpstream?: boolean;
      destinationSelectionId?: string;
      review?: GitPushReviewIntent;
    })
  | (ExistingRepositoryNetworkOperationRequest & { operation: 'fetch'; fetchScope?: 'ref' })
  | (Omit<ExistingRepositoryNetworkOperationRequest, 'sourceRef' | 'destinationRef'> & {
      operation: 'fetch';
      fetchScope: 'remote';
    })
  | (ExistingRepositoryNetworkOperationRequest & { operation: 'pull' })
  | {
      operation: 'delete-remote-branch';
      directory: string;
      repositoryId: string;
      bindingRevision: number;
      configRevision: string;
      remote: GitNetworkRemoteTarget;
      destinationRef: string;
      transportMode: GitNetworkTransportMode;
    }
  | {
      operation: 'checkout-hydration';
      directory: string;
      repositoryId: string;
      bindingRevision: number;
      configRevision: string;
      remote: GitNetworkRemoteTarget;
    }
  | {
      operation: 'sync';
      directory: string;
      repositoryId: string;
      bindingRevision: number;
      configRevision: string;
      fetch: GitNetworkSyncRemoteRequest;
      pull: { destinationRef: string };
      push: GitNetworkSyncRemoteRequest & {
        forceWithLease?: { expectedRemoteSha: string };
        destinationSelectionId?: string;
      };
    }
  | ({
      operation: 'clone';
      remoteUrl: string;
      destinationPath: string;
      gitIdentityId?: string;
      providerAccount?: SourceControlIdentity & { accountId: string };
      auxiliaryGrants?: Array<{
        kind: 'submodule' | 'lfs';
        endpoint: GitNetworkRedactedEndpoint;
      } & (
        | { transportMode: 'managed'; credentialId: string }
        | { transportMode: 'system'; unverifiedConfirmed: true; credentialId?: never }
        | { transportMode: 'anonymous'; credentialId?: never; unverifiedConfirmed?: never }
      )>;
    } & (
      | { transportMode: 'system'; unverifiedConfirmed: true; credentialAccount?: never; sshCredentialId?: never }
      | { transportMode: 'anonymous'; credentialAccount?: never; sshCredentialId?: never; unverifiedConfirmed?: never }
      | { transportMode: 'managed'; credentialAccount: SourceControlIdentity & { accountId: string }; sshCredentialId?: never; unverifiedConfirmed?: never }
      | { transportMode: 'managed'; sshCredentialId: string; credentialAccount?: never; unverifiedConfirmed?: never }
    ));

export type GitPushReviewIntent = {
  target: string;
  topic?: string;
  wip?: boolean;
  private?: boolean;
  hashtags?: string[];
};

export type GitManagedSshCredential = {
  credentialId: string;
  label: string;
  fingerprint: string;
  capability: { status: 'ready' } | { status: 'unavailable'; reason: 'unreadable' | 'encrypted-or-unverifiable' | 'fingerprint-mismatch' };
};

export type GitManagedSshCandidate =
  | {
      candidateId: string;
      label: string;
      fingerprint: string;
      capability: { status: 'ready' };
    }
  | {
      label: string;
      capability: { status: 'unavailable'; reason: 'unreadable' | 'encrypted-or-unverifiable' | 'insecure-permissions' };
    };

export type GitManagedSshIntent = { operation: 'inventory' }
  | { operation: 'discover'; passphrase?: string }
  | { operation: 'import'; candidateId: string; expectedFingerprint: string; confirmed: true; passphrase?: string };

export type GitManagedSshResult =
  | { status: 'available'; credentials: GitManagedSshCredential[] }
  | { status: 'discovered'; candidates: GitManagedSshCandidate[]; truncated: boolean }
  | { status: 'imported'; credentials: GitManagedSshCredential[]; selectedCredential: GitManagedSshCredential & { capability: { status: 'ready' } } }
  | { status: 'rejected'; reason: 'candidate-expired' | 'candidate-changed' | 'fingerprint-mismatch' | 'candidate-unavailable' | 'inventory-full' }
  | { status: 'unsupported'; reason: 'host-setup-required' };

export type GitNetworkOperationTarget =
  | {
      operation: 'push';
      repositoryId: string;
      bindingRevision: number;
      configRevision: string;
      remote: GitNetworkRemoteTarget;
      sourceRef: string;
      destinationRef: string;
      forceWithLease?: { expectedRemoteSha: string };
      configureUpstream?: boolean;
    }
  | {
      operation: 'fetch';
      fetchScope: 'remote';
      repositoryId: string;
      bindingRevision: number;
      configRevision: string;
      remote: GitNetworkRemoteTarget;
      force: boolean;
    }
  | {
      operation: 'fetch';
      fetchScope?: 'ref';
      repositoryId: string;
      bindingRevision: number;
      configRevision: string;
      remote: GitNetworkRemoteTarget;
      sourceRef: string;
      destinationRef: string;
    }
  | {
      operation: 'pull';
      repositoryId: string;
      bindingRevision: number;
      configRevision: string;
      remote: GitNetworkRemoteTarget;
      sourceRef: string;
      destinationRef: string;
    }
  | {
      operation: 'delete-remote-branch';
      repositoryId: string;
      bindingRevision: number;
      configRevision: string;
      remote: GitNetworkRemoteTarget;
      destinationRef: string;
    }
  | {
      operation: 'checkout-hydration';
      repositoryId: string;
      bindingRevision: number;
      configRevision: string;
      remote: GitNetworkRemoteTarget;
      requirements: GitCheckoutHydrationRequirement[];
    }
  | {
      operation: 'sync';
      repositoryId: string;
      bindingRevision: number;
      configRevision: string;
      fetch: GitNetworkRemoteTarget & { sourceRef: string; destinationRef: string };
      pull: { destinationRef: string };
      push: GitNetworkRemoteTarget & {
        sourceRef: string;
        destinationRef: string;
        forceWithLease?: { expectedRemoteSha: string };
      };
    }
  | {
      operation: 'clone';
      remote: GitNetworkRedactedEndpoint;
      destination: GitNetworkRedactedDestination;
    };

export type GitNetworkOperationStep =
  | 'validated'
  | 'authenticated'
  | 'transferred'
  | 'updated-local-repository'
  | 'checked-out'
  | 'cleaned-up';

export type GitNetworkSyncStepStatus = 'succeeded' | 'skipped' | 'conflicted' | 'failed' | 'cancelled';

export interface GitNetworkSyncStepResult {
  step: 'fetch' | 'pull' | 'push';
  status: GitNetworkSyncStepStatus;
  error?: GitNetworkOperationError;
}

export type GitNetworkOperationErrorCode =
  | 'INVALID_REQUEST'
  | 'NOT_FOUND'
  | 'STALE_REPOSITORY'
  | 'STALE_BINDING'
  | 'STALE_CONFIG'
  | 'REMOTE_CHANGED'
  | 'REMOTE_URL_USERINFO'
  | 'AUTHENTICATION_REQUIRED'
  | 'DESTINATION_SELECTION_REQUIRED'
  | 'CONTRIBUTOR_MANAGED_TRANSPORT_REQUIRED'
  | 'AUTHENTICATION_FAILED'
  | 'TRANSPORT_FAILED'
  | 'CONFLICT'
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'OUTCOME_UNKNOWN'
  | 'RUNTIME_UNSUPPORTED'
  | 'GIT_LFS_CLIENT_MISSING'
  | 'CHECKOUT_TOO_LARGE'
  | 'PATH_LENGTH_LIMIT'
  | 'BRANCH_NAME_CONFLICT'
  | 'UNKNOWN';

export interface GitNetworkOperationError<Code extends GitNetworkOperationErrorCode = GitNetworkOperationErrorCode> {
  code: Code;
  message: string;
}

export class GitNetworkOperationRequestError extends Error {
  readonly code: GitNetworkOperationErrorCode;
  readonly status: number;

  constructor(code: GitNetworkOperationErrorCode, message: string, status: number) {
    super(message);
    this.name = 'GitNetworkOperationRequestError';
    this.code = code;
    this.status = status;
  }
}

export type GitCheckoutHydrationStatus =
  | 'succeeded'
  | 'authorization-required'
  | 'invalid'
  | 'client-missing'
  | 'failed'
  | 'cancelled'
  | 'not-needed';

interface GitCheckoutHydrationItemResult {
  path: string;
  status: GitCheckoutHydrationStatus;
  endpoint?: GitNetworkRedactedEndpoint;
  error?: GitNetworkOperationError;
}

interface GitCheckoutLfsResult {
  path: string;
  status: GitCheckoutHydrationStatus;
  endpoint?: GitNetworkRedactedEndpoint;
  error?: GitNetworkOperationError;
}

export interface GitCheckoutHydrationResult {
  status: GitCheckoutHydrationStatus;
  submodules: GitCheckoutHydrationItemResult[];
  lfs: GitCheckoutLfsResult[];
}

type GitNetworkOperationBase = {
  operationId: string;
  runtimeIdentity: GitNetworkRuntimeIdentity;
  transport: GitNetworkTransport | { fetch: GitNetworkTransport; push: GitNetworkTransport };
  target: GitNetworkOperationTarget;
  completedSteps: GitNetworkOperationStep[];
  stepResults?: GitNetworkSyncStepResult[];
  hydration?: GitCheckoutHydrationResult;
};

export type GitNetworkOperationPlan = GitNetworkOperationBase & { state: 'planned' };

export type GitNetworkOperation =
  | GitNetworkOperationPlan
  | (GitNetworkOperationBase & { state: 'running' })
  | (GitNetworkOperationBase & { state: 'succeeded' })
  | (GitNetworkOperationBase & {
      state: 'partial';
      error: GitNetworkOperationError<
        | 'INVALID_REQUEST'
        | 'AUTHENTICATION_REQUIRED'
        | 'AUTHENTICATION_FAILED'
        | 'TRANSPORT_FAILED'
        | 'RUNTIME_UNSUPPORTED'
        | 'GIT_LFS_CLIENT_MISSING'
        | 'CHECKOUT_TOO_LARGE'
        | 'UNKNOWN'
      >;
    })
  | (GitNetworkOperationBase & {
      state: 'failed';
      error: GitNetworkOperationError<
        | 'INVALID_REQUEST'
        | 'AUTHENTICATION_REQUIRED'
        | 'AUTHENTICATION_FAILED'
        | 'TRANSPORT_FAILED'
        | 'RUNTIME_UNSUPPORTED'
        | 'GIT_LFS_CLIENT_MISSING'
        | 'CHECKOUT_TOO_LARGE'
        | 'UNKNOWN'
      >;
    })
  | (GitNetworkOperationBase & {
      state: 'cancelled';
      error: GitNetworkOperationError<'CANCELLED' | 'TIMEOUT'>;
    })
  | (GitNetworkOperationBase & {
      state: 'outcome-unknown';
      error: GitNetworkOperationError<'OUTCOME_UNKNOWN'>;
    })
  | (GitNetworkOperationBase & {
      state: 'conflicted';
      error: GitNetworkOperationError<
        'STALE_REPOSITORY' | 'STALE_BINDING' | 'STALE_CONFIG' | 'REMOTE_CHANGED' | 'CONFLICT'
      >;
    });

export interface GitStashEntry {
  ref: string;
  message: string;
  relativeTime: string;
  hash: string;
}

export interface GitRemote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface GitMergeResult {
  success: boolean;
  conflict?: boolean;
  conflictFiles?: string[];
}

export interface CheckoutCommitResponse {
  success: boolean;
}

export interface CherryPickResponse {
  success: boolean;
  conflict?: boolean;
  conflictFiles?: string[];
}

export interface RevertCommitResponse {
  success: boolean;
  conflict?: boolean;
  conflictFiles?: string[];
}

export interface ResetToCommitResponse {
  success: boolean;
}

export interface GitRebaseResult {
  success: boolean;
  conflict?: boolean;
  conflictFiles?: string[];
}

export interface MergeConflictDetails {
  statusPorcelain: string;
  unmergedFiles: string[];
  diff: string;
  headInfo: string;
  operation: 'merge' | 'rebase';
}

export interface GitLogEntry {
  hash: string;
  date: string;
  message: string;
  refs: string;
  body: string;
  author_name: string;
  author_email: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  parents: string[];
}

export interface GitLogResponse {
  all: GitLogEntry[];
  latest: GitLogEntry | null;
  total: number;
}

export interface CommitFileEntry {
  path: string;
  previousPath?: string;
  insertions: number;
  deletions: number;
  isBinary: boolean;
  changeType: 'A' | 'M' | 'D' | 'R' | 'C' | string;
}

export interface GitCommitFilesResponse {
  files: CommitFileEntry[];
}

export interface GetGitCommitDiffOptions {
  hash: string;
  path?: string;
  previousPath?: string;
  contextLines?: number;
}

export interface CommitFileDiffResponse {
  original: string;
  modified: string;
  isBinary: boolean;
}

export interface GitWorktreeInfo {
  head: string;
  name: string;
  branch: string;
  path: string;
  title?: string;
  pinnedAt?: number;
  pinList?: string;
  provenance?: GitContributorWorktreeProvenance;
}

export interface GitWorktreeTitleResult {
  title: string;
  branch: string;
}

export interface GitWorktreePinResult {
  pinned: boolean;
  branch: string;
}

export interface GitContributorWorktreeProvenance {
  kind: 'contributor-fork';
  revision: number;
  trust: 'untrusted';
  push: 'destination-selection-required';
  prunable?: boolean;
}

export interface GitWorktreeValidationError {
  code: string;
  message: string;
}

export interface GitWorktreeValidationResult {
  ok: boolean;
  errors: GitWorktreeValidationError[];
  resolved?: {
    mode?: 'new' | 'existing';
    localBranch?: string | null;
  };
}

export class GitWorktreeRequestError extends Error {
  readonly code: string;
  readonly status: number;
  readonly remoteName?: string;

  constructor(code: string, message: string, status: number, remoteName?: string) {
    super(message);
    this.name = 'GitWorktreeRequestError';
    this.code = code;
    this.status = status;
    this.remoteName = remoteName;
  }
}

export interface GitWorktreeBootstrapStatus {
  status: 'pending' | 'ready' | 'failed';
  phase?: 'directory-created' | 'git-ready' | 'setup-ready';
  error: string | null;
  errorCode?: GitNetworkOperationErrorCode;
  updatedAt: number;
  hydration?: GitCheckoutHydrationResult;
}

export interface CreateGitWorktreePayload {
  mode?: 'new' | 'existing';
  worktreeName?: string;
  name?: string;
  branchName?: string;
  existingBranch?: string;
  startRef?: string;
  startCommand?: string;
  createCommand?: string;
  setUpstream?: boolean;
  upstreamRemote?: string;
  upstreamBranch?: string;
  ensureRemoteName?: string;
  ensureRemoteUrl?: string;
  expectedRevision?: string;
  changeRequestSource?: GitChangeRequestSourceRequest;
  returnAfterDirectoryCreated?: boolean;
  taskTitle?: string;
  generatedBranchName?: string;
  generatedBranchPrefix?: string;
}

export interface GitChangeRequestSourceRequest {
  context: SourceControlReadContext;
  project: { id: string; owner: string; name: string };
  number: number;
  expectedHeadSha: string;
  requestedRemoteName: string;
}

export interface GitWorktreeCreateResult {
  head: string;
  name: string;
  branch: string;
  path: string;
  directoryCreated?: true;
  bootstrapStatus?: GitWorktreeBootstrapStatus;
  sourceFetchFailed?: true;
  sourceFetchReason?: 'access';
  branchBackup?: string;
  provenance?: GitContributorWorktreeProvenance;
}

export interface GitCheckoutTrustInspection {
  state: 'awaiting-trust';
  digest: string;
  actions: Array<{ kind: 'post-checkout-hook' | 'project-start-command' | 'setup-command'; label: string }>;
}

export interface RemoveGitWorktreePayload {
  directory: string;
  deleteLocalBranch?: boolean;
  teardownCommand?: string;
}

export interface TeardownGitWorktreePayload {
  directory: string;
  teardownCommand: string;
}

export interface GitWorktreeSnapshotPayload {
  ref: string;
}

export interface GitWorktreeSnapshotResult {
  ref: string;
  commit: string;
  head: string;
}

export interface GitWorktreeArchive {
  id: string;
  ref: string;
  commit: string;
  head: string;
  path: string;
  branch: string;
  branchExists: boolean;
  title: string;
  archivedAt: number;
  sessionIds: string[];
}

export interface ArchiveGitWorktreePayload {
  directory: string;
  id: string;
  sessionIds: string[];
  title?: string;
  /** Allow snapshot-backed removal of a locked worktree; only merged-PR cleanup opts in. */
  forceLocked?: boolean;
}

export interface GitWorktreeArchiveRestoreResult {
  id: string;
  conflicts: boolean;
}

export interface DeleteGitWorktreeArchivePayload {
  id: string;
  deleteBranch?: boolean;
}

export interface GitDeleteBranchPayload {
  branch: string;
  force?: boolean;
}

export interface GitRemoveRemotePayload {
  remote: string;
}

export interface CreateGitCommitOptions {
  addAll?: boolean;
  files?: string[];
  stageFiles?: string[];
}

export interface GitLogOptions {
  maxCount?: number;
  from?: string;
  to?: string;
  file?: string;
  all?: boolean;
}

export interface GeneratedCommitMessage {
  subject: string;
  highlights: string[];
}

export interface GeneratedPullRequestDescription {
  title: string;
  body: string;
}

interface GitWorktreeAPI {
  list(directory: string): Promise<GitWorktreeInfo[]>;
  validate?(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeValidationResult>;
  bootstrapStatus?(directory: string): Promise<GitWorktreeBootstrapStatus>;
  preview?(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeCreateResult>;
  create?(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeCreateResult>;
  remove?(directory: string, payload: RemoveGitWorktreePayload): Promise<{ success: boolean }>;
  teardown?(directory: string, payload: TeardownGitWorktreePayload): Promise<{ success: boolean }>;
  setTitle?(directory: string, title: string, by?: 'user' | 'agent'): Promise<GitWorktreeTitleResult>;
  setPinned?(directory: string, pinned: boolean, list?: string | null): Promise<GitWorktreePinResult>;
  snapshot?(directory: string, payload: GitWorktreeSnapshotPayload): Promise<GitWorktreeSnapshotResult>;
  archive?(directory: string, payload: ArchiveGitWorktreePayload): Promise<GitWorktreeArchive>;
  listArchives?(directory: string): Promise<GitWorktreeArchive[]>;
  restoreArchive?(directory: string, id: string): Promise<GitWorktreeArchiveRestoreResult>;
  deleteArchive?(directory: string, payload: DeleteGitWorktreeArchivePayload): Promise<{ id: string; branchDeleted: boolean }>;
}

export interface GitAPI {
  checkIsGitRepository(directory: string): Promise<boolean>;
  getGitStatus(directory: string, options?: { mode?: 'light'; fresh?: boolean }): Promise<GitStatus>;
  prefetchProjectStatuses?(directories: string[]): Promise<void>;
  getGitDiff?(directory: string, options: GetGitDiffOptions): Promise<GitPathDiffResponse>;
  getGitDiffs?(directory: string, options: GetGitDiffsOptions): Promise<GitPathDiffBatchEntry[]>;
  getGitFileDiff?(directory: string, options: GetGitFileDiffOptions): Promise<GitFileDiffResponse>;
  getGitRangeDiff?(directory: string, options: GetGitRangeDiffOptions): Promise<GitDiffResponse>;
  getGitRangeFiles?(directory: string, options: GetGitRangeFilesOptions): Promise<GitRangeFileEntry[]>;
  getBranchBase?(directory: string, branch: string): Promise<GitBranchBaseResponse>;
  revertGitFile(directory: string, filePath: string, options?: { scope?: 'all' | 'working' }): Promise<void>;
  stageGitFile(directory: string, filePath: string): Promise<void>;
  stageGitFiles?(directory: string, filePaths: string[]): Promise<void>;
  unstageGitFile(directory: string, filePath: string): Promise<void>;
  unstageGitFiles?(directory: string, filePaths: string[]): Promise<void>;
  stageGitHunk?(directory: string, filePath: string, patch: string): Promise<void>;
  unstageGitHunk?(directory: string, filePath: string, patch: string): Promise<void>;
  revertGitHunk?(directory: string, filePath: string, patch: string): Promise<void>;
  isLinkedWorktree(directory: string): Promise<boolean>;
  getGitBranches(directory: string, options?: GitBranchListOptions): Promise<GitBranch>;
  getGitUnpushedBranchCounts(directory: string, branches: string[]): Promise<GitUnpushedBranchCounts>;
  deleteGitBranch(directory: string, payload: GitDeleteBranchPayload): Promise<{ success: boolean }>;
  removeRemote(directory: string, payload: GitRemoveRemotePayload): Promise<{ success: boolean }>;
  generateCommitMessage?(directory: string, files: string[], options?: { zenModel?: string; providerId?: string; modelId?: string }): Promise<{ message: GeneratedCommitMessage }>;
  generatePullRequestDescription?(
    directory: string,
    payload: { base: string; head: string; context?: string; zenModel?: string; providerId?: string; modelId?: string }
  ): Promise<GeneratedPullRequestDescription>;
  listGitWorktrees(directory: string): Promise<GitWorktreeInfo[]>;
  validateGitWorktree?(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeValidationResult>;
  getGitWorktreeBootstrapStatus?(directory: string): Promise<GitWorktreeBootstrapStatus>;
  previewGitWorktree?(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeCreateResult>;
  createGitWorktree?(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeCreateResult>;
  deleteGitWorktree?(directory: string, payload: RemoveGitWorktreePayload): Promise<{ success: boolean }>;
  createGitCommit?(directory: string, message: string, options?: CreateGitCommitOptions): Promise<GitCommitResult>;
  gitPush?(directory: string, options?: { remote?: string; branch?: string; options?: string[] | Record<string, unknown> }): Promise<GitPushResult>;
  gitPull?(directory: string, options?: GitPullOptions): Promise<GitPullResult>;
  gitFetch?(directory: string, options?: { remote?: string; branch?: string }): Promise<{ success: boolean }>;
  planNetworkOperation(request: GitNetworkOperationRequest): Promise<GitNetworkOperationPlan>;
  issueContributorDestination(request: GitContributorDestinationRequest): Promise<GitContributorDestinationSelection>;
  listContributorDestinations(directory: string): Promise<GitContributorDestinationCandidates>;
  inspectCheckoutTrust(directory: string): Promise<GitCheckoutTrustInspection>;
  decideCheckoutTrust(directory: string, digest: string, decision: 'run' | 'skip'): Promise<{ state: string }>;
  executeNetworkOperation(operationId: string): Promise<GitNetworkOperation>;
  getNetworkOperation(operationId: string): Promise<GitNetworkOperation>;
  cancelNetworkOperation(operationId: string): Promise<GitNetworkOperation>;
  managedSshCredentials?(intent: GitManagedSshIntent): Promise<GitManagedSshResult>;
  configureTransportBinding?(intent: GitTransportBindingIntent): Promise<GitTransportBindingResult>;
  removeTransportBinding?(intent: GitTransportBindingRemovalIntent): Promise<GitTransportBindingRemovalResult>;
  configureAuxiliaryBinding?(intent: GitAuxiliaryBindingIntent): Promise<GitAuxiliaryBindingResult>;
  listGitStashes(directory: string): Promise<{ stashes: GitStashEntry[] }>;
  countGitStashFiles(directory: string, refs: string[]): Promise<{ counts: Record<string, number> }>;
  stashGitChanges(directory: string, options?: { message?: string }): Promise<{ success: boolean; created: boolean; message: string; output: string }>;
  applyGitStash(directory: string, options: { ref: string }): Promise<{ success: boolean; ref: string }>;
  popGitStash(directory: string, options: { ref: string }): Promise<{ success: boolean; ref: string }>;
  dropGitStash(directory: string, options: { ref: string }): Promise<{ success: boolean; ref: string }>;
  checkoutBranch?(directory: string, branch: string): Promise<{ success: boolean; branch: string }>;
  createBranch(directory: string, name: string, startPoint?: string): Promise<{ success: boolean; branch: string }>;
  renameBranch(directory: string, oldName: string, newName: string): Promise<{ success: boolean; branch: string }>;
  getGitLog?(directory: string, options?: GitLogOptions): Promise<GitLogResponse>;
  addChangeIdToHead?(directory: string, expectedHead: string): Promise<{ sha: string; changeId: string }>;
  getCommitFiles?(directory: string, hash: string): Promise<GitCommitFilesResponse>;
  getGitCommitDiff?(directory: string, options: GetGitCommitDiffOptions): Promise<GitDiffResponse>;
  getCommitFileDiff?(directory: string, hash: string, filePath: string, isBinary: boolean): Promise<CommitFileDiffResponse>;
  getCurrentGitIdentity?(directory: string): Promise<GitIdentitySummary | null>;
  hasLocalIdentity?(directory: string): Promise<boolean>;
  setGitIdentity?(directory: string, profileId: string): Promise<{ success: boolean; profile: GitIdentityProfile | null }>;
  getGitIdentities(): Promise<GitIdentityProfile[]>;
  createGitIdentity(profile: GitIdentityProfile): Promise<GitIdentityProfile>;
  updateGitIdentity(id: string, updates: GitIdentityProfile): Promise<GitIdentityProfile>;
  deleteGitIdentity(id: string): Promise<void>;
  getGlobalGitIdentity?(): Promise<GitIdentitySummary | null>;
  getRemotes(directory: string): Promise<GitRemote[]>;
  rebase?(directory: string, options: { onto: string }): Promise<GitRebaseResult>;
  abortRebase?(directory: string): Promise<{ success: boolean }>;
  continueRebase?(directory: string): Promise<{ success: boolean; conflict: boolean; conflictFiles?: string[] }>;
  merge?(directory: string, options: { branch: string }): Promise<GitMergeResult>;
  abortMerge?(directory: string): Promise<{ success: boolean }>;
  continueMerge?(directory: string): Promise<{ success: boolean; conflict: boolean; conflictFiles?: string[] }>;
  checkoutCommit?(directory: string, hash: string): Promise<CheckoutCommitResponse>;
  cherryPick?(directory: string, hash: string): Promise<CherryPickResponse>;
  revertCommit?(directory: string, hash: string): Promise<RevertCommitResponse>;
  resetToCommit?(directory: string, hash: string, mode: 'soft' | 'mixed' | 'hard', force?: boolean): Promise<ResetToCommitResponse>;
  stash(directory: string, options?: { message?: string; includeUntracked?: boolean }): Promise<{ success: boolean }>;
  stashPop(directory: string): Promise<{ success: boolean }>;
  getConflictDetails?(directory: string): Promise<MergeConflictDetails>;
  validateWorktreeDirectory?(directory: string, worktreeRoot: string): Promise<{
    valid: boolean;
    insideWorktreeRoot: boolean;
    resolvedWorktreeRoot: string | null;
    resolvedCwd: string | null;
  }>;
  resolveRepositoryPrefix?(directory: string): Promise<string>;
  canonicalizeWorktreeState?(directory: string): Promise<{
    worktreeRoot: string | null;
    cwd: string | null;
    branch: string | null;
    headState: 'branch' | 'detached' | 'unborn';
    worktreeStatus: 'pending' | 'ready' | 'missing' | 'invalid' | 'not-a-repo';
    legacy: boolean;
    degraded: boolean;
    attentionReason?: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null;
  }>;
  worktree?: GitWorktreeAPI;
}

export interface GitContributorDestinationRequest {
  directory: string;
  repositoryId: string;
  bindingRevision: number;
  configRevision: string;
  provenanceRevision: number;
  remote: GitNetworkRemoteTarget;
  sourceRef: string;
  destinationRef: string;
  transportMode: 'managed';
}

export interface GitContributorDestinationSelection {
  selectionId: string;
  provenanceRevision: number;
  sourceSha: string;
  expiresInMs: number;
}

export type GitContributorDestinationClassification = 'contributor-fork' | 'own-fork' | 'bound-repository' | 'other';

export type GitContributorDestinationCandidates = { kind: 'ordinary' } | {
  kind: 'contributor';
  repositoryId: string;
  bindingRevision: number;
  configRevision: string;
  provenanceRevision: number;
  candidates: Array<{
    remote: GitNetworkRemoteTarget;
    transportMode: 'managed';
    classification: GitContributorDestinationClassification;
  }>;
};

export interface FileListEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  modifiedTime?: number;
}

export interface DirectoryListResult {
  directory: string;
  entries: FileListEntry[];
}

export interface FileSearchQuery {
  directory: string;
  query: string;
  maxResults?: number;
  includeHidden?: boolean;
  respectGitignore?: boolean;
  signal?: AbortSignal;
}

export interface FileSearchResult {
  path: string;
  score?: number;
  preview?: string[];
}

export interface FileContentSearchQuery {
  directory: string;
  query: string;
  regex: boolean;
  limit?: number;
  includeHidden?: boolean;
  respectGitignore?: boolean;
  signal?: AbortSignal;
}

export interface FileContentSearchMatch {
  path: string;
  relativePath: string;
  line: number;
  column: number;
  text: string;
  ranges: Array<[number, number]>;
  cutStart: boolean;
}

export type FileContentSearchStop = 'limit' | 'deadline';

export type FileContentSearchOutcome =
  | { status: 'ok'; matches: FileContentSearchMatch[]; stopped: FileContentSearchStop | null }
  | { status: 'invalid-pattern'; message: string }
  | { status: 'unavailable' };

interface ListDirectoryOptions {
  respectGitignore?: boolean;
}

interface FileReadOptions {
  allowOutsideWorkspace?: boolean;
  outsideFileGrant?: string;
  optional?: boolean;
  directory?: string;
  fresh?: boolean;
}

export interface FilesAPI {
  listDirectory(path: string, options?: ListDirectoryOptions): Promise<DirectoryListResult>;
  search(payload: FileSearchQuery): Promise<FileSearchResult[]>;
  searchContents?(payload: FileContentSearchQuery): Promise<FileContentSearchOutcome>;
  createDirectory(path: string, options?: { directory?: string }): Promise<{ success: boolean; path: string }>;
  statFile?(path: string, options?: FileReadOptions): Promise<{ path: string; isFile: boolean; size: number; mtimeMs?: number }>;
  readFile?(path: string, options?: FileReadOptions): Promise<{ content: string; path: string }>;
  readFileBinary?(path: string, options?: FileReadOptions): Promise<{ dataUrl: string; path: string }>;
  writeFile?(path: string, content: string): Promise<{ success: boolean; path: string }>;
  uploadFile?(path: string, file: Blob, options?: { overwrite?: boolean; directory?: string }): Promise<{ success: boolean; path: string }>;
  delete?(path: string): Promise<{ success: boolean }>;
  rename?(oldPath: string, newPath: string): Promise<{ success: boolean; path: string }>;
  revealPath?(path: string): Promise<{ success: boolean }>;
  downloadFile?(path: string, options?: FileReadOptions): Promise<void>;
}

export interface ProjectEntry {
  id: string;
  path: string;
  label?: string;
  labelSource?: 'auto' | 'manual';
  icon?: string | null;
  iconImage?: {
    mime: string;
    updatedAt: number;
    source: 'custom' | 'auto';
  } | null;
  iconBackground?: string | null;
  color?: string | null;
  defaultAgent?: string;
  defaultModel?: string;
  defaultAgentCombinationId?: string;
  defaultVariant?: string;
  addedAt?: number;
  lastOpenedAt?: number;
  sidebarCollapsed?: boolean;
}

export type SidebarProjectEntry = Omit<ProjectEntry, 'lastOpenedAt' | 'sidebarCollapsed'>;

export interface SidebarSessionFolder {
  id: string;
  name: string;
  sessionIds: string[];
  createdAt: number;
  parentId: string | null;
}

export interface SidebarStateSnapshot {
  schemaVersion: 1;
  revision: number;
  projects: SidebarProjectEntry[];
  pinnedSessionIds: string[];
  worktreeOrderByProject: Record<string, string[]>;
  sessionFoldersByScope: Record<string, SidebarSessionFolder[]>;
}

export type SidebarProjectPatch = Partial<{
  path: string;
  label: string | null;
  icon: string | null;
  iconImage: ProjectEntry['iconImage'];
  iconBackground: string | null;
  color: string | null;
  defaultModel: string | null;
  defaultVariant: string | null;
  defaultAgentCombinationId: string | null;
  addedAt: number | null;
}>;

export type SidebarStateOperation =
  | { type: 'project.add'; project: SidebarProjectEntry; index?: number }
  | { type: 'project.remove'; projectId: string }
  | { type: 'project.update'; projectId: string; patch: SidebarProjectPatch }
  | { type: 'project.move'; projectId: string; toIndex: number }
  | { type: 'session.pin' | 'session.unpin'; sessionId: string }
  | { type: 'worktree.move'; projectId: string; path: string; toIndex: number; orderedPaths: string[] }
  | { type: 'worktree.clearOrder'; projectId: string }
  | { type: 'folder.create'; scopeKey: string; folder: Omit<SidebarSessionFolder, 'sessionIds'> }
  | { type: 'folder.rename'; scopeKey: string; folderId: string; name: string }
  | { type: 'folder.delete'; scopeKey: string; folderId: string }
  | { type: 'folder.assign'; scopeKey: string; folderId: string; sessionIds: string[] }
  | { type: 'folder.unassign'; scopeKey: string; sessionIds: string[] }
  | { type: 'folder.cleanup'; scopeKey: string; existingSessionIds: string[]; pruneEmpty: boolean };

export interface SidebarStateMutationRequest {
  baseRevision: number;
  clientMutationId: string;
  operation: SidebarStateOperation;
}

export interface SidebarStateMutationResult {
  snapshot: SidebarStateSnapshot;
  applied: boolean;
  deduplicated: boolean;
  mutationRevision: number;
}

export interface SidebarStateAPI {
  /** False only for runtimes, currently VS Code, that intentionally keep workspace-local structure. */
  supported: boolean;
  load(options?: { signal?: AbortSignal }): Promise<SidebarStateSnapshot | null>;
  mutate(request: SidebarStateMutationRequest, options?: { signal?: AbortSignal }): Promise<SidebarStateMutationResult | null>;
}

export type FollowUpQueueStatus = 'staged' | 'queued';

export interface FollowUpQueueAttachment {
  id: string;
  dataUrl: string;
  mimeType: string;
  filename: string;
  size: number;
  source: 'local' | 'server' | 'vscode';
  serverPath?: string;
  vscodePath?: string;
  vscodeSource?: 'file' | 'selection';
}

export interface FollowUpQueueAdditionalPart {
  text: string;
  attachments?: FollowUpQueueAttachment[];
  synthetic?: boolean;
  metadata?: ContextPartMetadata;
}

export interface FollowUpQueueSendConfig {
  subagentModel?: NativeAgentModel | null;
  providerID: string;
  modelID: string;
  /** Legacy queue data only. Preserved for mutation replay; never selects an executor. */
  executionFramework?: 'opencode' | 'claude-code';
  agent?: string;
  variant?: string;
}

export interface FollowUpQueueClaim {
  id: string;
  expiresAt: number;
}

export interface FollowUpQueueItem {
  id: string;
  messageId: string | null;
  content: string;
  attachments?: FollowUpQueueAttachment[];
  additionalParts?: FollowUpQueueAdditionalPart[];
  agentMentionName?: string;
  createdAt: number;
  status: FollowUpQueueStatus;
  sendConfig?: FollowUpQueueSendConfig;
  claim?: FollowUpQueueClaim;
  goal?: { objective?: string; tokenBudget: number | null };
}

export interface FollowUpQueueSnapshot {
  scopeToken: string;
  revision: number;
  items: FollowUpQueueItem[];
}

export type FollowUpQueueOperation =
  | { type: 'add'; item: Omit<FollowUpQueueItem, 'claim'> }
  | { type: 'remove'; itemId: string }
  | { type: 'set-status'; itemId: string; status: FollowUpQueueStatus }
  | { type: 'move'; itemId: string; beforeId: string | null }
  | { type: 'claim'; itemId: string; claimId: string; mode: 'manual' | 'auto' }
  | { type: 'complete'; itemId: string; claimId: string }
  | { type: 'release'; itemId: string; claimId: string; status: FollowUpQueueStatus };

export interface FollowUpQueueMutationRequest {
  sessionId: string;
  baseRevision: number;
  clientMutationId: string;
  operation: FollowUpQueueOperation;
}

export interface FollowUpQueueMutationResult {
  snapshot: FollowUpQueueSnapshot;
  applied: boolean;
  deduplicated: boolean;
  mutationRevision: number | null;
}

export interface FollowUpQueueAPI {
  /** False for runtimes, currently VS Code, without an OpenChamber host authority. */
  supported: boolean;
  load(sessionId: string, options?: { signal?: AbortSignal; expectedRuntimeKey?: string }): Promise<FollowUpQueueSnapshot | null>;
  mutate(request: FollowUpQueueMutationRequest, options?: { signal?: AbortSignal; expectedRuntimeKey?: string }): Promise<FollowUpQueueMutationResult | null>;
}

export type SettingsPayload = DesktopSettings;

export interface SettingsLoadResult {
  settings: SettingsPayload;
  source: 'desktop' | 'web';
}

export interface SettingsAPI {
  load(): Promise<SettingsLoadResult>;
  save(changes: Partial<SettingsPayload>): Promise<SettingsPayload>;

  restartOpenCode?: () => Promise<{ restarted: boolean }>;
}

export interface DirectoryPermissionRequest {
  path: string;
}

interface DirectoryPermissionResult {
  success: boolean;
  path?: string;
  error?: string;
}

export interface StartAccessingResult {
  success: boolean;
  error?: string;
}

export interface PermissionsAPI {
  requestDirectoryAccess(request: DirectoryPermissionRequest): Promise<DirectoryPermissionResult>;
  startAccessingDirectory(path: string): Promise<StartAccessingResult>;
  stopAccessingDirectory(path: string): Promise<StartAccessingResult>;
}

export interface NotificationPayload {
  title?: string;
  body?: string;

  tag?: string;
  kind?: string;
  sessionId?: string;
  directory?: string;
  runtimeKey?: string;
  requireHidden?: boolean;
  showWhenFocused?: boolean;
}

export interface NotificationsAPI {
  notifyAgentCompletion(payload?: NotificationPayload): Promise<boolean>;
  canNotify?: () => boolean | Promise<boolean>;
}

interface DiagnosticsAPI {
  downloadLogs(): Promise<{ fileName: string; content: string }>;
}

export interface EditorAPI {
  openFile(path: string, line?: number, column?: number): Promise<void>;
  openDiff(
    original: string,
    modified: string,
    label?: string,
    options?: { line?: number; patch?: string },
  ): Promise<void>;
}

export interface VSCodeAPI {
  executeCommand(command: string, ...args: unknown[]): Promise<unknown>;
  openExternalUrl(url: string): Promise<void>;
  pickFiles?(options?: { extensions?: string[] }): Promise<unknown>;
  saveImage?(payload: unknown): Promise<unknown>;
  saveMarkdown?(payload: unknown): Promise<unknown>;
  addWorkspaceFolder?(path: string): Promise<Array<{ name: string; path: string }>>;
}

type GitHubRepoRef = {
  owner: string;
  repo: string;
  host?: string;
  url: string;
};

export type GitHubPullRequest = {
  isInMergeQueue?: boolean;
  mergeQueueEntry?: { state: string; position: number } | null;
  autoMergeRequest?: { enabledAt: string; mergeMethod: string } | null;
  number: number;
  title: string;
  body?: string;
  url: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  base: string;
  head: string;
  headSha?: string;
  mergeable?: boolean | null;
  mergeableState?: string | null;
};

type GitHubPullRequestHeadRepo = {
  owner: string;
  repo: string;
  url: string;
  cloneUrl?: string;
  sshUrl?: string;
};

export type RepositoryItemRef = RepositorySelector & { number: number; host?: string };

export type ProviderReadsRefreshScope = { item: RepositoryItemRef } | { lists: true };

export type ChangeRequestLiveSummary = RepositoryItemRef & {
  isInMergeQueue?: boolean;
  mergeQueueEntry?: { state: string; position: number } | null;
  autoMergeRequest?: { enabledAt: string; mergeMethod: string } | null;
  state: GitHubPullRequest['state'];
  draft: boolean;
  title: string;
  headSha?: string;
  base?: string;
  mergeable: boolean | null;
  mergeableState: string | null;
  checks: CISummary | null;
};

export type IssueLiveSummary = RepositoryItemRef & {
  title: string;
  state: 'open' | 'completed' | 'not_planned';
};

export type DiscussionState = 'open' | DiscussionCloseReason;

export type DiscussionLiveSummary = RepositoryItemRef & {
  title: string;
  state: DiscussionState;
  answered: boolean | null;
};

export type RepositorySelector = {
  owner: string;
  repo: string;
};

export type RepositoryReferenceKind = 'issue' | 'pull' | 'discussion';
export type GitHubReferenceKind = 'issue' | 'pull';

export type RepositoryReferenceState = 'open' | 'closed' | 'merged' | 'all' | 'unanswered';
export type RepositoryReferencePeople = 'any' | 'assigned' | 'created' | 'reviewRequested' | 'mine';
export type RepositoryReferenceFilter = {
  state: RepositoryReferenceState;
  people: RepositoryReferencePeople;
  labels: string[];
};

export type RepositoryReferenceQuery = {
  kind: RepositoryReferenceKind;
  scope?: "network" | "repository";
  state?: RepositoryReferenceState;
  people?: RepositoryReferencePeople;
  labels?: string[];
  /** Search text, or a pasted link or number, which names one item of either kind. */
  query?: string;
  cursor?: string | null;
};

export type GitHubReferencesOptions = {
  kind: GitHubReferenceKind;
  /** The bound repository alone, or its fork network (the default). */
  scope?: 'repository' | 'network';
  state?: RepositoryReferenceState;
  people?: RepositoryReferencePeople;
  labels?: string[];
  query?: string;
  cursor?: string | null;
};

type RepositoryReferenceCommon = {
  number: number;
  title: string;
  url: string;
  body: string;
  bodyTruncated: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  author: { login: string; avatarUrl?: string } | null;
  labels: Label[];
  commentCount: number;
  sourceRepo: RepositorySelector & { source: string };
  linked?: true;
  projectId?: string;
  provider?: SourceControlProvider;
  directory?: string;
};

export type RepositoryIssueReference = RepositoryReferenceCommon & {
  kind: 'issue';
  state: IssueLiveSummary['state'];
};

export type RepositoryDiscussionReference = RepositoryReferenceCommon & {
  kind: 'discussion';
  state: DiscussionState;
  answered: boolean | null;
  upvotes: number;
  locked: boolean;
  category: { name: string; emoji: string | null; answerable: boolean };
};

export type RepositoryChangeRequestReference = RepositoryReferenceCommon & {
  kind: 'pull';
  state: GitHubPullRequest['state'];
  draft: boolean;
  head: string;
  base: string;
  headSha: string;
  headRepo: GitHubPullRequestHeadRepo | null;
  workInProgress?: boolean;
  private?: boolean;
  topic?: string;
  revisionNumber?: number;
};

export type ReviewCommentExcerpt = { startLine: number; lines: string[] };

export type RepositoryReferenceComment = {
  author: { login: string; avatarUrl?: string } | null;
  body: string;
  createdAt: string | null;
  url: string;
  id?: string;
  canUpdate?: boolean;
  canDelete?: boolean;
  path: string | null;
  line: number | null;
  review: 'approved' | 'changes_requested' | 'commented' | 'dismissed' | null;
  excerpt?: ReviewCommentExcerpt;
  thread?: RepositoryReferenceThread;
  answer?: { chosen: boolean; canChange: boolean };
};

export type RepositoryReferenceThread = {
  id: string;
  resolved: boolean;
  canResolve: boolean;
  canReply: boolean;
  replies: RepositoryReferenceComment[];
};

export type RepositoryReferenceReviewer = {
  id: string;
  login: string;
  avatarUrl?: string;
};

export type RepositoryReferenceDetail = {
  number: number;
  body?: string;
  viewerCanUpdate?: boolean;
  comments: RepositoryReferenceComment[];
  commentTotal: number;
  pull: {
    reviewDecision: 'approved' | 'changes_requested' | 'review_required' | null;
    reviewers: RepositoryReferenceReviewer[];
    additions: number;
    deletions: number;
    changedFiles: number;
    checks?: CISummary | null;
    commits: RepositoryReferenceCommit[];
    commitTotal: number | null;
    stack?: PullRequestStack | null;
    voteLabels?: ChangeRequestVoteLabel[];
    submitRequirements?: ChangeRequestSubmitRequirement[];
    revisions?: ChangeRequestRevision[];
  } | null;
  discussion?: { canComment: boolean; canClose: boolean; canReopen: boolean };
};

export type RepositoryReferenceCommit = {
  sha: string;
  headline: string;
  author: { login: string; avatarUrl?: string } | null;
  authorName: string | null;
  committedAt: string | null;
  url: string | null;
};

export type RepositoryReferenceDetailResult =
  | { connected: false }
  | { connected: true; detail: RepositoryReferenceDetail | null };

export type RepositoryReference = RepositoryIssueReference | RepositoryChangeRequestReference | RepositoryDiscussionReference;

export type ChangeRequestListStatus = RepositoryItemRef & {
  checks: CISummary | null;
  mergeable: boolean | null;
  mergeableState: string | null;
};

export type ChangeRequestListStatusesResult =
  | { connected: false }
  | { connected: true; statuses: ChangeRequestListStatus[] };

export type RepositoryReferencePage =
  | { connected: false }
  | {
      connected: true;
      repo: GitHubRepoRef | null;
      /** Echoed by servers that support single-repository browsing. */
      scope?: 'repository' | 'network';
      items: RepositoryReference[];
      cursor: string | null;
      hasMore: boolean;
      total: number;
    };

export type GitHubPullRequestRef = RepositoryItemRef;
export type GitHubIssueReference = RepositoryIssueReference;
export type GitHubPullReference = RepositoryChangeRequestReference;
export type GitHubReference = RepositoryReference;
export type GitHubReferenceComment = RepositoryReferenceComment;
export type GitHubReferenceThread = RepositoryReferenceThread;
export type GitHubReferenceReviewer = RepositoryReferenceReviewer;
export type GitHubReferenceDetail = RepositoryReferenceDetail;
export type GitHubReferenceCommit = RepositoryReferenceCommit;
export type GitHubReferenceDetailResult = RepositoryReferenceDetailResult;
export type GitHubPullStatus = ChangeRequestListStatus;
export type GitHubPullStatusesResult = ChangeRequestListStatusesResult;
export type GitHubReferencesResult = RepositoryReferencePage;
export type RepositoryReferencesAcrossSkip = 'no-repo' | 'disconnected' | 'invalid-context' | 'error';

export type RepositoryReferencesAcrossResult = {
  items: Array<RepositoryReference & { directory: string }>;
  cursor: string | null;
  hasMore: boolean;
  total: number;
  repositories: Array<
    | { directory: string; status: 'included'; repo: GitHubRepoRef }
    | { directory: string; status: RepositoryReferencesAcrossSkip }
  >;
};

export class SourceControlInstanceOtherProviderError extends Error {
  readonly provider: string;

  constructor(message: string, provider: string) {
    super(message);
    this.name = 'SourceControlInstanceOtherProviderError';
    this.provider = provider;
  }
}

export class SourceControlInstanceAliasError extends Error {
  readonly reason: 'invalid' | 'taken';
  readonly alias: string;

  constructor(message: string, reason: 'invalid' | 'taken', alias: string) {
    super(message);
    this.name = 'SourceControlInstanceAliasError';
    this.reason = reason;
    this.alias = alias;
  }
}

export interface SourceControlAPI {
  providers(): Promise<SourceControlProviderDescriptor[]>;
  repositoryContext(directory: string): Promise<SourceControlRepositoryContext>;
  repositoryBinding(directory: string): Promise<SourceControlBindingRead>;
  resetRepositoryBinding(intent: SourceControlRepositoryBindingResetIntent): Promise<SourceControlBindingRead>;
  repositoryProviderBindingMutate(input: SourceControlProviderBindingMutation): Promise<SourceControlBindingRead>;
  authInstances(): Promise<SourceControlIdentity[]>;
  capabilities(identity: SourceControlIdentity): Promise<SourceControlCapabilities>;
  authStatus(identity: SourceControlIdentity): Promise<SourceControlAuthStatus>;
  authStart(identity: SourceControlIdentity): Promise<SourceControlDeviceFlowStart>;
  authComplete(identity: SourceControlIdentity, flowId: string): Promise<SourceControlDeviceFlowComplete>;
  authSetToken(identity: SourceControlIdentity, token: string, options?: { username?: string }): Promise<SourceControlAuthStatus>;
  authSetSshUrl(identity: SourceControlIdentity, sshUrl: string | null): Promise<{ sshUrl: string | null }>;
  setInstanceAliases(identity: SourceControlIdentity, aliases: string[]): Promise<{ aliases: string[] }>;
  authDisconnect(identity: SourceControlIdentity, accountId: string): Promise<{ removed: boolean }>;
  authActivate(identity: SourceControlIdentity, accountId: string): Promise<SourceControlAuthStatus>;
  authSetCliDisabled(identity: SourceControlIdentity, disabled: boolean): Promise<{ disabled: boolean }>;

  changeRequestStatus(
    context: SourceControlReadContext,
    branch: string,
    options?: { force?: boolean },
  ): Promise<ChangeRequestStatus>;
  changeRequestCreate(payload: CreateChangeRequestInput): Promise<SourceControlMutationReceipt<SourceControlCreateMutationResult>>;
  changeRequestUpdate(payload: UpdateChangeRequestInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  issueUpdate(payload: UpdateIssueInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  changeRequestMerge(payload: MergeChangeRequestInput): Promise<SourceControlMutationReceipt<SourceControlMergeMutationResult>>;
  changeRequestReady(payload: ReadyChangeRequestInput): Promise<SourceControlMutationReceipt<SourceControlReadyMutationResult>>;
  changeRequestDraft(payload: DraftChangeRequestInput): Promise<SourceControlMutationReceipt<SourceControlDraftMutationResult>>;
  changeRequestComment(payload: CommentInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  changeRequestCommentUpdate(payload: CommentUpdateInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  changeRequestCommentDelete(payload: CommentDeleteInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  changeRequestStartThread(payload: CommentInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  changeRequestReplyToThread(payload: ThreadReplyInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  changeRequestResolveThread(payload: ThreadResolveInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  changeRequestReview(payload: ReviewChangeRequestInput): Promise<SourceControlMutationReceipt<SourceControlReviewMutationResult>>;
  changeRequestReviewState(context: SourceControlReadContext, ref: { owner: string; repo: string; number: number }): Promise<ChangeRequestReviewStateResult>;
  changeRequestReviewComment(payload: ReviewCommentInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  changeRequestReviewCommentUpdate(payload: ReviewCommentUpdateInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  changeRequestReviewCommentDelete(payload: ReviewCommentDeleteInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  changeRequestReviewDiscard(payload: ReviewDiscardInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  githubPendingReview?(context: SourceControlReadContext, pull: GitHubPullRequestRef): Promise<GitHubPendingReviewState>;
  githubPendingReviewAction?(payload: GitHubPendingReviewInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  issueComment(payload: CommentInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  issueCommentUpdate(payload: CommentUpdateInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  issueCommentDelete(payload: CommentDeleteInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  changeRequestSetState(payload: SetStateInput): Promise<SourceControlMutationReceipt<SourceControlStateMutationResult>>;
  issueSetState(payload: SetStateInput): Promise<SourceControlMutationReceipt<SourceControlStateMutationResult>>;
  changeRequestSetLabels(payload: SetLabelsInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  issueSetLabels(payload: SetLabelsInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  discussionComment(payload: DiscussionCommentInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  discussionSetState(payload: SetDiscussionStateInput): Promise<SourceControlMutationReceipt<SourceControlStateMutationResult>>;
  discussionSetAnswer(payload: SetDiscussionAnswerInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  discussionUpdate(payload: UpdateDiscussionInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  discussionSetLabels(payload: SetLabelsInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  discussionCommentUpdate(payload: CommentUpdateInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  discussionCommentDelete(payload: CommentDeleteInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  changeRequestSetReviewers(payload: SetReviewersInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  refreshProviderReads(identity: SourceControlIdentity, scope?: ProviderReadsRefreshScope): Promise<void>;
  referenceLabels(context: SourceControlReadContext, project: RepositorySelector): Promise<Label[]>;
  referenceReviewers(context: SourceControlReadContext, project: RepositorySelector): Promise<RepositoryReferenceReviewer[]>;
  changeRequestsList(
    context: SourceControlReadContext,
    options?: { page?: number; query?: string; state?: RepositoryReferenceState; people?: RepositoryReferencePeople; labels?: string[] },
  ): Promise<PageResult<ChangeRequest>>;
  changeRequestContext(
    context: SourceControlReadContext,
    number: number,
    options?: {
      includeDiff?: boolean;
      includeCIDetails?: boolean;
      includeTimeline?: boolean;
      project?: { owner: string; name: string };
      revision?: string;
    },
  ): Promise<ChangeRequestContext>;
  /** Complete per-file counts; incomplete or obsolete reads throw. */
  changeRequestFileStats(
    context: SourceControlReadContext,
    number: number,
    options?: { project?: { owner: string; name: string }; expectedHeadSha?: string; signal?: AbortSignal },
  ): Promise<import('../source-control/types').ChangeRequestFileStats>;

  issuesList(
    context: SourceControlReadContext,
    options?: { page?: number; query?: string; state?: RepositoryReferenceState; people?: RepositoryReferencePeople; labels?: string[] },
  ): Promise<PageResult<Issue>>;
  issueGet(
    context: SourceControlReadContext,
    number: number,
    project?: { owner: string; name: string },
  ): Promise<Issue | null>;
  issueComments(
    context: SourceControlReadContext,
    number: number,
    project?: { owner: string; name: string },
  ): Promise<IssueComment[]>;
  projectUpstream(context: SourceControlReadContext): Promise<ProjectUpstream>;
  projectBranches(context: SourceControlReadContext, owner: string, project: string): Promise<string[]>;

  references(context: SourceControlReadContext, query: RepositoryReferenceQuery): Promise<RepositoryReferencePage>;
  referencesAcross?(contexts: SourceControlReadContext[], query: RepositoryReferenceQuery): Promise<RepositoryReferencesAcrossResult>;
  referenceDetail(context: SourceControlReadContext, ref: RepositoryItemRef & { kind?: 'discussion' }): Promise<RepositoryReferenceDetailResult>;
  changeRequestListStatuses(context: SourceControlReadContext, refs: RepositoryItemRef[]): Promise<ChangeRequestListStatusesResult>;
  /** Paginated workflow runs of the bound primary repository (`ci`). */
  ciRunsList(
    context: SourceControlReadContext,
    options?: { page?: number; status?: CiRunStatusFilter; branch?: string; query?: string },
  ): Promise<CiWorkflowRunPage>;
  /** Full detail of one workflow run, its jobs, steps and failure annotations (`ci`). */
  ciRunDetail(context: SourceControlReadContext, runId: string): Promise<CiWorkflowRunDetail>;
  /** Bounded plain-text tail of one workflow job's log (`ci`). */
  ciJobLog(context: SourceControlReadContext, jobId: string): Promise<CiJobLogResult>;
}

export interface RemoteClientRecord {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiresAt?: string | null;
  clientKind?: string | null;
  authMethod?: string | null;
  pairingId?: string | null;
  deviceName?: string | null;
  devicePlatform?: string | null;
  usesRelay?: boolean;
  lastTransport?: 'relay' | 'direct' | null;
}

export interface PendingPairingRecord {
  id: string;
  label?: string;
  fingerprint?: string | null;
  expiresAt?: string;
  usesRelay?: boolean;
}

export interface RemoteClientCreateResult {
  client: RemoteClientRecord;
  token: string;
}

export interface RemoteClientRevokeResult {
  revoked: boolean;
  client?: RemoteClientRecord;
}

export interface RemoteClientPurgeRevokedResult {
  purged: number;
}

export interface PairingSessionCreateResult {
  pairing: {
    id: string;
    label?: string;
    fingerprint?: string | null;
    expiresAt?: string;
    secret: string;
  };
  server: {
    label: string;
    candidates: Array<Record<string, unknown>>;
  };
}

export interface ClientAuthAPI {
  listClients(): Promise<RemoteClientRecord[]>;
  createClient(input?: { label?: string }): Promise<RemoteClientCreateResult>;
  createPairingSession(input?: {
    label?: string;
    allowedClientKinds?: Array<'mobile' | 'desktop'>;
    serverUrl?: string;
    includeRelay?: boolean;
    includeDirect?: boolean;
  }): Promise<PairingSessionCreateResult>;
  purgeRevokedClients(): Promise<RemoteClientPurgeRevokedResult>;
  revokeClient(id: string): Promise<RemoteClientRevokeResult>;
  listPendingPairings(): Promise<PendingPairingRecord[]>;
  cancelPairing(id: string): Promise<{ cancelled: boolean }>;
  getPairingTransports(): Promise<{ local: string | null; lan: string | null; relayAvailable: boolean }>;
  getRelayHostStatus(): Promise<RelayHostStatus>;
  resetRelayIdentity(): Promise<RelayHostStatus>;
}

export interface RelayHostStatus {
  identityConflict: boolean;
}

export type NativeCapabilities = z.infer<typeof nativeCapabilitiesSchema>;
export type NativeCatalog = z.infer<typeof nativeCatalogSchema>;
export type NativeSessionList = z.infer<typeof nativeSessionListSchema>;
export type NativeMessagePage = z.infer<typeof nativeMessagePageSchema>;
export type NativeStatusSnapshot = z.infer<typeof nativeStatusSnapshotSchema>;
export type NativeBackgroundTaskSnapshot = z.infer<typeof nativeBackgroundTaskSnapshotSchema>;
export type NativeQuestionSnapshot = z.infer<typeof nativeQuestionSnapshotSchema>;
export type NativeRevertResult = z.infer<typeof nativeRevertResultSchema>;
export type NativeCommandList = z.infer<typeof nativeCommandListSchema>;
export type NativeCodexCommandResult = z.infer<typeof nativeCommandResultSchema>;
export type NativeCodexReviewTarget =
  | { type: 'uncommittedChanges' }
  | { type: 'baseBranch'; branch: string }
  | { type: 'commit'; sha: string }
  | { type: 'custom'; instructions: string };
export type NativeCodexCommandRequest = { directory: string } & (
  | { name: 'skills'; sessionId?: string }
  | { name: 'mcp'; sessionId: string; verbose?: boolean }
  | { name: 'ps' | 'stop'; sessionId: string }
  | { name: 'review'; sessionId: string; model: string; variant?: string; target: NativeCodexReviewTarget }
);
export type NativeDeepseekCommandRequest = { directory: string; sessionId: string; line: string };
export type NativeCommandResult = NativeCodexCommandResult;

/** Cancels a native read early; every read also has its own deadline. */
export type NativeReadOptions = { signal?: AbortSignal };

export type NativePromptPart =
  | { type: 'text'; text: string }
  | { type: 'file'; mime: string; url: string; filename?: string };

/** A compaction the CLI runs on the session's model; Claude Code may take summary instructions. */
export type NativeCompactRequest = {
  directory: string;
  model: { providerID: string; modelID: string };
  variant?: string;
  agent: 'build' | 'plan';
  instructions?: string;
};

/** A change to a native session's title or archive state. */
/**
 * `metadata` replaces the session's OpenChamber metadata (btw and review links,
 * goals, the assist), which the server keeps since the CLI has none.
 */
export type NativeSessionPatch = { title?: string; archived?: boolean; metadata?: SessionMetadataRecord };

/** Refuses a stop if a unified conversation has switched its executing source. */
export type NativeAbortOptions = { expectedSourceSessionId: string };

/** Native prompts retain client identity; unified conversations map it to their source CLI. */
export type NativePromptRequest = {
  subagentModel?: NativeAgentModel | null;
  directory: string;
  messageID: string;
  parts: NativePromptPart[];
  model: { providerID: string; modelID: string };
  variant?: string;
  agent: 'build' | 'plan';
  /** Queued sends keep the model selected for later messages. */
  preserveSelection?: boolean;
  /** A feature's instructions (the btw boundary): the CLI reads them, the conversation does not show them. */
  instructions?: string;
};

export type NativeSessionSelection = Pick<NativePromptRequest, 'model' | 'variant' | 'agent'>;
export type NativePlanExecutionChoice = Pick<NativePromptRequest, 'model' | 'variant'> & { expectedRevision?: number };
export type NativeSessionCreate =
  | { backend: NativeBackend; directory: string; title?: string; kind?: 'single' }
  | { backend: NativeBackend; directory: string; title?: string; kind: 'unified'; selection: NativeSessionSelection; configuration?: NativeAgentConfigurationWrite };

/**
 * Native CLI sessions, read and driven by the OpenChamber
 * server. Every method throws on failure; none reports a failure as empty.
 */
export interface NativeAgentsAPI {
  configureAgents(sessionId: string, directory: string, configuration: NativeAgentConfigurationWrite, expectedRevision: number, main?: NativeSessionSelection, expectedSelectionRevision?: number): Promise<Session>;
  stats(query: NativeStatisticsQuery, options?: NativeReadOptions): Promise<NativeStatistics>;
  memoryStatus(directory?: string, options?: NativeReadOptions): Promise<NativeMemoryStatus>;
  connectMemory(backend: 'claude' | 'codex'): Promise<NativeMemoryConnection>;
  disconnectMemory(backend: 'claude' | 'codex'): Promise<NativeMemoryConnection>;
  importMemory(sourceId: string, directory: string): Promise<void>;
  /** False for runtimes without an OpenChamber server, currently VS Code. */
  supported: boolean;
  capabilities(): Promise<NativeCapabilities>;
  catalog(): Promise<NativeCatalog>;
  listClaudeConnections(): Promise<ClaudeConnection[]>;
  saveClaudeConnection(id: string | null, connection: ClaudeConnectionWrite): Promise<ClaudeConnection>;
  deleteClaudeConnection(id: string): Promise<void>;
  listCodexConnections(): Promise<CodexConnection[]>;
  saveCodexConnection(id: string | null, connection: CodexConnectionWrite): Promise<CodexConnection>;
  deleteCodexConnection(id: string): Promise<void>;
  deepseekSetupStatus(options?: NativeReadOptions): Promise<DeepseekSetupStatus>;
  setupDeepseek(): Promise<DeepseekSetupStatus>;
  /** Claude's slash commands, Codex's enabled skills or DeepSeek's command list. */
  commands(backend: 'claude' | 'codex' | 'deepseek' | 'antigravity', directory: string, options?: NativeReadOptions & { sessionId?: string }): Promise<NativeCommandList>;
  codexCommand(request: NativeCodexCommandRequest): Promise<NativeCodexCommandResult>;
  deepseekCommand(request: NativeDeepseekCommandRequest): Promise<NativeCommandResult>;
  /** Root sessions of a directory, reported per backend. */
  listSessions(directory: string, options?: NativeReadOptions): Promise<NativeSessionList>;
  /** Directories of managed chats holding native sessions; no project names them. */
  chatDirectories(options?: NativeReadOptions): Promise<string[]>;
  getSession(sessionId: string, directory: string, options?: NativeReadOptions): Promise<Session>;
  /** Newest page first; pass the returned cursor as `before`. */
  loadMessages(sessionId: string, directory: string, page: { limit: number; before?: string }): Promise<NativeMessagePage>;
  statuses(directory: string, options?: NativeReadOptions): Promise<NativeStatusSnapshot>;
  /** Every native session, in any directory, whose CLI still runs background tasks. */
  backgroundTasks(options?: NativeReadOptions): Promise<NativeBackgroundTaskSnapshot>;
  /** CLI-owned checklist; reading does not start a model turn. */
  checklist(sessionId: string, directory: string, options?: NativeReadOptions): Promise<NativeChecklistSnapshot>;
  /** The plan a Codex thread last wrote; other backends report unsupported. */
  plan(sessionId: string, directory: string, options?: NativeReadOptions): Promise<NativePlanSnapshot>;
  /** The steps Codex reported for a thread, as the current process observed them. */
  codexTodos(sessionId: string, directory: string, options?: NativeReadOptions): Promise<NativeTodosSnapshot>;
  /** Task details for the current CLI process, separate from the active set. */
  sessionTasks(sessionId: string, directory: string, options?: NativeReadOptions): Promise<NativeTaskSnapshot>;
  taskOutput(sessionId: string, taskId: string, directory: string, generation: string, options?: NativeReadOptions): Promise<NativeTaskOutput>;
  /** Requests one task to stop; the CLI's events confirm its final state. */
  stopTask(sessionId: string, taskId: string, directory: string, generation: string): Promise<void>;
  questions(directory: string, options?: NativeReadOptions): Promise<NativeQuestionSnapshot>;
  /** A single-CLI session or a unified conversation with its initial selection. */
  createSession(input: NativeSessionCreate): Promise<Session>;
  selectModel(sessionId: string, directory: string, selection: NativeSessionSelection, expectedRevision: number): Promise<Session>;
  /** Resolves once the CLI accepted the prompt; the turn streams as events. */
  prompt(sessionId: string, request: NativePromptRequest): Promise<void>;
  /** Stops the running turn; false when none was running. */
  abort(sessionId: string, options?: NativeAbortOptions): Promise<boolean>;
  /** Resolves once the CLI took the compaction; it streams in as a turn. */
  compact(sessionId: string, request: NativeCompactRequest): Promise<void>;
  /** One list of chosen labels per question. */
  replyQuestion(requestId: string, answers: string[][], execution?: NativePlanExecutionChoice): Promise<void>;
  rejectQuestion(requestId: string): Promise<void>;
  /**
   * Reverts a user message and everything after it. Files go back at once;
   * the conversation rewinds when the next prompt commits the revert.
   */
  revert(sessionId: string, messageId: string, directory: string): Promise<NativeRevertResult>;
  /** Puts back what a revert the next prompt has not committed restored. */
  unrevert(sessionId: string, directory: string): Promise<Session>;
  /** A new session holding the conversation before a user message, or all of it when the message is null. */
  fork(sessionId: string, messageId: string | null, directory: string): Promise<Session>;
  /** Renames, archives or restores a session in its CLI; resolves with the updated record. */
  updateSession(sessionId: string, directory: string, patch: NativeSessionPatch): Promise<Session>;
  /** Deletes the session from its CLI's store. */
  deleteSession(sessionId: string, directory: string): Promise<void>;
}



export interface ClipboardAPI {
  selection: {
    readText(): Promise<string>;
    writeText(text: string): Promise<void>;
  };
}

export type LinearUserSummary = {
  id: string;
  name: string | null;
  displayName: string | null;
  email: string | null;
  avatarUrl: string | null;
};

export type LinearOrganizationSummary = {
  id: string;
  name: string;
  urlKey: string | null;
};

export type LinearWorkspaceSummary = {
  id: string;
  name: string | null;
  urlKey: string | null;
  current: boolean;
  user?: LinearUserSummary | null;
  authorizedAt?: number | null;
};

export type LinearAuthStatus = {
  connected: boolean;
  user?: LinearUserSummary | null;
  organization?: LinearOrganizationSummary | null;
  scope?: string;
  workspaces?: LinearWorkspaceSummary[];
};

export type LinearAuthStart = {
  authorizationUrl: string;
  expiresIn: number;
  scope: string;
};

export type LinearAuthOrigin = 'desktop' | 'web';

export type LinearIssueState = {
  id: string | null;
  name: string | null;
  type: string | null;
};

export type LinearWorkflowState = {
  id: string;
  name: string;
  type: string | null;
  position: number;
};

export type LinearIssueAssignee = {
  name: string | null;
  displayName: string | null;
  avatarUrl: string | null;
};

export type LinearIssueTeam = {
  id: string;
  key: string;
  name: string;
};

export type LinearIssuePriority = 0 | 1 | 2 | 3 | 4;

export type LinearIssueLabel = {
  id: string;
  name: string;
  color: string | null;
};

export type LinearIssueSummary = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state?: LinearIssueState | null;
  assignee?: LinearIssueAssignee | null;
  team?: LinearIssueTeam | null;
  priority?: LinearIssuePriority | null;
  labels?: LinearIssueLabel[];
  updatedAt?: string | null;
  parent?: LinearIssueSummary | null;
  subIssueProgress?: LinearSubIssueProgress | null;
};

export type LinearSubIssueProgress = {
  total: number;
  done: number;
  more: boolean;
};

export type LinearIssueComment = {
  id: string;
  body: string;
  createdAt: string | null;
  user?: { name: string | null; displayName: string | null; avatarUrl?: string | null } | null;
};

export type LinearIssue = LinearIssueSummary & {
  description?: string | null;
  comments?: LinearIssueComment[];
  subIssues?: LinearIssueSummary[];
  subIssuesMore?: boolean;
};

export type LinearIssueListStatus = 'open' | 'all' | 'backlog' | 'todo' | 'started' | 'inReview' | 'completed' | 'canceled' | 'duplicate';
export type LinearIssueListAssignee = 'any' | 'me' | 'created';
export type LinearIssueListPriority = 'all' | 'none' | 'urgent' | 'high' | 'medium' | 'low';

export type LinearIssuesListOptions = {
  query?: string;
  cursor?: string;
  status?: LinearIssueListStatus;
  assignee?: LinearIssueListAssignee;
  teamId?: string;
  priority?: LinearIssueListPriority;
};

export type LinearIssuesListResult = {
  connected: boolean;
  issues?: LinearIssueSummary[];
  cursor?: string | null;
  hasMore?: boolean;
};

export type LinearIssueGetResult = {
  connected: boolean;
  issue?: LinearIssue | null;
};

export type LinearStateType = 'triage' | 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled';

export type LinearIssueLiveSummary = {
  identifier: string;
  title: string;
  state: { name: string; type: LinearStateType };
};

export type LinearIssueStatesResult = {
  connected: boolean;
  states?: LinearWorkflowState[];
};

export type LinearIssueUpdateInput = {
  id: string;
  stateId: string;
};

export type LinearIssueUpdateResult = {
  connected: boolean;
  issue?: LinearIssue | null;
};

export type LinearTeamMapping = {
  id: string;
  key: string;
  name: string;
  projectPath: string | null;
};

export type LinearMappingResult = {
  connected: boolean;
  defaultProjectPath?: string | null;
  teams?: LinearTeamMapping[];
};

export type LinearMappingWrite = {
  defaultProjectPath: string | null;
  teamProjectPaths: { [teamId: string]: string };
};

export type LinearSessionStatusKind = 'started' | 'completed' | 'failure';

export type LinearSessionStatusPostInput = {
  kind: LinearSessionStatusKind;
  sessionId: string;
  issueIdentifier?: string;
  sessionOrigin?: string;
};

export type LinearSessionStatusPostResult =
  | { connected: false }
  | { connected: true; posted: true; commentId: string | null }
  | {
    connected: true;
    posted: false;
    skipped: 'already-posted' | 'issue-not-found' | 'not-started' | 'disabled' | 'origin-not-public';
  };

export type LinearPreferences = {
  sessionComments: boolean;
};

export interface LinearAPI {
  authStatus(): Promise<LinearAuthStatus>;
  authStart(origin?: LinearAuthOrigin): Promise<LinearAuthStart>;
  authDisconnect(): Promise<{ removed: boolean }>;
  authActivate(organizationId: string): Promise<LinearAuthStatus>;
  issuesList(options?: LinearIssuesListOptions): Promise<LinearIssuesListResult>;
  issueGet(id: string): Promise<LinearIssueGetResult>;
  issueStates(teamId: string): Promise<LinearIssueStatesResult>;
  issueUpdate(input: LinearIssueUpdateInput): Promise<LinearIssueUpdateResult>;
  mappingGet(): Promise<LinearMappingResult>;
  mappingSet(mapping: LinearMappingWrite): Promise<LinearMappingResult>;
  sessionStatusPost(input: LinearSessionStatusPostInput): Promise<LinearSessionStatusPostResult>;
  preferencesGet(): Promise<LinearPreferences>;
  preferencesSet(preferences: LinearPreferences): Promise<LinearPreferences>;
}

export interface RuntimeAPIs {
  themeFiles?: {
    pick(): Promise<{ status: 'unsupported' } | { status: 'picked'; file: { name: string; size: number; text: string } | null }>;
  };
  clipboard?: ClipboardAPI;
  runtime: RuntimeDescriptor;
  terminal: TerminalAPI;
  git: GitAPI;
  files: FilesAPI;
  settings: SettingsAPI;
  sidebarState: SidebarStateAPI;
  followUpQueue: FollowUpQueueAPI;
  nativeAgents: NativeAgentsAPI;
  permissions: PermissionsAPI;
  notifications: NotificationsAPI;
  sourceControl: SourceControlAPI;
  trackers?: TrackerAPI;
  linear?: LinearAPI;
  push?: PushAPI;
  diagnostics?: DiagnosticsAPI;
  clientAuth?: ClientAuthAPI;
  editor?: EditorAPI;
  vscode?: VSCodeAPI;
  worktrees?: WorktreeMetadata[];
}

export type RuntimeAPISelector<TValue> = (apis: RuntimeAPIs) => TValue;

type SkillsCatalogSourceId = string;

type SkillsCatalogSourceType = 'github';

export interface SkillsCatalogSource {
  id: SkillsCatalogSourceId;
  label: string;
  description?: string;
  source: string;
  defaultSubpath?: string;
  sourceType?: SkillsCatalogSourceType;
  stars?: number | null;
  repoUpdatedAt?: string | null;
}

interface SkillsCatalogItemInstalledBadge {
  isInstalled: boolean;
  scope?: 'user' | 'project';
  source?: 'opencode' | 'agents' | 'claude';
}

export interface SkillsCatalogItem {
  sourceId: SkillsCatalogSourceId;
  repoSource: string;
  repoSubpath?: string;
  gitIdentityId?: string;
  skillDir: string;
  skillName: string;
  frontmatterName?: string;
  description?: string;
  installable: boolean;
  warnings?: string[];
  installed?: SkillsCatalogItemInstalledBadge;
}

export interface SkillsCatalogResponse {
  ok: boolean;
  sources?: SkillsCatalogSource[];
  itemsBySource?: Record<SkillsCatalogSourceId, SkillsCatalogItem[]>;
  error?: { kind: string; message: string };
}

export interface SkillsCatalogSourceResponse {
  ok: boolean;
  items?: SkillsCatalogItem[];
  error?: { kind: string; message: string };
}

export interface SkillsRepoScanRequest {
  source: string;
  subpath?: string;
  gitIdentityId?: string;
}

type SkillsRepoScanError =
  | { kind: 'authRequired'; message: string; sshOnly: true; identities?: Array<{ id: string; name: string }> }
  | { kind: 'invalidSource'; message: string }
  | { kind: 'gitUnavailable'; message: string }
  | { kind: 'networkError'; message: string }
  | { kind: 'unknown'; message: string };

export interface SkillsRepoScanResponse {
  ok: boolean;
  items?: SkillsCatalogItem[];
  error?: SkillsRepoScanError;
}

interface SkillsInstallSelection {
  skillDir: string;
}

export interface SkillsInstallRequest {
  source: string;
  subpath?: string;
  sourceId?: string;
  gitIdentityId?: string;
  scope: 'user' | 'project';
  targetSource?: 'opencode' | 'agents';
  selections: SkillsInstallSelection[];
  conflictPolicy?: 'prompt' | 'skipAll' | 'overwriteAll';
  conflictDecisions?: Record<string, 'skip' | 'overwrite'>;
}

export type SkillsInstallError = SkillsRepoScanError | {
  kind: 'conflicts';
  message: string;
  conflicts: Array<{ skillName: string; scope: 'user' | 'project'; source?: 'opencode' | 'agents' }>;
};

export interface SkillsInstallResponse {
  ok: boolean;
  installed?: Array<{ skillName: string; skillDir?: string; scope: 'user' | 'project'; source?: 'opencode' | 'agents' }>;
  skipped?: Array<{ skillName: string; reason: string }>;
  error?: SkillsInstallError;
  requiresReload?: boolean;
  requiresManualRestart?: boolean;
  reloadFailed?: boolean;
  warning?: string;
  message?: string;
  reloadDelayMs?: number;
}

export interface SkillsUpdateInstalledPlanItem {
  skillName: string;
  skillDir: string;
  scope: 'user' | 'project';
  source: 'opencode' | 'agents';
  sourceId: string;
  sourceRef: string;
}

export type SkillsUpdateInstalledFailureKind =
  | 'authRequired'
  | 'gitUnavailable'
  | 'networkError'
  | 'invalidSource'
  | 'unknown';

export interface SkillsUpdateInstalledResult {
  skillName: string;
  scope: 'user' | 'project';
  source?: 'opencode' | 'agents';
  status: 'updated' | 'skipped' | 'failed';
  kind?: SkillsUpdateInstalledFailureKind;
  reason?: string;
}

export type SkillsUpdateInstalledError =
  | { kind: 'busy'; message: string }
  | { kind: 'invalidSource'; message: string }
  | { kind: 'unknown'; message: string };

export interface SkillsUpdateInstalledResponse {
  ok: boolean;
  plan?: SkillsUpdateInstalledPlanItem[];
  results?: SkillsUpdateInstalledResult[];
  updated?: number;
  skipped?: number;
  failed?: number;
  message?: string;
  error?: SkillsUpdateInstalledError;
}

export type SkillsUserSyncAgent = 'claude' | 'codex';

export interface SkillsUserSyncSource {
  agent: SkillsUserSyncAgent;
  plugin: string;
  version: string;
}

/** `external`: a symlink whose target the sync does not own. */
export type SkillsUserSyncStatus = 'update' | 'current' | 'external' | 'noSource';

export interface SkillsUserSyncPlanItem {
  skillName: string;
  status: SkillsUserSyncStatus;
  source: SkillsUserSyncSource | null;
}

export interface SkillsUserSyncResult {
  skillName: string;
  status: 'updated' | 'skipped' | 'failed';
  reason?: SkillsUserSyncStatus;
  kind?: 'copyFailed';
  message?: string;
  source: SkillsUserSyncSource | null;
}

export type SkillsUserSyncError = { kind: 'busy' | 'unknown'; message: string };

export interface SkillsUserSyncResponse {
  ok: boolean;
  plan?: SkillsUserSyncPlanItem[];
  results?: SkillsUserSyncResult[];
  updated?: number;
  skipped?: number;
  failed?: number;
  error?: SkillsUserSyncError;
}




export interface CommandExecResult {
  command: string;
  success: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export type GitHubUserSummary = {
  login: string;
  id?: number;
  avatarUrl?: string;
  name?: string;
  email?: string;
};

export type GitHubChecksSummary = {
  state: 'success' | 'failure' | 'pending' | 'unknown';
  total: number;
  success: number;
  failure: number;
  /** queued + in_progress + unconcluded runs. */
  pending: number;
  inProgress?: number;
  queued?: number;
  /** Earliest started_at among in-progress runs (ISO), for elapsed display. */
  startedAt?: string;
};

export type GitHubCheckRun = {
  id?: number;
  name: string;
  startedAt?: string;
  completedAt?: string;
  app?: {
    name?: string;
    slug?: string;
  };
  status?: string;
  conclusion?: string | null;
  detailsUrl?: string;
  output?: {
    title?: string;
    summary?: string;
    text?: string;
  };
  job?: {
    runId?: number;
    jobId?: number;
    url?: string;
    name?: string;
    workflowName?: string;
    conclusion?: string | null;
    steps?: Array<{
      name: string;
      status?: string;
      conclusion?: string | null;
      number?: number;
      startedAt?: string;
      completedAt?: string;
    }>;
  };
  annotations?: Array<{
    path?: string;
    startLine?: number;
    endLine?: number;
    level?: string;
    message: string;
    title?: string;
    rawDetails?: string;
  }>;
};

export type GitHubPullRequestSummary = GitHubPullRequest & {
  author?: GitHubUserSummary | null;
  body?: string;
  createdAt?: string;
  updatedAt?: string;
  headLabel?: string;
  headRepo?: GitHubPullRequestHeadRepo | null;
  sourceRepo?: (GitHubRepoSelector & { source: string }) | null;
};

export type GitHubPullRequestsListResult = {
  connected: boolean;
  repo?: GitHubRepoRef | null;
  prs?: GitHubPullRequestSummary[];
  page?: number;
  hasMore?: boolean;
  failedRepos?: Array<{ owner: string; repo: string }>;
};

export type GitHubPullRequestFile = {
  filename: string;
  status?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
  patch?: string;
};

export type GitHubPullRequestReviewComment = {
  id: number;
  url: string;
  body: string;
  author?: GitHubUserSummary | null;
  path?: string;
  line?: number | null;
  position?: number | null;
  createdAt?: string;
  updatedAt?: string;
};

export type GitHubAuthAccount = {
  id: string;
  credentialId: string;
  credentialRevision: number;
  providerUserId: string;
  providerUserStatus: 'available' | 'unavailable';
  user: GitHubUserSummary;
  scope?: string;
  current?: boolean;
  source?: 'oauth' | 'pat' | 'cli' | 'gh-cli';
  status?: 'valid' | 'invalid';
};

export type GitHubPullRequestContextResult = {
  connected: boolean;
  /** Server-side stamp of when the data was fetched from GitHub (ms epoch); survives server cache serves. */
  fetchedAt?: number;
  repo?: GitHubRepoRef | null;
  pr?: GitHubPullRequestSummary | null;
  issueComments?: GitHubIssueComment[];
  reviewComments?: GitHubPullRequestReviewComment[];
  files?: GitHubPullRequestFile[];
  diff?: string;
  checks?: GitHubChecksSummary | null;
  checkRuns?: GitHubCheckRun[];
};

export type GitHubPullRequestStatus = {
  connected: boolean;
  /** Server-side stamp of when the data was fetched from GitHub (ms epoch); survives server cache serves. */
  fetchedAt?: number;
  repo?: GitHubRepoRef | null;
  branch?: string;
  pr?: GitHubPullRequest | null;
  checks?: GitHubChecksSummary | null;
  canMerge?: boolean;
  defaultBranch?: string | null;
  resolvedRemoteName?: string | null;
};

export type GitHubPullRequestLiveSummary = GitHubPullRequestRef & {
  state: GitHubPullRequest['state'];
  draft: boolean;
  title: string;
  headSha?: string;
  mergeable: boolean | null;
  mergeableState: string | null;
  /** Null for closed/merged PRs, whose checks are not actionable. */
  checks: GitHubChecksSummary | null;
};

export type GitHubIssueLiveSummary = GitHubPullRequestRef & {
  title: string;
  state: 'open' | 'completed' | 'not_planned';
};

export type GitHubIssueLabel = {
  name: string;
  color?: string;
};

export type GitHubRepoSelector = {
  owner: string;
  repo: string;
};

export type GitHubIssueSummary = {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed';
  author?: GitHubUserSummary | null;
  labels?: GitHubIssueLabel[];
  sourceRepo?: (GitHubRepoSelector & { source: string }) | null;
};

export type GitHubIssue = GitHubIssueSummary & {
  body?: string;
  assignees?: GitHubUserSummary[];
  createdAt?: string;
  updatedAt?: string;
};

export type GitHubIssueComment = {
  id: number;
  url: string;
  body: string;
  author?: GitHubUserSummary | null;
  createdAt?: string;
  updatedAt?: string;
};

export type GitHubIssuesListResult = {
  connected: boolean;
  repo?: GitHubRepoRef | null;
  issues?: GitHubIssueSummary[];
  page?: number;
  hasMore?: boolean;
  failedRepos?: Array<{ owner: string; repo: string }>;
};

export type GitHubRepoUpstreamResult = {
  connected: boolean;
  isFork: boolean;
  upstream: { owner: string; repo: string; url: string; defaultBranch: string; defaultBranchSha: string | null; remoteName: string | null } | null;
};

export type GitHubIssueGetResult = {
  connected: boolean;
  repo?: GitHubRepoRef | null;
  issue?: GitHubIssue | null;
};

export type GitHubIssueCommentsResult = {
  connected: boolean;
  repo?: GitHubRepoRef | null;
  comments?: GitHubIssueComment[];
};

export type GitHubAuthStatus = {
  connected: boolean;
  user?: GitHubUserSummary | null;
  scope?: string;
  accounts?: GitHubAuthAccount[];
  ghCli?: {
    available: boolean;
    disabled: boolean;
    active: boolean;
    user?: GitHubUserSummary | null;
  } | null;
};

export type GitHubDeviceFlowStart = {
  flowId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
  scope?: string;
};

export type GitHubDeviceFlowComplete =
  | { connected: true; user: GitHubUserSummary; scope?: string }
  | { connected: false; status?: string; error?: string };
