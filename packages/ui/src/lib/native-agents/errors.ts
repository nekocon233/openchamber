import type { I18nKey } from '@/lib/i18n';

/** A native session request the OpenChamber server answered with an error. */
export class NativeAgentsRequestError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = 'NativeAgentsRequestError';
    this.status = status;
    this.code = code;
  }
}

/** The runtime has no OpenChamber server to host native sessions (VS Code). */
export class NativeAgentsUnsupportedError extends Error {
  constructor() {
    super('Native CLI sessions are not available in this runtime');
    this.name = 'NativeAgentsUnsupportedError';
  }
}

/** Stable server codes, translated by the surface that displays the failure. */
export const nativeSessionActionErrorKey = (error: NativeAgentsRequestError): I18nKey | null => {
  if (error.code === 'NATIVE_DEEPSEEK_MAINTENANCE_BUSY') return 'sessions.sidebar.session.action.deepseekBusy';
  if (error.code === 'NATIVE_DEEPSEEK_WRITER_HELD') return 'sessions.sidebar.session.action.deepseekWriterHeld';
  if (error.code === 'NATIVE_DEEPSEEK_FORK_OUTCOME_UNKNOWN' || error.code === 'NATIVE_PROMPT_OUTCOME_UNKNOWN') return 'sessions.sidebar.session.action.deepseekUnconfirmed';
  if (error.code === 'NATIVE_DEEPSEEK_DELETE_CLEANUP_FAILED') return 'sessions.sidebar.session.action.deepseekCleanup';
  return null;
};
