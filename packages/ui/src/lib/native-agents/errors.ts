import type { I18nKey } from '@/lib/i18n';
import { isUnifiedNativeSessionId } from './ids';

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
export const nativeSessionActionErrorKey = (error: NativeAgentsRequestError, sessionId?: string | null): I18nKey | null => {
  if (sessionId && isUnifiedNativeSessionId(sessionId) && error.code === 'NATIVE_PROMPT_OUTCOME_UNKNOWN') return 'chat.unified.unconfirmed';
  if (error.code === 'NATIVE_CONVERSATION_MODEL_UNAVAILABLE') return 'chat.unified.modelUnavailable';
  if (error.code === 'NATIVE_CONVERSATION_SELECTION_CONFLICT') return 'chat.unified.selectionFailed';
  if (error.code === 'NATIVE_CONVERSATION_SUMMARY_UNAVAILABLE' || error.code === 'NATIVE_CONVERSATION_SUMMARY_INCOMPLETE' || error.code === 'NATIVE_CONVERSATION_CONTEXT_TOO_LARGE') return 'chat.unified.handoffFailed';
  if (error.code === 'NATIVE_CONVERSATION_STORAGE_UNAVAILABLE' || error.code === 'NATIVE_CONVERSATION_HISTORY_UNAVAILABLE') return 'chat.unified.historyUnavailable';
  if (error.code === 'NATIVE_CONVERSATION_DELETE_INCOMPLETE') return 'chat.unified.cleanupFailed';
  if (error.code === 'NATIVE_CONVERSATION_OWNS_SESSION') return 'chat.unified.managedSource';
  if (sessionId && isUnifiedNativeSessionId(sessionId) && error.code === 'enterprise_mode') return 'chat.unified.enterprise';
  if (error.code === 'NATIVE_DEEPSEEK_MAINTENANCE_BUSY') return 'sessions.sidebar.session.action.deepseekBusy';
  if (error.code === 'NATIVE_DEEPSEEK_WRITER_HELD') return 'sessions.sidebar.session.action.deepseekWriterHeld';
  if (error.code === 'NATIVE_DEEPSEEK_FORK_OUTCOME_UNKNOWN' || error.code === 'NATIVE_PROMPT_OUTCOME_UNKNOWN') return 'sessions.sidebar.session.action.deepseekUnconfirmed';
  if (error.code === 'NATIVE_DEEPSEEK_DELETE_CLEANUP_FAILED') return 'sessions.sidebar.session.action.deepseekCleanup';
  return null;
};
