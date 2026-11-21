export interface NativeAgentErrorDetails {
  code: string;
  status: number;
}

export class NativeAgentError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, { code, status }: NativeAgentErrorDetails) {
    super(message);
    this.name = 'NativeAgentError';
    this.code = code;
    this.status = status;
  }
}

export const cliMissingError = (cli: string): NativeAgentError => new NativeAgentError(
  `The ${cli} CLI was not found on this machine's PATH`,
  { code: 'NATIVE_CLI_MISSING', status: 503 },
);

export const claudeShimError = (executable: string): NativeAgentError => new NativeAgentError(
  `Claude Code at ${executable} is an npm shim, which cannot be started on Windows without a shell. Install the native Claude Code build (claude.exe) and try again.`,
  { code: 'NATIVE_CLI_SHIM', status: 503 },
);

export const sessionNotFoundError = (sessionId: string): NativeAgentError => new NativeAgentError(
  `Native session not found: ${sessionId}`,
  { code: 'NATIVE_SESSION_NOT_FOUND', status: 404 },
);

export const invalidRequestError = (message: string): NativeAgentError => new NativeAgentError(message, { code: 'NATIVE_INVALID_REQUEST', status: 400 });

export const messageNotFoundError = (messageId: string): NativeAgentError => new NativeAgentError(
  `Message not found in the native session: ${messageId}`,
  { code: 'NATIVE_MESSAGE_NOT_FOUND', status: 404 },
);

export const sessionBusyError = (): NativeAgentError => new NativeAgentError(
  'The native session is still running a turn',
  { code: 'NATIVE_SESSION_BUSY', status: 409 },
);

export const revertFirstMessageError = (): NativeAgentError => new NativeAgentError(
  'Claude Code cannot revert the first message of a session',
  { code: 'NATIVE_REVERT_FIRST_MESSAGE', status: 409 },
);

export const rewindBeforeCompactionError = (): NativeAgentError => new NativeAgentError(
  'Claude Code cannot revert or fork from a message before the last compaction',
  { code: 'NATIVE_REWIND_BEFORE_COMPACTION', status: 409 },
);

export const revertMidTurnError = (): NativeAgentError => new NativeAgentError(
  'Codex can only revert or fork from the first message of a turn',
  { code: 'NATIVE_REVERT_MID_TURN', status: 409 },
);

export const deleteForkSourceError = (): NativeAgentError => new NativeAgentError(
  'Codex keeps this thread while its forks still use it',
  { code: 'NATIVE_DELETE_FORK_SOURCE', status: 409 },
);
