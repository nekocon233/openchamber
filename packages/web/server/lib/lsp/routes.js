import { asNonEmptyString, isPlainObject } from '../shared/guards.js';

// Language server stdio bridge for `/api/lsp/*`. Uses Node built-ins only so
// packaged desktop builds without node_modules load it cleanly.

const SERVER_SPECS = Object.freeze({
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

const findExecutableOnPath = (fs, path, binaryName, searchPath) => {
  if (!fs || !path || !binaryName || !searchPath) return null;
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
        // Keep scanning PATH entries.
      }
    }
  }
  return null;
};

const resolveLanguageServerBinary = ({ fs, path, buildAugmentedPath, languageId }) => {
  const specs = SERVER_SPECS[String(languageId || '').toLowerCase()];
  if (!specs) return null;
  const searchPath = buildAugmentedPath instanceof Function
    ? buildAugmentedPath()
    : process.env.PATH || '';
  for (const spec of specs) {
    const binaryPath = findExecutableOnPath(fs, path, spec.bin, searchPath);
    if (binaryPath) {
      return { name: spec.name, binaryPath, args: spec.args };
    }
  }
  return null;
};

const encodeLspFrame = (payload) => {
  const json = JSON.stringify(payload);
  const byteLength = Buffer.byteLength(json, 'utf8');
  return `Content-Length: ${byteLength}\r\n\r\n${json}`;
};

export const registerLspRoutes = (app, dependencies) => {
  const {
    fs,
    path,
    spawn,
    resolveProjectDirectory,
    buildAugmentedPath,
  } = dependencies;

  const activeSessions = new Map();

  const destroySession = (sessionKey) => {
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
      // Process already exited.
    }
  };

  const touchSession = (sessionKey, session) => {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => destroySession(sessionKey), IDLE_TIMEOUT_MS);
    session.idleTimer.unref?.();
  };

  const getOrCreateSession = (directory, languageId, resolvedServer) => {
    const sessionKey = `${directory}::${languageId}`;
    const existing = activeSessions.get(sessionKey);
    if (existing && !existing.closed) {
      touchSession(sessionKey, existing);
      return existing;
    }

    const child = spawn(resolvedServer.binaryPath, resolvedServer.args, {
      cwd: directory,
      stdio: ['pipe', 'pipe', 'ignore'],
      env: {
        ...process.env,
        PATH: buildAugmentedPath instanceof Function ? buildAugmentedPath() : process.env.PATH,
      },
    });

    const session = {
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
        const headerText = session.buffer.slice(0, headerEnd).toString('ascii');
        const match = /Content-Length:\s*(\d+)/i.exec(headerText);
        if (!match) {
          session.buffer = Buffer.alloc(0);
          return;
        }
        const contentLength = Number.parseInt(match[1], 10);
        const bodyStart = headerEnd + 4;
        if (session.buffer.length < bodyStart + contentLength) return;
        const bodyBytes = session.buffer.slice(bodyStart, bodyStart + contentLength);
        session.buffer = session.buffer.slice(bodyStart + contentLength);
        try {
          const parsed = JSON.parse(bodyBytes.toString('utf8'));
          if (parsed && parsed.id !== undefined && session.pending.has(String(parsed.id))) {
            const entry = session.pending.get(String(parsed.id));
            session.pending.delete(String(parsed.id));
            clearTimeout(entry.timer);
            entry.resolve(parsed);
          }
        } catch {
          // Ignore malformed frame.
        }
      }
    };

    child.stdout?.on('data', (chunk) => {
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
    const languageId = asNonEmptyString(req.body?.languageId) ?? '';
    const message = req.body?.message;
    if (!languageId || !isPlainObject(message)) {
      res.status(400).json({ error: 'languageId and message object are required' });
      return;
    }

    const resolvedServer = resolveLanguageServerBinary({ fs, path, buildAugmentedPath, languageId });
    if (!resolvedServer || !(spawn instanceof Function)) {
      res.json({ available: false, response: null });
      return;
    }

    const resolution = await resolveProjectDirectory(req);
    if (!resolution?.directory) {
      res.json({ available: false, response: null });
      return;
    }

    try {
      const session = getOrCreateSession(resolution.directory, languageId, resolvedServer);
      if (message.id === undefined || message.id === null) {
        session.child.stdin?.write(encodeLspFrame(message));
        res.json({ available: true, response: null });
        return;
      }

      const idKey = String(message.id);
      const response = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          session.pending.delete(idKey);
          resolve(null);
        }, REQUEST_TIMEOUT_MS);
        session.pending.set(idKey, { resolve, timer });
        try {
          session.child.stdin?.write(encodeLspFrame(message));
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
