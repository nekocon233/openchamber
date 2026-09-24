// Errors the native runtime reports to routes. Each carries the HTTP status
// the route answers with and a stable code the UI can branch on.

export class NativeAgentError extends Error {
  /**
   * @param {string} message
   * @param {{ code: string, status: number }} details
   */
  constructor(message, { code, status }) {
    super(message);
    this.name = 'NativeAgentError';
    this.code = code;
    this.status = status;
  }
}

export const cliMissingError = (cli) => new NativeAgentError(
  `The ${cli} CLI was not found on this machine's PATH`,
  { code: 'NATIVE_CLI_MISSING', status: 503 },
);

export const claudeShimError = (executable) => new NativeAgentError(
  `Claude Code at ${executable} is an npm shim, which cannot be started on Windows without a shell. Install the native Claude Code build (claude.exe) and try again.`,
  { code: 'NATIVE_CLI_SHIM', status: 503 },
);

export const sessionNotFoundError = (sessionId) => new NativeAgentError(
  `Native session not found: ${sessionId}`,
  { code: 'NATIVE_SESSION_NOT_FOUND', status: 404 },
);

export const invalidRequestError = (message) => new NativeAgentError(message, { code: 'NATIVE_INVALID_REQUEST', status: 400 });


export const messageNotFoundError = (messageId) => new NativeAgentError(
  `Message not found in the native session: ${messageId}`,
  { code: 'NATIVE_MESSAGE_NOT_FOUND', status: 404 },
);

export const sessionBusyError = () => new NativeAgentError(
  'The native session is still running a turn',
  { code: 'NATIVE_SESSION_BUSY', status: 409 },
);

// Claude Code resumes at an entry it keeps, and its first prompt has none
// before it.
export const revertFirstMessageError = () => new NativeAgentError(
  'Claude Code cannot revert the first message of a session',
  { code: 'NATIVE_REVERT_FIRST_MESSAGE', status: 409 },
);

// Codex rewinds whole turns; a message steered into a running turn does not
// start one.
export const revertMidTurnError = () => new NativeAgentError(
  'Codex can only revert or fork from the first message of a turn',
  { code: 'NATIVE_REVERT_MID_TURN', status: 409 },
);

// Codex keeps a thread while threads forked from it still read its history.
export const deleteForkSourceError = () => new NativeAgentError(
  'Codex keeps this thread while its forks still use it',
  { code: 'NATIVE_DELETE_FORK_SOURCE', status: 409 },
);
