import { GuestServiceSocket, type GuestServiceSocketRequest } from './service-socket.ts';
import {
  type GuestProjectsSnapshot,
  type GuestWorktreesSnapshot,
  type GuestSessionsSnapshot,
  type GuestStorageOptions,
} from './workspace.ts';
import type { GuestStatusControl, GuestStatusControlEvent } from './status-controls.ts';
import type { GuestBlockCall, JsonValue } from './contract.ts';
import { type GuestPopoverClosedEvent, type GuestPopoverRequest } from './popover.ts';
import {
  type FileEditorChange,
  type FileEditorDocument,
  type FileEditorSnapshot,
  type FileSnapshotPurpose,
} from './file-editor.ts';
import {
  type AttachIssueRequest,
  type GuestActionItem,
  type ComposeRequest,
  type PromptRequest,
  type PromptResult,
  type SessionLifecycleEvent,
  type StartSessionRequest,
  type GuestConnection,
  type GuestItem,
  type GuestMessage,
  type GuestRequest,
  type GuestRequestResult,
  type GuestSettings,
  type HostReadyContext,
  type ResolveRequest,
  type SessionSnapshot,
  type StartSessionResult,
  type ToastRequest,
  type ServiceStatusResult,
  type FileListResult,
  type FileReadResult,
  type FileStatResult,
  type FileWriteResult,
  type GenerateRequest,
  type GenerateResult,
  type LateGenerateResult,
} from './contract.ts';
import { type GuestMicrophone } from './microphone.ts';
import {
  type GuestRunningShellsSnapshot,
  type GuestShellOutputResult,
  type GuestShellStopResult,
  type GuestShellsScope,
} from './shells.ts';

export type HostFrame = {
  postMessage: (message: GuestMessage, targetOrigin: string, transfer?: Transferable[]) => void;
  addEventListener: Window['addEventListener'];
  removeEventListener: Window['removeEventListener'];
  parent: {
    postMessage: (message: GuestMessage, targetOrigin: string, transfer?: Transferable[]) => void;
  };
};

export type HostClientOptions = {
  target?: HostFrame;
  acceptSource?: (source: MessageEvent['source']) => boolean;
  requestTimeoutMs?: number;
};

export type HostClient = {
  listProjects: () => Promise<GuestProjectsSnapshot>;
  listWorktrees: (projectId: string) => Promise<GuestWorktreesSnapshot>;
  listSessions: (projectId: string) => Promise<GuestSessionsSnapshot>;
  onProjects: (listener: (snapshot: GuestProjectsSnapshot) => void) => Promise<() => void>;
  onWorktrees: (projectId: string, listener: (snapshot: GuestWorktreesSnapshot) => void) => Promise<() => void>;
  onSessions: (projectId: string, listener: (snapshot: GuestSessionsSnapshot) => void) => Promise<() => void>;
  onRunningShells: (scope: GuestShellsScope, listener: (snapshot: GuestRunningShellsSnapshot) => void) => Promise<() => void>;
  readShellOutput: (shellId: string, options?: { cursor?: number; tailBytes?: number }) => Promise<GuestShellOutputResult>;
  stopShell: (shellId: string) => Promise<GuestShellStopResult>;
  openSession: (sessionId: string) => Promise<void>;
  storage: {
    get: (key: string, options?: GuestStorageOptions) => Promise<JsonValue | undefined>;
    set: (key: string, value: JsonValue, options?: GuestStorageOptions) => Promise<void>;
    delete: (key: string, options?: GuestStorageOptions) => Promise<void>;
    keys: (options?: GuestStorageOptions) => Promise<string[]>;
  };
  onReady: (listener: (context: HostReadyContext) => void) => () => void;
  onDirectory: (listener: (directory: string | null) => void) => () => void;
  onSession: (listener: (session: SessionSnapshot | null) => void) => () => void;
  onSessionLifecycle: (listener: (event: SessionLifecycleEvent) => void) => () => void;
  onConnection: (listener: (connection: GuestConnection) => void) => () => void;
  onSettings: (listener: (settings: GuestSettings) => void) => () => void;
  onItem: (listener: (item: GuestItem | null) => void) => () => void;
  onBlock: (listener: (block: GuestBlockCall) => void) => () => void;
  answerBlock: (text: string) => Promise<void>;
  onServiceEvent: (listener: (event: { topic: string; data: JsonValue }) => void) => () => void;
  onStatusControl: (listener: (event: GuestStatusControlEvent) => void) => () => void;
  onPopoverClosed: (listener: (event: GuestPopoverClosedEvent) => void) => () => void;
  setStatusControls: (controls: GuestStatusControl[]) => Promise<void>;
  openPopover: (request: GuestPopoverRequest) => Promise<void>;
  closePopover: (id: string, reason?: 'closed' | 'escape') => Promise<void>;
  setPopoverAnchorActive: (id: string, active: boolean) => Promise<void>;
  onResolve: (handler: (request: ResolveRequest) => Promise<AttachIssueRequest | null> | AttachIssueRequest | null) => () => void;
  onAction: (handler: (item: GuestActionItem) => void | Promise<void>) => () => void;
  toast: (request: ToastRequest) => Promise<void>;
  openUrl: (url: string) => Promise<void>;
  /** Open or focus an in-app browser tab in the current project. Requires ready.features.browserTabs. */
  openBrowser: (url: string) => Promise<void>;
  openCommit: (sha: string) => Promise<void>;
  openSurface: (surfaceId: string) => Promise<void>;
  writeClipboard: (text: string) => Promise<void>;
  compose: (request: ComposeRequest) => Promise<void>;
  attach: (request: AttachIssueRequest) => Promise<void>;
  startSession: (request: StartSessionRequest) => Promise<StartSessionResult>;
  prompt: (request: PromptRequest) => Promise<PromptResult>;
  sessionLink: (request: AttachIssueRequest) => Promise<void>;
  close: () => Promise<void>;
  oauthStart: () => Promise<void>;
  oauthDisconnect: () => Promise<void>;
  request: (request: GuestRequest) => Promise<GuestRequestResult>;
  serviceRequest: (request: GuestRequest) => Promise<GuestRequestResult>;
  /** Open this extension's declared full-screen page. */
  openPage: () => Promise<void>;
  openServiceSocket: (request: GuestServiceSocketRequest) => GuestServiceSocket;
  serviceStatus: () => Promise<ServiceStatusResult>;
  readFile: (path: string) => Promise<FileReadResult>;
  writeFile: (path: string, content: string) => Promise<FileWriteResult>;
  listDir: (path: string) => Promise<FileListResult>;
  stat: (path: string) => Promise<FileStatResult>;
  generate: (request: GenerateRequest) => Promise<GenerateResult>;
  onLateGenerateResult: (listener: (result: LateGenerateResult) => void) => () => void;
  openMicrophone: () => Promise<GuestMicrophone>;
  setBadge: (count: number | null) => Promise<void>;
  setHeight: (height: number) => Promise<void>;
  onFileOpen: (listener: (file: FileEditorDocument) => void) => () => void;
  onFileSnapshot: (handler: (purpose: FileSnapshotPurpose) => Promise<FileEditorSnapshot> | FileEditorSnapshot) => () => void;
  onFileSaved: (listener: (version: string) => void) => () => void;
  reportFileChange: (change: FileEditorChange) => void;
  requestFileSave: () => void;
  reportFileUnsupported: () => void;
  dispose: () => void;
};
