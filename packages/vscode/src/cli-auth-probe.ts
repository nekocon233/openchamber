/**
 * Asking a coding CLI whether it is signed in.
 *
 * Claude Code and Codex both own their own credentials, so the extension has
 * nothing in OpenCode's auth store to read for them and must ask the CLI. The
 * mechanics are identical for both — resolve the binary, run one short probe,
 * and never let a failed probe masquerade as "signed out" — so they live here
 * once rather than drifting apart in two copies.
 *
 * A VS Code extension host does not inherit a login shell's PATH, which is why
 * the shell fallback exists at all.
 */
import { execFile } from 'node:child_process';
import { resolveWindowsLaunchSpec } from './process-launch';

type CliCommandOptions = {
  encoding: 'utf8';
  timeout: number;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  windowsHide: true;
};

type CliCommandResult = {
  stdout?: string | null;
  /** Some CLIs print their status here and leave stdout empty. */
  stderr?: string | null;
  error?: Error;
};

export type CliCommandRunner = (
  command: string,
  args: string[],
  options: CliCommandOptions,
) => Promise<CliCommandResult>;

export type CliStatusOptions = {
  runCommand?: CliCommandRunner;
  resolveExecutable?: (
    binaryName: string,
    platform: NodeJS.Platform,
    env: NodeJS.ProcessEnv,
  ) => string | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};

/**
 * `unavailable` is deliberately distinct from `disconnected`: a probe that
 * could not run says nothing about whether the user is signed in, and showing
 * it as "signed out" would send them to re-authenticate for no reason.
 */
export type CliAuthStatus =
  | { status: 'connected'; connected: true; reason: 'logged-in' }
  | { status: 'disconnected'; connected: false; reason: 'logged-out' }
  | {
      status: 'unavailable';
      connected: false;
      reason: 'cli-not-found' | 'probe-failed' | 'invalid-status';
    };

const PROBE_TIMEOUT_MS = 6_000;

export const defaultRunCommand: CliCommandRunner = (command, args, options) =>
  new Promise((resolve) => {
    const launch = resolveWindowsLaunchSpec(command, args, {
      platform: options.platform,
      env: options.env,
    });
    execFile(launch.binary, launch.args, {
      encoding: options.encoding,
      timeout: options.timeout,
      env: options.env,
      windowsHide: options.windowsHide,
    }, (error, stdout, stderr) => {
      resolve({ stdout: stdout || '', stderr: stderr || '', error: error ?? undefined });
    });
  });

export const commandOutput = (result: CliCommandResult): string => result.stdout?.trim() ?? '';

/**
 * Both streams, for a CLI that prints its answer on stderr. Verified against
 * codex-cli 0.154.0: `codex login status` writes its sentence to stderr and
 * leaves stdout empty, so reading stdout alone reports "no answer".
 */
export const combinedOutput = (result: CliCommandResult): string =>
  `${result.stdout || ''}\n${result.stderr || ''}`.trim();

export const runCliCommand = (
  runCommand: CliCommandRunner,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<CliCommandResult> => runCommand(command, args, {
  encoding: 'utf8',
  timeout: PROBE_TIMEOUT_MS,
  env,
  platform,
  windowsHide: true,
});

/** Last resort when the extension host's PATH cannot see the binary. */
export const resolveCommandFromShell = async (
  binaryName: string,
  runCommand: CliCommandRunner,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<string | null> => {
  if (platform === 'win32') {
    const result = await runCliCommand(runCommand, 'where', [binaryName], env, platform);
    if (result.error) return null;
    return commandOutput(result).split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
  }

  const shell = env.SHELL || '/bin/zsh';
  const result = await runCliCommand(
    runCommand,
    shell,
    ['-lic', `command -v ${binaryName}`],
    env,
    platform,
  );
  if (result.error) return null;
  return commandOutput(result) || null;
};
