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
  capabilities: unsupported,
  catalog: unsupported,
  commands: unsupported,
  listSessions: unsupported,
  getSession: unsupported,
  loadMessages: unsupported,
  statuses: unsupported,
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
