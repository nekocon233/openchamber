import type { NativeAgentsAPI } from '@openchamber/ui/lib/api/types';
import { NativeAgentsUnsupportedError } from '@openchamber/ui/lib/native-agents/errors';

// VS Code talks to OpenCode directly and has no OpenChamber server to drive
// the native CLIs, so native sessions are unavailable here. Callers check
// `supported`; a call anyway fails explicitly instead of returning empty data.
const unsupported = async (): Promise<never> => {
  throw new NativeAgentsUnsupportedError();
};

export const createVSCodeNativeAgentsAPI = (): NativeAgentsAPI => ({
  supported: false,
  memoryStatus: unsupported,
  connectMemory: unsupported,
  disconnectMemory: unsupported,
  importMemory: unsupported,
  capabilities: unsupported,
  catalog: unsupported,
  cliproxyapiStatus: unsupported,
  startCliproxyapiGateway: unsupported,
  stopCliproxyapiGateway: unsupported,
  setCliproxyapiProxy: unsupported,
  beginCliproxyapiLogin: unsupported,
  cliproxyapiLoginStatus: unsupported,
  cancelCliproxyapiLogin: unsupported,
  removeCliproxyapiAccount: unsupported,
  saveCliproxyapiConnection: unsupported,
  cliproxyapiModels: unsupported,
  importCliproxyapiModels: unsupported,
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
});
