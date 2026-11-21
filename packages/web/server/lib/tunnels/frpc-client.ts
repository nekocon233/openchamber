import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { isString, isCallable } from '../shared/object-guards.js';
import type { FrpcEndpointInput, FrpcNormalizedEndpoint } from './frpc-endpoint.js';
import {
  normalizeFrpcServerAddress,
  normalizeFrpcToken,
  normalizeFrpcServerPort,
  normalizeFrpcLocalPort,
  normalizeFrpcEndpoint,
} from './frpc-endpoint.js';

export const FRPC_DEFAULT_STARTUP_TIMEOUT_MS = 20000;
export const FRPC_DEFAULT_STOP_GRACE_TIMEOUT_MS = 5000;
export const FRPC_DEFAULT_STOP_FORCE_TIMEOUT_MS = 2000;
const FRPC_TRUSTED_CA_MAX_BYTES = 1024 * 1024;

const FRPC_PROXY_NAME_PREFIX = 'openchamber';
const FRPC_DEFAULT_CA_BUNDLE_PATHS = [
  path.join(os.homedir(), '.config', 'frp', 'ca.crt'),
  path.join(os.homedir(), '.frp', 'ca.crt'),
  '/etc/ssl/certs/ca-certificates.crt',
  '/etc/pki/tls/certs/ca-bundle.crt',
  '/etc/ssl/ca-bundle.pem',
  '/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem',
  '/usr/local/share/certs/ca-root-nss.crt',
  '/etc/ssl/cert.pem',
];
const MAX_DIAGNOSTIC_LINES = 16;
const MAX_DIAGNOSTIC_LINE_LENGTH = 600;
const diagnosticBufferLimit = (secret: string) => MAX_DIAGNOSTIC_LINE_LENGTH + String(secret || '').length;

const tomlString = (value: string) => JSON.stringify(value);

const hasErrorCode = (value: unknown): value is { code?: unknown } =>
  Boolean(value) && typeof value === 'object';

export type FrpcTlsImpl = {
  getCACertificates?: (type: 'default' | 'system' | 'bundled' | 'extra') => readonly string[];
  rootCertificates?: readonly string[];
};

export type FrpcFsImpl = Pick<typeof fs, 'statSync' | 'readFileSync'>;

export interface LoadFrpcDefaultTrustedCaOptions {
  tlsImpl?: FrpcTlsImpl;
  fsImpl?: FrpcFsImpl;
  env?: NodeJS.ProcessEnv;
}

export interface FrpcTrustedCaResult {
  source: 'host';
  sourcePath: null;
  contents: Buffer;
  certificateCount: number;
}

export interface BuildFrpcConfigInput extends FrpcEndpointInput {
  serverAddress: unknown;
  serverPort: unknown;
  localPort: unknown;
  tokenFilePath: unknown;
  trustedCaFile: unknown;
}

export interface StartFrpcClientInput extends FrpcEndpointInput {
  binaryPath: unknown;
  serverAddress: unknown;
  serverPort: unknown;
  token: unknown;
  localPort: unknown;
  startupTimeoutMs?: number;
  stopGraceTimeoutMs?: number;
  stopForceTimeoutMs?: number;
  tempRoot?: string;
  env?: NodeJS.ProcessEnv;
  tlsImpl?: FrpcTlsImpl;
  fsImpl?: FrpcFsImpl;
  spawnImpl?: typeof spawn;
  onExit?: (() => void) | undefined;
  onLog?: ((streamName: 'stdout' | 'stderr', line: string) => void) | undefined;
}

export interface FrpcClientController {
  provider?: string;
  mode?: string;
  process: ChildProcess;
  serverAddress: string;
  serverPort: number;
  proxyType: 'tcp' | 'http';
  remotePort: number | null;
  customDomain: string | null;
  hostname: string | null;
  publicUrl: string | null;
  stop: () => Promise<boolean>;
  isRunning: () => boolean;
  getPublicUrl: () => string | null;
  getServerAddress: () => string;
  getServerPort: () => number;
  getProxyType: () => 'tcp' | 'http';
  getRemotePort: () => number | null;
  getCustomDomain: () => string | null;
  getHostname: () => string | null;
  getConfiguredPublicUrl: () => string | null;
}

function normalizeFrpcTrustedCaFile(value: string | undefined, home = os.homedir()): string {
  if (!isString(value) || !value.trim()) {
    throw new Error('FRPS trusted CA file is required');
  }
  const raw = value.trim();
  if (raw.includes('\0')) {
    throw new Error('FRPS trusted CA file path is invalid');
  }
  if (raw === '~') {
    return home;
  }
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return path.resolve(home, raw.slice(2));
  }
  return path.resolve(raw);
}

const normalizeFrpcTrustedCaPem = (contents: Buffer | string, label: string): Buffer => {
  const text = Buffer.isBuffer(contents) ? contents.toString('utf8') : String(contents || '');
  const certificates = text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
  if (certificates.length === 0) {
    throw new Error(`${label} must contain PEM-encoded X.509 certificates`);
  }

  const normalizedCertificates: string[] = [];
  const seen = new Set<string>();
  for (const certificate of certificates) {
    const normalized = certificate.trim();
    try {
      new X509Certificate(normalized);
    } catch {
      throw new Error(`${label} must contain valid PEM-encoded X.509 certificates`);
    }
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    normalizedCertificates.push(normalized);
  }

  const normalizedContents = Buffer.from(`${normalizedCertificates.join('\n')}\n`, 'utf8');
  if (normalizedContents.length === 0 || normalizedContents.length > FRPC_TRUSTED_CA_MAX_BYTES) {
    throw new Error(`${label} must contain between 1 and ${FRPC_TRUSTED_CA_MAX_BYTES} bytes`);
  }
  return normalizedContents;
};

const appendFrpcTrustedCaPem = (certificates: string[], contents: Buffer | string, label: string): void => {
  const normalized = normalizeFrpcTrustedCaPem(contents, label).toString('utf8');
  for (const certificate of normalized.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || []) {
    const value = certificate.trim();
    if (!certificates.includes(value)) {
      certificates.push(value);
    }
  }
};

export function loadFrpcDefaultTrustedCa({
  tlsImpl = tls,
  fsImpl = fs,
  env = process.env,
}: LoadFrpcDefaultTrustedCaOptions = {}): FrpcTrustedCaResult {
  const certificates: string[] = [];
  if (isCallable(tlsImpl.getCACertificates)) {
    for (const type of ['system', 'default'] as const) {
      let typeCertificates: readonly string[];
      try {
        typeCertificates = tlsImpl.getCACertificates(type);
      } catch {
        continue;
      }
      for (const certificate of typeCertificates || []) {
        if (isString(certificate) && certificate.trim() && !certificates.includes(certificate.trim())) {
          certificates.push(certificate.trim());
        }
      }
    }
  }
  for (const certificate of Array.isArray(tlsImpl.rootCertificates) ? tlsImpl.rootCertificates : []) {
    if (isString(certificate) && certificate.trim() && !certificates.includes(certificate.trim())) {
      certificates.push(certificate.trim());
    }
  }

  const bundlePaths = [
    isString(env.SSL_CERT_FILE) ? env.SSL_CERT_FILE : '',
    isString(env.NODE_EXTRA_CA_CERTS) ? env.NODE_EXTRA_CA_CERTS : '',
    ...FRPC_DEFAULT_CA_BUNDLE_PATHS,
  ].filter(Boolean);
  for (const bundlePath of bundlePaths) {
    let stats: fs.Stats;
    try {
      stats = fsImpl.statSync(bundlePath);
    } catch (error) {
      if (hasErrorCode(error) && error.code === 'ENOENT') {
        continue;
      }
      throw new Error(`Could not read host CA certificate bundle '${bundlePath}'`);
    }
    if (!stats.isFile()) {
      continue;
    }
    appendFrpcTrustedCaPem(certificates, fsImpl.readFileSync(bundlePath), `Host CA certificate bundle '${bundlePath}'`);
  }

  if (certificates.length === 0) {
    throw new Error('Could not resolve host CA certificates for FRPS verification');
  }
  const contents = normalizeFrpcTrustedCaPem(certificates.join('\n'), 'Host CA certificates');
  return {
    source: 'host',
    sourcePath: null,
    contents,
    certificateCount: certificates.length,
  };
}

const createFrpcProxyName = (endpoint: FrpcNormalizedEndpoint): string => endpoint.proxyType === 'tcp'
  ? `${FRPC_PROXY_NAME_PREFIX}-${endpoint.remotePort}`
  : `${FRPC_PROXY_NAME_PREFIX}-http-${createHash('sha256').update(endpoint.customDomain).digest('hex').slice(0, 32)}`;

export function buildFrpcConfig({
  serverAddress,
  serverPort,
  localPort,
  remotePort,
  customDomain,
  hostname,
  publicUrl,
  proxyType,
  tokenFilePath,
  trustedCaFile,
}: BuildFrpcConfigInput): string {
  const normalizedServerAddress = normalizeFrpcServerAddress(serverAddress);
  const normalizedServerPort = normalizeFrpcServerPort(serverPort);
  const normalizedLocalPort = normalizeFrpcLocalPort(localPort);
  const normalizedTrustedCaFile = normalizeFrpcTrustedCaFile(isString(trustedCaFile) ? trustedCaFile : undefined);
  const endpoint = normalizeFrpcEndpoint({ remotePort, customDomain, hostname, publicUrl, proxyType });
  const proxyName = createFrpcProxyName(endpoint);
  if (!isString(tokenFilePath) || !path.isAbsolute(tokenFilePath)) {
    throw new Error('FRPC token file path must be absolute');
  }

  return [
    `serverAddr = ${tomlString(normalizedServerAddress)}`,
    `serverPort = ${normalizedServerPort}`,
    'loginFailExit = true',
    '',
    'log.to = "console"',
    'log.level = "info"',
    'log.disablePrintColor = true',
    '',
    'auth.method = "token"',
    'auth.additionalScopes = ["HeartBeats", "NewWorkConns"]',
    'auth.tokenSource.type = "file"',
    `auth.tokenSource.file.path = ${tomlString(tokenFilePath)}`,
    '',
    'transport.protocol = "tcp"',
    'transport.dialServerTimeout = 10',
    'transport.tls.enable = true',
    `transport.tls.trustedCaFile = ${tomlString(normalizedTrustedCaFile)}`,
    `transport.tls.serverName = ${tomlString(normalizedServerAddress)}`,
    '',
    '[[proxies]]',
    `name = ${tomlString(proxyName)}`,
    `type = ${tomlString(endpoint.proxyType)}`,
    'localIP = "127.0.0.1"',
    `localPort = ${normalizedLocalPort}`,
    ...(endpoint.proxyType === 'tcp'
      ? [`remotePort = ${endpoint.remotePort}`]
      : [`customDomains = [${tomlString(endpoint.customDomain)}]`]),
    '',
  ].join('\n');
}

const createChildEnv = (env: NodeJS.ProcessEnv, token: string): NodeJS.ProcessEnv => {
  const childEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!isString(value)) {
      continue;
    }
    if (key === 'OPENCHAMBER_TUNNEL_TOKEN' || key === 'FRP_TOKEN' || value.trim() === token) {
      continue;
    }
    childEnv[key] = value;
  }
  return childEnv;
};

const FRPC_ANSI_COLOR = new RegExp(String.raw`${String.fromCharCode(27)}\[[0-9;]*m`, 'g');

const redactDiagnostic = (value: string, secrets: string[]): string => {
  let text = value.replace(FRPC_ANSI_COLOR, '').trim();
  for (const secret of secrets) {
    if (secret) {
      text = text.split(secret).join('[redacted]');
    }
  }
  return text.slice(-MAX_DIAGNOSTIC_LINE_LENGTH);
};

const createStartupError = (message: string, diagnostics: string[]): Error => {
  const usefulDiagnostics = diagnostics.filter(Boolean).slice(-MAX_DIAGNOSTIC_LINES);
  const detail = usefulDiagnostics.some((line) => /session shutdown/i.test(line))
    ? `${message} FRPS closed the control session before readiness. Verify the FRPS address, control port, certificate SAN, and that any private CA is installed in the host trust store or ~/.config/frp/ca.crt.`
    : message;
  return new Error(usefulDiagnostics.length > 0
    ? `${detail} Last FRPC output: ${usefulDiagnostics.join(' | ')}`
    : `${detail} FRPC produced no diagnostic output.`);
};

const FATAL_PATTERNS = [
  /login to (?:the )?server failed/i,
  /connect to server error:/i,
  /authentication failed/i,
  /token in login doesn't match/i,
  /failed to (?:parse|load|unmarshal).*config/i,
  /unknown field/i,
  /x509:/i,
  /certificate (?:verify|verification|is not valid|signed by unknown)/i,
];

async function waitForFrpcReady(
  child: ChildProcess,
  { timeoutMs, token, proxyName }: { timeoutMs: number; token: string; proxyName: string },
): Promise<void> {
  const escapedProxyName = proxyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const readyPattern = new RegExp(`\\[${escapedProxyName}\\]\\s+start proxy success\\b`, 'i');
  const proxyStartErrorPattern = new RegExp(`\\[${escapedProxyName}\\]\\s+start error:`, 'i');
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const diagnostics: string[] = [];
    const buffers = new Map<'stdout' | 'stderr', string>();

    const finishSuccess = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      child.off('error', onError);
      child.off('exit', onExit);
      resolve();
    };

    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      child.off('error', onError);
      child.off('exit', onExit);
      reject(error);
    };

    const recordDiagnostic = (line: string) => {
      if (!line) {
        return;
      }
      if (diagnostics.at(-1) !== line) {
        diagnostics.push(line);
        if (diagnostics.length > MAX_DIAGNOSTIC_LINES) {
          diagnostics.shift();
        }
      }
    };

    const inspectLine = (rawLine: string, includeDiagnostic = true) => {
      const rawText = String(rawLine).replace(FRPC_ANSI_COLOR, '').trim();
      const safeLine = redactDiagnostic(rawText, [token]);
      if (!rawText) {
        return;
      }
      if (includeDiagnostic) {
        recordDiagnostic(safeLine);
      }
      if (readyPattern.test(rawText)) {
        finishSuccess();
        return;
      }
      if (proxyStartErrorPattern.test(rawText) || FATAL_PATTERNS.some((pattern) => pattern.test(rawText))) {
        recordDiagnostic(safeLine);
        finishError(createStartupError('FRPC failed before the OpenChamber proxy became ready.', diagnostics));
      }
    };

    const consume = (streamName: 'stdout' | 'stderr', chunk: Buffer | string) => {
      const prior = buffers.get(streamName) ?? '';
      const combined = `${prior}${Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)}`;
      const lines = combined.split(/\r?\n/);
      const pending = lines.pop() ?? '';
      buffers.set(streamName, pending.slice(-diagnosticBufferLimit(token)));
      for (const line of lines) {
        inspectLine(line);
        if (settled) {
          return;
        }
      }
    };

    const onStdout = (chunk: Buffer | string) => consume('stdout', chunk);
    const onStderr = (chunk: Buffer | string) => consume('stderr', chunk);
    const onError = (cause: unknown) => {
      const safeError = redactDiagnostic(cause instanceof Error ? cause.message : String(cause), [token]);
      finishError(createStartupError(`Could not launch FRPC: ${safeError}.`, diagnostics));
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finishError(createStartupError(
        `FRPC exited before readiness (code ${code ?? 'unknown'}, signal ${signal ?? 'none'}).`,
        diagnostics
      ));
    };

    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.once('error', onError);
    child.once('exit', onExit);

    const timeout = setTimeout(() => {
      finishError(createStartupError(
        `Timed out after ${timeoutMs}ms waiting for FRPC to report proxy readiness.`,
        diagnostics
      ));
    }, timeoutMs);
  });
}

function attachFrpcRuntimeLogging(
  child: ChildProcess,
  { token, onLog }: { token: string; onLog?: ((streamName: 'stdout' | 'stderr', line: string) => void) | undefined },
) {
  const buffers = new Map<'stdout' | 'stderr', string>();
  const emit = (streamName: 'stdout' | 'stderr', rawLine: string) => {
    const line = redactDiagnostic(rawLine, [token]);
    if (!line) {
      return;
    }
    try {
      onLog?.(streamName, line);
    } catch {
      void 0;
    }
  };
  const consume = (streamName: 'stdout' | 'stderr', chunk: Buffer | string) => {
    const prior = buffers.get(streamName) ?? '';
    const combined = `${prior}${Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)}`;
    const lines = combined.split(/\r?\n/);
    buffers.set(streamName, (lines.pop() ?? '').slice(-diagnosticBufferLimit(token)));
    for (const line of lines) {
      emit(streamName, line);
    }
  };
  const onStdout = (chunk: Buffer | string) => consume('stdout', chunk);
  const onStderr = (chunk: Buffer | string) => consume('stderr', chunk);
  child.stdout?.on('data', onStdout);
  child.stderr?.on('data', onStderr);

  return {
    flush() {
      buffers.clear();
    },
    dispose() {
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      buffers.clear();
    },
  };
}

export async function startFrpcClient({
  binaryPath,
  serverAddress,
  serverPort,
  token,
  localPort,
  remotePort,
  customDomain,
  hostname,
  publicUrl,
  proxyType,
  startupTimeoutMs = FRPC_DEFAULT_STARTUP_TIMEOUT_MS,
  stopGraceTimeoutMs = FRPC_DEFAULT_STOP_GRACE_TIMEOUT_MS,
  stopForceTimeoutMs = FRPC_DEFAULT_STOP_FORCE_TIMEOUT_MS,
  tempRoot = os.tmpdir(),
  env = process.env,
  tlsImpl = tls,
  fsImpl = fs,
  spawnImpl = spawn,
  onExit,
  onLog = (streamName, line) => console.log(`[frpc:${streamName}] ${line}`),
}: StartFrpcClientInput): Promise<FrpcClientController> {
  if (!isString(binaryPath) || !path.isAbsolute(binaryPath)) {
    throw new Error('FRPC binary path must be absolute');
  }
  if (!Number.isInteger(startupTimeoutMs) || startupTimeoutMs <= 0) {
    throw new Error('FRPC startup timeout must be a positive integer');
  }
  if (!Number.isInteger(stopGraceTimeoutMs) || stopGraceTimeoutMs <= 0) {
    throw new Error('FRPC stop grace timeout must be a positive integer');
  }
  if (!Number.isInteger(stopForceTimeoutMs) || stopForceTimeoutMs <= 0) {
    throw new Error('FRPC stop force timeout must be a positive integer');
  }
  const normalizedServerAddress = normalizeFrpcServerAddress(serverAddress);
  const normalizedServerPort = normalizeFrpcServerPort(serverPort);
  const normalizedToken = normalizeFrpcToken(token);
  const normalizedLocalPort = normalizeFrpcLocalPort(localPort);
  const trustedCa = loadFrpcDefaultTrustedCa({ tlsImpl, fsImpl, env });
  const endpoint = normalizeFrpcEndpoint({ remotePort, customDomain, hostname, publicUrl, proxyType });
  const proxyName = createFrpcProxyName(endpoint);
  const browserPublicUrl = endpoint.proxyType === 'http'
    ? `https://${endpoint.hostname}`
    : endpoint.publicUrl;
  const trustedCaContents = trustedCa.contents;
  let tempDirectory: string | null = null;
  let child: ChildProcess | null = null;
  let running = false;
  let processEnded = false;
  let resolveProcessExit: (() => void) | null = null;
  let stopPromise: Promise<void> | null = null;
  let terminateProcess: (() => Promise<void>) | null = null;
  let runtimeLogging: ReturnType<typeof attachFrpcRuntimeLogging> | null = null;
  let parentExitHandler: (() => void) | null = null;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) {
      return;
    }
    if (tempDirectory) {
      fs.rmSync(tempDirectory, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      });
    }
    cleaned = true;
  };

  try {
    tempDirectory = fs.mkdtempSync(path.join(tempRoot, 'openchamber-frpc-'));
    fs.chmodSync(tempDirectory, 0o700);
    const tokenFilePath = path.join(tempDirectory, 'token');
    const trustedCaFilePath = path.join(tempDirectory, 'trusted-ca.pem');
    const configFilePath = path.join(tempDirectory, 'frpc.toml');
    const config = buildFrpcConfig({
      serverAddress: normalizedServerAddress,
      serverPort: normalizedServerPort,
      localPort: normalizedLocalPort,
      remotePort: endpoint.remotePort,
      customDomain: endpoint.customDomain,
      hostname: endpoint.hostname,
      publicUrl: endpoint.publicUrl,
      proxyType: endpoint.proxyType,
      tokenFilePath,
      trustedCaFile: trustedCaFilePath,
    });

    fs.writeFileSync(tokenFilePath, normalizedToken, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.writeFileSync(trustedCaFilePath, trustedCaContents, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(configFilePath, config, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.chmodSync(tokenFilePath, 0o600);
    fs.chmodSync(trustedCaFilePath, 0o600);
    fs.chmodSync(configFilePath, 0o600);

    const spawned = spawnImpl(binaryPath, ['-c', configFilePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
      env: createChildEnv(env, normalizedToken),
    });
    child = spawned;

    const exitPromise = new Promise<void>((resolve) => {
      resolveProcessExit = resolve;
    });
    const handleProcessEnd = () => {
      if (processEnded) {
        return;
      }
      processEnded = true;
      running = false;
      runtimeLogging?.flush();
      runtimeLogging?.dispose();
      runtimeLogging = null;
      if (parentExitHandler) {
        process.off('exit', parentExitHandler);
        parentExitHandler = null;
      }
      try {
        cleanup();
      } catch {
        console.warn('Failed to remove FRPC temporary credentials after process exit');
      }
      resolveProcessExit?.();
      try {
        onExit?.();
      } catch {
        void 0;
      }
    };
    spawned.once('exit', handleProcessEnd);
    spawned.once('close', handleProcessEnd);
    spawned.once('error', () => {
      if (!spawned.pid) {
        handleProcessEnd();
      }
    });
    parentExitHandler = () => {
      if (!processEnded) {
        try {
          spawned.kill('SIGKILL');
        } catch {
          void 0;
        }
        try {
          cleanup();
        } catch {
          void 0;
        }
      }
    };
    process.once('exit', parentExitHandler);

    const waitForProcessEnd = async (timeoutMs: number): Promise<boolean> => {
      if (processEnded) {
        return true;
      }
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          exitPromise.then(() => true),
          new Promise<boolean>((resolve) => {
            timeout = setTimeout(() => resolve(false), timeoutMs);
            timeout.unref?.();
          }),
        ]);
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
      }
    };
    const terminate = async () => {
      if (processEnded) {
        return;
      }
      try {
        spawned.kill('SIGTERM');
      } catch {
        void 0;
      }
      if (await waitForProcessEnd(stopGraceTimeoutMs)) {
        return;
      }
      try {
        spawned.kill('SIGKILL');
      } catch {
        void 0;
      }
      if (!(await waitForProcessEnd(stopForceTimeoutMs))) {
        throw new Error(
          `FRPC did not terminate after ${stopGraceTimeoutMs}ms grace and ${stopForceTimeoutMs}ms force timeouts`
        );
      }
    };
    terminateProcess = terminate;

    await waitForFrpcReady(spawned, { timeoutMs: startupTimeoutMs, token: normalizedToken, proxyName });
    runtimeLogging = attachFrpcRuntimeLogging(spawned, { token: normalizedToken, onLog });
    running = !processEnded;
    if (!running) {
      throw new Error('FRPC exited immediately after reporting proxy readiness');
    }

    return {
      process: spawned,
      serverAddress: normalizedServerAddress,
      serverPort: normalizedServerPort,
      proxyType: endpoint.proxyType,
      remotePort: endpoint.remotePort,
      customDomain: endpoint.customDomain,
      hostname: endpoint.hostname,
      publicUrl: endpoint.publicUrl,
      stop: async () => {
        const wasRunning = !processEnded;
        if (!wasRunning) {
          return false;
        }
        if (!stopPromise) {
          stopPromise = terminate();
        }
        try {
          await stopPromise;
        } catch (error) {
          stopPromise = null;
          throw error;
        }
        return wasRunning;
      },
      isRunning: () => running,
      getPublicUrl: () => (running ? browserPublicUrl : null),
      getServerAddress: () => normalizedServerAddress,
      getServerPort: () => normalizedServerPort,
      getProxyType: () => endpoint.proxyType,
      getRemotePort: () => endpoint.remotePort,
      getCustomDomain: () => endpoint.customDomain,
      getHostname: () => endpoint.hostname,
      getConfiguredPublicUrl: () => endpoint.publicUrl,
    };
  } catch (error) {
    if (child && !processEnded) {
      try {
        if (!stopPromise && terminateProcess) {
          stopPromise = terminateProcess();
        }
        await stopPromise;
      } catch (terminationError) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} `
          + `FRPC cleanup also failed: ${terminationError instanceof Error ? terminationError.message : String(terminationError)}`,
          { cause: error }
        );
      }
    }
    if (!child || processEnded) {
      cleanup();
    }
    throw error;
  }
}

export type { FrpcEndpointInput, FrpcNormalizedEndpoint } from './frpc-endpoint.js';
export {
  normalizeFrpcServerAddress,
  normalizeFrpcCustomDomain,
  normalizeFrpcPublicHostname,
  normalizeFrpcPublicUrl,
  normalizeFrpcToken,
  normalizeFrpcServerPort,
  normalizeFrpcLocalPort,
  normalizeFrpcRemotePort,
  normalizeFrpcEndpoint,
} from './frpc-endpoint.js';
