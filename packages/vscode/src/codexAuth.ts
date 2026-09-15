/**
 * Codex CLI sign-in state for the VS Code runtime.
 *
 * The opencode-codex plugin never writes to OpenCode's auth store — the Codex
 * CLI owns its credentials — so the Providers view has to ask the CLI.
 *
 * `codex login status` prints a sentence and always exits 0, so the text is the
 * only signal. Verified against codex-cli 0.154.0: it prints that sentence on
 * stderr and leaves stdout empty. It reports on the local credential file
 * rather than the service: a session whose refresh token was revoked upstream
 * still prints "Logged in" and only fails on the next turn. `connected`
 * therefore means "the CLI believes it is signed in".
 */
import { findExecutableInPath } from './process-launch';
import {
  combinedOutput,
  defaultRunCommand,
  resolveCommandFromShell,
  runCliCommand,
  type CliAuthStatus,
  type CliStatusOptions,
} from './cli-auth-probe';

const BINARY = 'codex';

/** The CLI colourises its output even when piped. */
// eslint-disable-next-line no-control-regex
const stripAnsi = (value: string): string => value.replace(/\[[0-9;]*m/g, '').trim();

const classify = (output: string): CliAuthStatus => {
  // "Not logged in" contains "logged in", so the negative has to win.
  if (/not\s+logged\s+in|logged\s+out/i.test(output)) {
    return { status: 'disconnected', connected: false, reason: 'logged-out' };
  }
  if (/logged\s+in/i.test(output)) {
    return { status: 'connected', connected: true, reason: 'logged-in' };
  }
  return { status: 'unavailable', connected: false, reason: 'invalid-status' };
};

const probeCodexCliAuthStatus = async (options: CliStatusOptions): Promise<CliAuthStatus> => {
  const runCommand = options.runCommand ?? defaultRunCommand;
  const resolveExecutable = options.resolveExecutable
    ?? ((binaryName, platform, env) => findExecutableInPath(binaryName, { platform, env }));
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;

  try {
    const command = resolveExecutable(BINARY, platform, env)
      ?? await resolveCommandFromShell(BINARY, runCommand, env, platform);
    if (!command) return { status: 'unavailable', connected: false, reason: 'cli-not-found' };

    const result = await runCliCommand(runCommand, command, ['login', 'status'], env, platform);
    const output = stripAnsi(combinedOutput(result));
    // The exit code does not decide this. Verified against codex-cli 0.154.0:
    // a signed-out CLI exits 1 while printing a perfectly clear "Not logged
    // in", so treating a non-zero exit as a failed probe would hide the answer
    // it just gave us.
    if (!output) return { status: 'unavailable', connected: false, reason: 'probe-failed' };
    return classify(output);
  } catch {
    return { status: 'unavailable', connected: false, reason: 'probe-failed' };
  }
};

let inFlight: Promise<CliAuthStatus> | null = null;

/**
 * Single-flight: the Providers view can ask several times while it renders, and
 * each probe spawns a process.
 */
export const getCodexCliAuthStatus = (options: CliStatusOptions = {}): Promise<CliAuthStatus> => {
  if (inFlight) return inFlight;
  const pending = probeCodexCliAuthStatus(options).finally(() => {
    if (inFlight === pending) inFlight = null;
  });
  inFlight = pending;
  return pending;
};
