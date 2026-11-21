import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type fsModule from 'node:fs';
import type pathModule from 'node:path';

import { asNonEmptyString, isPlainObject, isRecord } from '../shared/guards.js';
import type { Application, Request } from '../shared/http-contracts.js';

interface LspServerSpec {
  readonly name: string;
  readonly bin: string;
  readonly args: readonly string[];
}

interface ResolvedLspServer {
  readonly name: string;
  readonly binaryPath: string;
  readonly args: readonly string[];
}

interface PendingLspRequest {
  readonly resolve: (value: LspResponsePayload | null) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface LspSession {
  readonly child: ChildProcess;
  closed: boolean;
  buffer: Buffer;
  readonly pending: Map<string, PendingLspRequest>;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

type LspResponsePayload = {
  id: string | number;
  jsonrpc?: string;
  result?: object | string | number | boolean | null;
  error?: object | string | number | boolean | null;
};

export interface LspRoutesDependencies {
  fs: Pick<typeof fsModule, 'statSync'>;
  path: Pick<typeof pathModule, 'join'>;
  spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  resolveProjectDirectory: (req: Request) => Promise<{ directory?: string | null } | null | undefined>;
  buildAugmentedPath?: (() => string) | undefined;
}

const SERVER_SPECS: Readonly<Record<string, readonly LspServerSpec[]>> = Object.freeze({
  csharp: [
    { name: 'csharp-ls', bin: 'csharp-ls', args: [] },
    { name: 'OmniSharp', bin: 'OmniSharp', args: ['-lsp'] },
  ],
  typescript: [
    { name: 'typescript-language-server', bin: 'typescript-language-server', args: ['--stdio'] },
  ],
  javascript: [
    { name: 'typescript-language-server', bin: 'typescript-language-server', args: ['--stdio'] },
  ],
  python: [
    { name: 'pyright-langserver', bin: 'pyright-langserver', args: ['--stdio'] },
  ],
  go: [
    { name: 'gopls', bin: 'gopls', args: ['serve'] },
  ],
  rust: [
    { name: 'rust-analyzer', bin: 'rust-analyzer', args: [] },
  ],
});

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 4000;

const isLspResponsePayload = (value: unknown): value is LspResponsePayload =>
  isRecord(value) && (typeof value.id === 'string' || typeof value.id === 'number');

const isBufferOrUint8Array = (value: unknown): value is Buffer | Uint8Array | string =>
  Buffer.isBuffer(value) || value instanceof Uint8Array || typeof value === 'string';

const findExecutableOnPath = (
  fs: Pick<typeof fsModule, 'statSync'>,
  path: Pick<typeof pathModule, 'join'>,
  binaryName: string,
  searchPath: string,
): string | null => {
  if (!binaryName || !searchPath) return null;
  const separator = process.platform === 'win32' ? ';' : ':';
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const rawDir of String(searchPath).split(separator)) {
    const dir = rawDir.trim();
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = path.join(dir, `${binaryName}${ext}`);
      try {
        const stat = fs.statSync(candidate);
        if (stat.isFile()) return candidate;
      } catch {
        continue;
      }
    }
  }
  return null;
};

const resolveLanguageServerBinary = ({
  fs,
  path,
  buildAugmentedPath,
  languageId,
}: {
  fs: Pick<typeof fsModule, 'statSync'>;
  path: Pick<typeof pathModule, 'join'>;
  buildAugmentedPath?: (() => string) | undefined;
  languageId: string;
}): ResolvedLspServer | null => {
  const specs = SERVER_SPECS[languageId.toLowerCase()];
  if (!specs) return null;
  const searchPath = buildAugmentedPath ? buildAugmentedPath() : process.env.PATH || '';
  for (const spec of specs) {
    const binaryPath = findExecutableOnPath(fs, path, spec.bin, searchPath);
    if (binaryPath) {
      return { name: spec.name, binaryPath, args: spec.args };
    }
  }
  return null;
};

const encodeLspFrame = (json: string): string => {
  const byteLength = Buffer.byteLength(json, 'utf8');
  return `Content-Length: ${byteLength}\r\n\r\n${json}`;
};

export const registerLspRoutes = (app: Application, dependencies: LspRoutesDependencies) => {
  const {
    fs,
    path,
    spawn,
    resolveProjectDirectory,
    buildAugmentedPath,
  } = dependencies;

  const activeSessions = new Map<string, LspSession>();

  const destroySession = (sessionKey: string) => {
    const session = activeSessions.get(sessionKey);
    if (!session) return;
    activeSessions.delete(sessionKey);
    if (session.idleTimer) clearTimeout(session.idleTimer);
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve(null);
    }
    session.pending.clear();
    try {
      session.child.kill();
    } catch {
      return;
    }
  };

  const touchSession = (sessionKey: string, session: LspSession) => {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => destroySession(sessionKey), IDLE_TIMEOUT_MS);
    session.idleTimer.unref?.();
  };

  const getOrCreateSession = (
    directory: string,
    languageId: string,
    resolvedServer: ResolvedLspServer,
    spawnProcess: NonNullable<LspRoutesDependencies['spawn']>,
  ): LspSession => {
    const sessionKey = `${directory}::${languageId}`;
    const existing = activeSessions.get(sessionKey);
    if (existing && !existing.closed) {
      touchSession(sessionKey, existing);
      return existing;
    }

    const child = spawnProcess(resolvedServer.binaryPath, resolvedServer.args, {
      cwd: directory,
      stdio: ['pipe', 'pipe', 'ignore'],
      env: {
        ...process.env,
        PATH: buildAugmentedPath ? buildAugmentedPath() : process.env.PATH,
      },
    });

    const session: LspSession = {
      child,
      closed: false,
      buffer: Buffer.alloc(0),
      pending: new Map(),
      idleTimer: null,
    };

    const consumeFrames = () => {
      while (session.buffer.length > 0) {
        const headerEnd = session.buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const headerText = session.buffer.subarray(0, headerEnd).toString('ascii');
        const match = /Content-Length:\s*(\d+)/i.exec(headerText);
        const lengthText = match?.[1];
        if (!lengthText) {
          session.buffer = Buffer.alloc(0);
          return;
        }
        const contentLength = Number.parseInt(lengthText, 10);
        const bodyStart = headerEnd + 4;
        if (session.buffer.length < bodyStart + contentLength) return;
        const bodyBytes = session.buffer.subarray(bodyStart, bodyStart + contentLength);
        session.buffer = session.buffer.subarray(bodyStart + contentLength);
        try {
          const parsed: unknown = JSON.parse(bodyBytes.toString('utf8'));
          if (isLspResponsePayload(parsed)) {
            const key = String(parsed.id);
            const entry = session.pending.get(key);
            if (entry) {
              session.pending.delete(key);
              clearTimeout(entry.timer);
              entry.resolve(parsed);
            }
          }
        } catch {
          continue;
        }
      }
    };

    child.stdout?.on('data', (chunk: Buffer | Uint8Array | string) => {
      if (!isBufferOrUint8Array(chunk)) return;
      session.buffer = Buffer.concat([session.buffer, Buffer.from(chunk)]);
      consumeFrames();
    });

    const markClosed = () => {
      session.closed = true;
      destroySession(sessionKey);
    };
    child.on('error', markClosed);
    child.on('exit', markClosed);

    activeSessions.set(sessionKey, session);
    touchSession(sessionKey, session);
    return session;
  };

  app.get('/api/lsp/status', async (req, res) => {
    const languageId = asNonEmptyString(req.query?.languageId) ?? '';
    const resolved = resolveLanguageServerBinary({ fs, path, buildAugmentedPath, languageId });
    res.json({
      available: Boolean(resolved),
      languageId,
      serverName: resolved?.name ?? null,
    });
  });

  app.post('/api/lsp/request', async (req, res) => {
    const body = isRecord(req.body) ? req.body : {};
    const languageId = asNonEmptyString(body.languageId) ?? '';
    const message = body.message;
    if (!languageId || !isPlainObject(message)) {
      res.status(400).json({ error: 'languageId and message object are required' });
      return;
    }

    const resolvedServer = resolveLanguageServerBinary({ fs, path, buildAugmentedPath, languageId });
    if (!resolvedServer || !spawn) {
      res.json({ available: false, response: null });
      return;
    }

    const resolution = await resolveProjectDirectory(req);
    if (!resolution?.directory) {
      res.json({ available: false, response: null });
      return;
    }

    try {
      const session = getOrCreateSession(resolution.directory, languageId, resolvedServer, spawn);
      const serializedMessage = JSON.stringify(message);
      if (message.id === undefined || message.id === null) {
        session.child.stdin?.write(encodeLspFrame(serializedMessage));
        res.json({ available: true, response: null });
        return;
      }

      const idKey = String(message.id);
      const response = await new Promise<LspResponsePayload | null>((resolve) => {
        const timer = setTimeout(() => {
          session.pending.delete(idKey);
          resolve(null);
        }, REQUEST_TIMEOUT_MS);
        session.pending.set(idKey, { resolve, timer });
        try {
          session.child.stdin?.write(encodeLspFrame(serializedMessage));
        } catch {
          clearTimeout(timer);
          session.pending.delete(idKey);
          resolve(null);
        }
      });

      res.json({
        available: response !== null,
        serverName: resolvedServer.name,
        response,
      });
    } catch {
      res.json({ available: false, response: null });
    }
  });

  return {
    disposeAllLspSessions: () => {
      for (const key of [...activeSessions.keys()]) {
        destroySession(key);
      }
    },
  };
};
