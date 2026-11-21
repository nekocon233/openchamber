import { reapOrphanedProcesses } from './managed-process-registry.js';
import { topUpV1Migration } from './v1-migration-topup.js';
import type { Application } from '../shared/http-contracts.js';
import type { DiagnosticJournal } from '../diagnostics/contracts.js';
import type { EnvironmentVariables, ProcessEnvironment } from '../environment/variables.js';
import type {
  ManagedOpenCodeProcess,
  OpenCodeLaunchDiagnostics,
  OpenCodeHealthFailureSnapshot,
  ManagedOpenCodeProcessSnapshot,
  OpenCodeRestartDiagnostics,
} from './lifecycle.js';

export interface OpenCodeLifecycleState {
  openCodeProcess: ManagedOpenCodeProcess | null;
  openCodePort: number | null;
  openCodeBaseUrl: string | null;
  openCodeWorkingDirectory: string;
  currentRestartPromise: Promise<void> | null;
  isRestartingOpenCode: boolean;
  openCodeApiPrefix: string;
  openCodeApiPrefixDetected: boolean;
  openCodeApiDetectionTimer: ReturnType<typeof setTimeout> | null;
  lastOpenCodeError: unknown;
  lastOpenCodeLaunchDiagnostics: OpenCodeLaunchDiagnostics | null;
  lastOpenCodeHealthFailure: OpenCodeHealthFailureSnapshot | null;
  lastManagedOpenCodeProcess: ManagedOpenCodeProcessSnapshot | null;
  lastOpenCodeRestartDiagnostics: OpenCodeRestartDiagnostics | null;
  isOpenCodeReady: boolean;
  openCodeNotReadySince: number;
  isExternalOpenCode: boolean;
  isShuttingDown: boolean;
  healthCheckInterval: ReturnType<typeof setInterval> | null;
  expressApp: Application | null;
  useWslForOpencode: boolean;
}

export interface ManagedOpenCodeLaunchSpec {
  binary: string;
  args: string[];
  wrapperType?: string | null;
  env?: ProcessEnvironment;
}

export interface OpenCodeLifecycleDependencies {
  state: OpenCodeLifecycleState;
  env: {
    ENV_CONFIGURED_OPENCODE_PORT: number | null;
    ENV_CONFIGURED_OPENCODE_HOST?: { origin: string; port: number } | null;
    ENV_EFFECTIVE_PORT?: number | null;
    ENV_CONFIGURED_OPENCODE_HOSTNAME: string;
    ENV_SKIP_OPENCODE_START?: boolean;
  };
  syncToHmrState: () => void;
  syncFromHmrState: () => void;
  getOpenCodeAuthHeaders: () => Record<string, string>;
  buildOpenCodeUrl: (route: string, prefixOverride?: string) => string;
  waitForReady: (url: string, timeoutMs: number) => Promise<boolean>;
  normalizeApiPrefix: (prefix: string) => string;
  applyOpencodeBinaryFromSettings: (options?: { strict: boolean }) => Promise<string | null | void>;
  ensureOpencodeCliEnv: () => string | null | undefined;
  ensureLocalOpenCodeServerPassword: (options: { rotateManaged: boolean }) => Promise<string | null>;
  resolveManagedOpenCodeLaunchSpec: (binary: string | null | undefined) => ManagedOpenCodeLaunchSpec;
  setOpenCodePort: (port: number) => void;
  setDetectedOpenCodeApiPrefix: (prefix: string) => void;
  setupProxy: (app: Application) => void;
  ensureOpenCodeApiPrefix: () => void;
  clearResolvedOpenCodeBinary: () => void;
  buildAugmentedPath?: () => string;
  buildManagedOpenCodePath?: () => string;
  getManagedOpenCodeShellEnvSnapshot?: () => ProcessEnvironment | null;
  getManagedOpenCodeEnv?: () => Promise<ProcessEnvironment>;
  getUserEnvironment?: () => EnvironmentVariables;
  getActiveSessionCount?: () => number;
  reapManagedOrphanedProcesses?: typeof reapOrphanedProcesses;
  getWarmupDirectories?: () => Promise<Array<string | null>>;
  noProjectDirectory?: string | null;
  onOpenCodeRestarted?: (() => void) | null;
  managedStartupTimeoutMs?: number;
  now?: () => number;
  topUpV1SessionMigration?: typeof topUpV1Migration;
  checkOpenCodeBinary?: (launch: ManagedOpenCodeLaunchSpec) => Promise<string>;
  diagnosticJournal?: DiagnosticJournal;
}

export interface ManagedOpenCodeServerOptions {
  resolvedBinary: string | null | undefined;
  hostname: string;
  port: number;
  timeout: number;
  cwd: string;
  env: ProcessEnvironment;
  shellEnvKeysCount?: number;
  attempt: number;
}

export const hasErrorFields = (cause: unknown): cause is { name?: unknown; code?: unknown; message?: unknown } => cause != null;

export const optionalErrorFields = <Cause>(cause: Cause) => hasErrorFields(cause) ? cause : undefined;

const OPENCODE_REQUIRED_MAJOR_VERSION = 2;

export const OPENCODE_VERSION_REQUIREMENT_DETAIL =
  `OpenChamber requires OpenCode ${OPENCODE_REQUIRED_MAJOR_VERSION}.x`;

export const classifyOpenCodeVersion = (version: string | undefined): { ok: true } | { ok: false; detail: string } => {
  if (version === undefined) return { ok: true };
  const match = version.match(/v?(\d+)\./);
  if (!match) return { ok: true };
  if (Number(match[1]) >= OPENCODE_REQUIRED_MAJOR_VERSION) return { ok: true };
  return {
    ok: false,
    detail: `${OPENCODE_VERSION_REQUIREMENT_DETAIL}, found ${version.trim()}. Update OpenCode and start OpenChamber again.`,
  };
};

export const WARMUP_DIRECTORY_LIMIT = 1;

export const WARMUP_REQUEST_TIMEOUT_MS = 30000;

export const MANAGED_STDERR_TAIL_MAX_BYTES = 32 * 1024;

export const HEALTH_FAILURE_DETAIL_MAX_LENGTH = 256;

export const getBoundedTextTail = (value: string | null | undefined, maxBytes: number) => {
  const buffer = Buffer.from(String(value ?? ''));
  if (buffer.byteLength <= maxBytes) return buffer.toString();
  return buffer.subarray(buffer.byteLength - maxBytes).toString();
};

export const sanitizeDiagnosticText = (value: string | null | undefined) => String(value ?? '')
  .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[redacted]@')
  .replace(/\b(Bearer)\s+[^\s,;]+/gi, '$1 [redacted]')
  .replace(
    /(^|[\s,{[])((?:"|')?[a-z0-9_.-]{0,80}authorization[a-z0-9_.-]{0,80}(?:"|')?\s*[:=]\s*(?:"|')?(?:basic|bearer|token)\s+)[^\s,;"']+/gim,
    '$1$2[redacted]',
  )
  .replace(/([?&][^=&#\s]*(?:token|api[_-]?key|password|secret|authorization|credential|private[_-]?key)[^=&#\s]*=)[^&#\s]+/gi, '$1[redacted]')
  .replace(
    /(^|[\s,{[])((?:"|')?[a-z0-9_.-]{0,80}(?:token|api[_-]?key|password|secret|authorization|credential|private[_-]?key)[a-z0-9_.-]{0,80}(?:"|')?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gim,
    '$1$2[redacted]',
  );

const getHealthFailureDetail = (cause: unknown) => {
  const name = String(optionalErrorFields(cause)?.name || 'Error');
  const message = String(optionalErrorFields(cause)?.message || cause || 'Unknown error');
  return sanitizeDiagnosticText(`${name}: ${message}`).slice(0, HEALTH_FAILURE_DETAIL_MAX_LENGTH);
};

export const classifyHealthProbeError = (cause: unknown) => {
  const name = String(optionalErrorFields(cause)?.name || '');
  const code = String(optionalErrorFields(cause)?.code || '').toUpperCase();
  const message = String(optionalErrorFields(cause)?.message || cause || '');
  const normalizedMessage = message.toLowerCase();

  if (
    name === 'AbortError'
    || name === 'TimeoutError'
    || normalizedMessage.includes('the operation was aborted')
    || normalizedMessage.includes('abortsignal.timeout')
  ) {
    return { class: 'timeout', detail: getHealthFailureDetail(cause) };
  }
  if (code === 'ECONNREFUSED' || normalizedMessage.includes('econnrefused')) {
    return { class: 'connection_refused', detail: getHealthFailureDetail(cause) };
  }
  if (
    code === 'ECONNRESET'
    || normalizedMessage.includes('econnreset')
    || normalizedMessage.includes('socket hang up')
  ) {
    return { class: 'connection_reset', detail: getHealthFailureDetail(cause) };
  }
  return { class: 'error', detail: getHealthFailureDetail(cause) };
};
