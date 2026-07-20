import { spawn } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { domainToASCII } from 'url';

export const FRPC_DEFAULT_STARTUP_TIMEOUT_MS = 20000;
export const FRPC_DEFAULT_STOP_GRACE_TIMEOUT_MS = 5000;
export const FRPC_DEFAULT_STOP_FORCE_TIMEOUT_MS = 2000;
const FRPC_TOKEN_MAX_LENGTH = 8192;
const FRPC_TRUSTED_CA_MAX_BYTES = 1024 * 1024;

const FRPC_PROXY_NAME_PREFIX = 'openchamber';
const MAX_DIAGNOSTIC_LINES = 16;
const MAX_DIAGNOSTIC_LINE_LENGTH = 600;
const diagnosticBufferLimit = (secret) => MAX_DIAGNOSTIC_LINE_LENGTH + String(secret || '').length;

const tomlString = (value) => JSON.stringify(value);

export function normalizeFrpcServerAddress(value) {
  if (typeof value !== 'string') {
    throw new Error('FRPS server address is required');
  }
  const raw = value.trim();
  if (!raw || raw.includes('://') || /[\s/?#@\\]/.test(raw) || raw.endsWith('.')) {
    throw new Error('FRPS server address must be an IP address or bare hostname without a scheme, port, or path');
  }

  const bracketedAddress = raw.startsWith('[') && raw.endsWith(']')
    ? raw.slice(1, -1)
    : raw;
  if (net.isIP(bracketedAddress) !== 0) {
    return bracketedAddress.toLowerCase();
  }
  if (raw.includes(':') || raw.includes('[') || raw.includes(']')) {
    throw new Error('FRPS server address must be a valid IP address or hostname');
  }

  const address = domainToASCII(raw).toLowerCase();
  if (!address || address.length > 253) {
    throw new Error('FRPS server address must be a valid IP address or hostname');
  }
  const labels = address.split('.');
  if (labels.some((label) => (
    label.length === 0
    || label.length > 63
    || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  ))) {
    throw new Error('FRPS server address must be a valid IP address or hostname');
  }
  return address;
}

export function normalizeFrpcTrustedCaFile(value, home = os.homedir()) {
  if (typeof value !== 'string' || !value.trim()) {
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

export function loadFrpcTrustedCaFile(value, {
  home = os.homedir(),
  fsImpl = fs,
} = {}) {
  const trustedCaFile = normalizeFrpcTrustedCaFile(value, home);
  let stats;
  try {
    stats = fsImpl.statSync(trustedCaFile);
  } catch (error) {
    throw new Error(`Could not read FRPS trusted CA file: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!stats.isFile()) {
    throw new Error('FRPS trusted CA file must be a regular file');
  }
  if (stats.size === 0 || stats.size > FRPC_TRUSTED_CA_MAX_BYTES) {
    throw new Error(`FRPS trusted CA file must contain between 1 and ${FRPC_TRUSTED_CA_MAX_BYTES} bytes`);
  }

  let contents;
  try {
    contents = fsImpl.readFileSync(trustedCaFile);
  } catch (error) {
    throw new Error(`Could not read FRPS trusted CA file: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (contents.length === 0 || contents.length > FRPC_TRUSTED_CA_MAX_BYTES) {
    throw new Error(`FRPS trusted CA file must contain between 1 and ${FRPC_TRUSTED_CA_MAX_BYTES} bytes`);
  }
  return { path: trustedCaFile, contents };
}

const normalizeFrpcDnsHostname = (value, label) => {
  if (typeof value !== 'string') {
    throw new Error(`${label} is required`);
  }
  const raw = value.trim();
  if (
    !raw
    || raw.includes('://')
    || /[\s/:?#@\\*\[\]]/.test(raw)
    || raw.endsWith('.')
  ) {
    throw new Error(`${label} must be a bare DNS hostname without a scheme, port, path, wildcard, or trailing dot`);
  }

  const hostname = domainToASCII(raw).toLowerCase();
  if (!hostname || hostname.length > 253 || net.isIP(hostname) !== 0) {
    throw new Error(`${label} must be a valid DNS hostname`);
  }
  const labels = hostname.split('.');
  if (labels.some((entry) => (
    entry.length === 0
    || entry.length > 63
    || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(entry)
  ))) {
    throw new Error(`${label} must be a valid DNS hostname`);
  }
  return hostname;
};

export const normalizeFrpcCustomDomain = (value) => normalizeFrpcDnsHostname(value, 'FRPS custom domain');
export const normalizeFrpcPublicHostname = (value) => normalizeFrpcDnsHostname(value, 'FRPC public hostname');
export const normalizeFrpcPublicUrl = (value) => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('FRPC TCP public HTTPS URL is required');
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error('FRPC TCP public URL must be a valid HTTPS origin');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('FRPC TCP public URL must use https://');
  }
  if (parsed.username || parsed.password) {
    throw new Error('FRPC TCP public URL must not contain credentials');
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.origin === 'null') {
    throw new Error('FRPC TCP public URL must be an origin without a path, query, or fragment');
  }
  return parsed.origin;
};

export const normalizeFrpcToken = (value) => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('FRPC token is required');
  }
  const token = value.trim();
  if (/[\0\r\n]/.test(token)) {
    throw new Error('FRPC token must be a single non-empty line');
  }
  if (token.length > FRPC_TOKEN_MAX_LENGTH) {
    throw new Error(`FRPC token must not exceed ${FRPC_TOKEN_MAX_LENGTH} characters`);
  }
  return token;
};

const normalizeFrpcPort = (value, label) => {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${label} must be an integer between 1 and 65535`);
  }
  return value;
};

export const normalizeFrpcServerPort = (value) => normalizeFrpcPort(value, 'FRPS server port');
export const normalizeFrpcLocalPort = (value) => normalizeFrpcPort(value, 'OpenChamber local port');
export const normalizeFrpcRemotePort = (value) => normalizeFrpcPort(value, 'FRPS remote port');

export function normalizeFrpcEndpoint({ remotePort, customDomain, hostname, publicUrl, proxyType } = {}) {
  const normalizedProxyType = typeof proxyType === 'string' ? proxyType.trim().toLowerCase() : '';
  if (normalizedProxyType && normalizedProxyType !== 'tcp' && normalizedProxyType !== 'http') {
    throw new Error(`Unsupported FRPC proxy type: ${proxyType}`);
  }

  const hasRemotePort = remotePort !== undefined && remotePort !== null;
  const hasCustomDomain = typeof customDomain === 'string' && customDomain.trim().length > 0;
  const hasPublicUrl = typeof publicUrl === 'string' && publicUrl.trim().length > 0;
  if (hasRemotePort && hasCustomDomain) {
    throw new Error('FRPC remotePort and customDomain cannot be used together');
  }
  if (hasCustomDomain && hasPublicUrl) {
    throw new Error('FRPC TCP publicUrl and HTTP customDomain cannot be used together');
  }
  if (normalizedProxyType === 'tcp' && hasCustomDomain) {
    throw new Error('FRPC TCP proxies cannot use customDomain');
  }
  if (normalizedProxyType === 'http' && (hasRemotePort || hasPublicUrl)) {
    throw new Error('FRPC HTTP proxies cannot use remotePort or publicUrl');
  }

  if (hasCustomDomain || normalizedProxyType === 'http') {
    const normalizedCustomDomain = normalizeFrpcCustomDomain(customDomain);
    const normalizedHostname = normalizeFrpcPublicHostname(hostname);
    return {
      proxyType: 'http',
      remotePort: null,
      customDomain: normalizedCustomDomain,
      hostname: normalizedHostname,
      publicUrl: null,
    };
  }

  if (!hasRemotePort) {
    throw new Error('FRPS remote port or custom domain is required');
  }
  return {
    proxyType: 'tcp',
    remotePort: normalizeFrpcRemotePort(remotePort),
    customDomain: null,
    hostname: null,
    publicUrl: normalizeFrpcPublicUrl(publicUrl),
  };
}

const createFrpcProxyName = (endpoint) => endpoint.proxyType === 'tcp'
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
}) {
  const normalizedServerAddress = normalizeFrpcServerAddress(serverAddress);
  const normalizedServerPort = normalizeFrpcServerPort(serverPort);
  const normalizedLocalPort = normalizeFrpcLocalPort(localPort);
  const normalizedTrustedCaFile = normalizeFrpcTrustedCaFile(trustedCaFile);
  const endpoint = normalizeFrpcEndpoint({ remotePort, customDomain, hostname, publicUrl, proxyType });
  const proxyName = createFrpcProxyName(endpoint);
  if (typeof tokenFilePath !== 'string' || !path.isAbsolute(tokenFilePath)) {
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

const createChildEnv = (env, token) => {
  const childEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') {
      continue;
    }
    if (key === 'OPENCHAMBER_TUNNEL_TOKEN' || key === 'FRP_TOKEN' || value.trim() === token) {
      continue;
    }
    childEnv[key] = value;
  }
  return childEnv;
};

const redactDiagnostic = (value, secrets) => {
  let text = String(value).replace(/\x1b\[[0-9;]*m/g, '').trim();
  for (const secret of secrets) {
    if (secret) {
      text = text.split(secret).join('[redacted]');
    }
  }
  return text.slice(-MAX_DIAGNOSTIC_LINE_LENGTH);
};

const createStartupError = (message, diagnostics) => {
  const usefulDiagnostics = diagnostics.filter(Boolean).slice(-MAX_DIAGNOSTIC_LINES);
  return new Error(usefulDiagnostics.length > 0
    ? `${message} Last FRPC output: ${usefulDiagnostics.join(' | ')}`
    : `${message} FRPC produced no diagnostic output.`);
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

async function waitForFrpcReady(child, { timeoutMs, token, proxyName }) {
  const escapedProxyName = proxyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const readyPattern = new RegExp(`\\[${escapedProxyName}\\]\\s+start proxy success\\b`, 'i');
  const proxyStartErrorPattern = new RegExp(`\\[${escapedProxyName}\\]\\s+start error:`, 'i');
  await new Promise((resolve, reject) => {
    let settled = false;
    const diagnostics = [];
    const buffers = new Map();

    const finish = (handler, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      child.off('error', onError);
      child.off('exit', onExit);
      handler(value);
    };

    const recordDiagnostic = (line) => {
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

    const inspectLine = (rawLine, includeDiagnostic = true) => {
      const rawText = String(rawLine).replace(/\x1b\[[0-9;]*m/g, '').trim();
      const safeLine = redactDiagnostic(rawText, [token]);
      if (!rawText) {
        return;
      }
      if (includeDiagnostic) {
        recordDiagnostic(safeLine);
      }
      if (readyPattern.test(rawText)) {
        finish(resolve);
        return;
      }
      if (proxyStartErrorPattern.test(rawText) || FATAL_PATTERNS.some((pattern) => pattern.test(rawText))) {
        recordDiagnostic(safeLine);
        finish(reject, createStartupError('FRPC failed before the OpenChamber proxy became ready.', diagnostics));
      }
    };

    const consume = (streamName, chunk) => {
      const prior = buffers.get(streamName) ?? '';
      const combined = `${prior}${chunk.toString('utf8')}`;
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

    const onStdout = (chunk) => consume('stdout', chunk);
    const onStderr = (chunk) => consume('stderr', chunk);
    const onError = (error) => {
      const safeError = redactDiagnostic(error instanceof Error ? error.message : String(error), [token]);
      finish(reject, createStartupError(`Could not launch FRPC: ${safeError}.`, diagnostics));
    };
    const onExit = (code, signal) => {
      finish(reject, createStartupError(
        `FRPC exited before readiness (code ${code ?? 'unknown'}, signal ${signal ?? 'none'}).`,
        diagnostics
      ));
    };

    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.once('error', onError);
    child.once('exit', onExit);

    const timeout = setTimeout(() => {
      finish(reject, createStartupError(
        `Timed out after ${timeoutMs}ms waiting for FRPC to report proxy readiness.`,
        diagnostics
      ));
    }, timeoutMs);
  });
}

function attachFrpcRuntimeLogging(child, { token, onLog }) {
  const buffers = new Map();
  const emit = (streamName, rawLine) => {
    const line = redactDiagnostic(rawLine, [token]);
    if (!line) {
      return;
    }
    try {
      onLog?.(streamName, line);
    } catch {
      // Logging must never affect the tunnel process lifecycle.
    }
  };
  const consume = (streamName, chunk) => {
    const prior = buffers.get(streamName) ?? '';
    const combined = `${prior}${chunk.toString('utf8')}`;
    const lines = combined.split(/\r?\n/);
    buffers.set(streamName, (lines.pop() ?? '').slice(-diagnosticBufferLimit(token)));
    for (const line of lines) {
      emit(streamName, line);
    }
  };
  const onStdout = (chunk) => consume('stdout', chunk);
  const onStderr = (chunk) => consume('stderr', chunk);
  child.stdout?.on('data', onStdout);
  child.stderr?.on('data', onStderr);

  return {
    flush() {
      // Incomplete lines may contain only a fragment of a secret, which cannot
      // be safely matched and redacted without the remainder of the line.
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
  trustedCaFile,
  startupTimeoutMs = FRPC_DEFAULT_STARTUP_TIMEOUT_MS,
  stopGraceTimeoutMs = FRPC_DEFAULT_STOP_GRACE_TIMEOUT_MS,
  stopForceTimeoutMs = FRPC_DEFAULT_STOP_FORCE_TIMEOUT_MS,
  tempRoot = os.tmpdir(),
  env = process.env,
  spawnImpl = spawn,
  onExit,
  onLog = (streamName, line) => console.log(`[frpc:${streamName}] ${line}`),
}) {
  if (typeof binaryPath !== 'string' || !path.isAbsolute(binaryPath)) {
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
  const trustedCa = loadFrpcTrustedCaFile(trustedCaFile);
  const normalizedTrustedCaFile = trustedCa.path;
  const endpoint = normalizeFrpcEndpoint({ remotePort, customDomain, hostname, publicUrl, proxyType });
  const proxyName = createFrpcProxyName(endpoint);
  const browserPublicUrl = endpoint.proxyType === 'http'
    ? `https://${endpoint.hostname}`
    : endpoint.publicUrl;
  const trustedCaContents = trustedCa.contents;

  let tempDirectory = null;
  let child = null;
  let running = false;
  let processEnded = false;
  let processExitPromise = null;
  let resolveProcessExit = null;
  let stopPromise = null;
  let terminateProcess = null;
  let runtimeLogging = null;
  let parentExitHandler = null;
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

    child = spawnImpl(binaryPath, ['-c', configFilePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
      env: createChildEnv(env, normalizedToken),
    });

    processExitPromise = new Promise((resolve) => {
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
        // Consumer callbacks must not turn a confirmed child exit into a hang.
      }
    };
    child.once('exit', handleProcessEnd);
    child.once('close', handleProcessEnd);
    child.once('error', () => {
      if (!child?.pid) {
        handleProcessEnd();
      }
    });
    parentExitHandler = () => {
      if (!processEnded) {
        try {
          child?.kill('SIGKILL');
        } catch {
        }
        try {
          cleanup();
        } catch {
        }
      }
    };
    process.once('exit', parentExitHandler);

    const waitForProcessEnd = async (timeoutMs) => {
      if (processEnded) {
        return true;
      }
      let timeout;
      try {
        return await Promise.race([
          processExitPromise.then(() => true),
          new Promise((resolve) => {
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
    terminateProcess = async () => {
      if (processEnded) {
        return;
      }
      try {
        child.kill('SIGTERM');
      } catch {
      }
      if (await waitForProcessEnd(stopGraceTimeoutMs)) {
        return;
      }
      try {
        child.kill('SIGKILL');
      } catch {
      }
      if (!(await waitForProcessEnd(stopForceTimeoutMs))) {
        throw new Error(
          `FRPC did not terminate after ${stopGraceTimeoutMs}ms grace and ${stopForceTimeoutMs}ms force timeouts`
        );
      }
    };

    await waitForFrpcReady(child, { timeoutMs: startupTimeoutMs, token: normalizedToken, proxyName });
    runtimeLogging = attachFrpcRuntimeLogging(child, { token: normalizedToken, onLog });
    running = !processEnded;
    if (!running) {
      throw new Error('FRPC exited immediately after reporting proxy readiness');
    }

    return {
      process: child,
      serverAddress: normalizedServerAddress,
      serverPort: normalizedServerPort,
      trustedCaFile: normalizedTrustedCaFile,
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
          stopPromise = terminateProcess();
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
      getTrustedCaFile: () => normalizedTrustedCaFile,
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
          `${error instanceof Error ? error.message : String(error)} ` +
          `FRPC cleanup also failed: ${terminationError instanceof Error ? terminationError.message : String(terminationError)}`,
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
