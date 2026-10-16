import type { NativeAgentsAPI, RuntimeAPIs } from '@/lib/api/types';
import { NativeAgentsUnsupportedError } from '@/lib/native-agents/errors';

const untouchable = (): never => {
  throw new Error('This test exercises native sessions only; it must not reach other runtime APIs');
};

const unsupported = async (): Promise<never> => {
  throw new NativeAgentsUnsupportedError();
};

/** A native agents API whose methods fail unless the test supplies them. */
export const createTestNativeAgentsAPI = (methods: Partial<NativeAgentsAPI>): NativeAgentsAPI => ({
  supported: true,
  memoryStatus: unsupported,
  connectMemory: unsupported,
  disconnectMemory: unsupported,
  importMemory: unsupported,
  capabilities: unsupported,
  catalog: unsupported,
  cliproxyapiStatus: unsupported,
  saveCliproxyapiKey: unsupported,
  forgetCliproxyapiKey: unsupported,
  beginCliproxyapiLogin: unsupported,
  cliproxyapiLoginStatus: unsupported,
  cancelCliproxyapiLogin: unsupported,
  removeCliproxyapiAccount: unsupported,
  saveCliproxyapiConnection: unsupported,
  listClaudeConnections: unsupported,
  saveClaudeConnection: unsupported,
  deleteClaudeConnection: unsupported,
  listCodexConnections: unsupported,
  saveCodexConnection: unsupported,
  deleteCodexConnection: unsupported,
  commands: unsupported,
  codexCommand: unsupported,
  listSessions: unsupported,
  chatDirectories: unsupported,
  getSession: unsupported,
  loadMessages: unsupported,
  statuses: unsupported,
  backgroundTasks: unsupported,
  checklist: unsupported,
  plan: unsupported,
  codexTodos: unsupported,
  sessionTasks: unsupported,
  taskOutput: unsupported,
  stopTask: unsupported,
  questions: unsupported,
  createSession: unsupported,
  prompt: unsupported,
  abort: unsupported,
  compact: unsupported,
  replyQuestion: unsupported,
  rejectQuestion: unsupported,
  revert: unsupported,
  unrevert: unsupported,
  fork: unsupported,
  updateSession: unsupported,
  deleteSession: unsupported,
  ...methods,
});

/**
 * Web runtime APIs carrying `nativeAgents`, plus the sidebar state a session
 * deletion clears when a test supplies it; touching any other API throws.
 */
export const createTestRuntimeAPIs = (
  nativeAgents: NativeAgentsAPI,
  others: Partial<Pick<RuntimeAPIs, 'sidebarState'>> = {},
): RuntimeAPIs => ({
  runtime: { platform: 'web', isDesktop: false, isVSCode: false },
  get terminal() { return untouchable(); },
  get git() { return untouchable(); },
  get files() { return untouchable(); },
  get settings() { return untouchable(); },
  get permissions() { return untouchable(); },
  get notifications() { return untouchable(); },
  get sourceControl() { return untouchable(); },
  get sidebarState() { return others.sidebarState ?? untouchable(); },
  get followUpQueue() { return untouchable(); },
  nativeAgents,
});
