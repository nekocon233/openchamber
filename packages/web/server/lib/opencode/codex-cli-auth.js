import { spawnSync } from 'node:child_process';

/**
 * Codex CLI sign-in state.
 *
 * The opencode-codex plugin never writes to OpenCode's auth store — the Codex
 * CLI owns its credentials — so the Providers page has nothing to read there
 * and has to ask the CLI instead.
 *
 * `codex login status` prints a sentence and always exits 0, so the text is the
 * only signal. Verified against codex-cli 0.154.0: it prints that sentence on
 * **stderr** and leaves stdout empty, so both streams are read. It reports on
 * the local credential file, not the service: a session whose refresh token was
 * revoked upstream still prints "Logged in" and only fails on the next turn.
 * Callers should treat `connected` as "the CLI believes it is signed in".
 */

const readStatus = (spawnSyncFn, command, env) => spawnSyncFn(command, ['login', 'status'], {
  encoding: 'utf8',
  timeout: 6000,
  env,
  windowsHide: true,
});

const resolveFromLoginShell = (spawnSyncFn, env, platform) => {
  if (platform === 'win32') {
    const result = spawnSyncFn('where', ['codex'], {
      encoding: 'utf8',
      timeout: 6000,
      env,
      windowsHide: true,
    });
    return `${result.stdout || ''}`.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null;
  }

  const shell = env.SHELL || '/bin/zsh';
  const result = spawnSyncFn(shell, ['-lic', 'command -v codex'], {
    encoding: 'utf8',
    timeout: 6000,
    env,
    windowsHide: true,
  });
  return `${result.stdout || ''}`.trim().split(/\s+/).pop() || null;
};

/** The CLI colourises its output even when piped. */
const plain = (value) => `${value || ''}`.replace(/\[[0-9;]*m/g, '').trim();

/** The status sentence lands on stderr; stdout stays empty. */
const statusText = (result) => plain(`${result?.stdout || ''}\n${result?.stderr || ''}`);

export const getCodexCliAuthStatus = ({
  spawnSyncFn = spawnSync,
  env = process.env,
  platform = process.platform,
} = {}) => {
  try {
    let result = readStatus(spawnSyncFn, 'codex', env);
    if (!statusText(result)) {
      const resolved = resolveFromLoginShell(spawnSyncFn, env, platform);
      if (resolved) result = readStatus(spawnSyncFn, resolved, env);
    }

    const output = statusText(result);
    if (!output) return { status: 'unavailable', connected: false, reason: 'empty-status' };
    // "Not logged in" contains "logged in", so the negative has to win.
    if (/not\s+logged\s+in|logged\s+out/i.test(output)) {
      return { status: 'disconnected', connected: false, reason: 'logged-out' };
    }
    if (/logged\s+in/i.test(output)) {
      return { status: 'connected', connected: true, reason: 'logged-in' };
    }
    return { status: 'unavailable', connected: false, reason: 'invalid-status' };
  } catch {
    return { status: 'unavailable', connected: false, reason: 'invalid-status' };
  }
};
