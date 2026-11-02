import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { cliMissingError } from '../errors.js';

const runFile = promisify(execFile);

/**
 * Starts agy the way the user's shell does. A shell function may carry the
 * environment a wrapper needs (magpie's agy function sets the gateway URL and
 * key); running the real binary directly skips it. Only a function is
 * wrapped, and any detection failure keeps the direct executable.
 * @param {object} options
 * @param {() => Promise<string | null>} options.resolveExecutable
 * @param {Record<string, string>} options.env
 * @param {string} [options.shell]
 * @param {NodeJS.Platform} [options.platform]
 * @param {(file: string, args: string[], options: object) => Promise<{ stdout: string }>} [options.run]
 * @returns {Promise<{ executable: string, argsPrefix: string[] }>}
 */
export const resolveAgyCommand = async ({
  resolveExecutable,
  env,
  shell = process.env.SHELL || '/bin/bash',
  platform = process.platform,
  run = runFile,
}) => {
  const executable = await resolveExecutable();
  if (!executable) throw cliMissingError('agy');
  const direct = { executable, argsPrefix: [] };
  if (platform === 'win32') return direct;
  const shellName = path.basename(shell);
  if (shellName !== 'bash' && shellName !== 'zsh') return direct;
  try {
    const { stdout } = await run(shell, ['-ic', 'type -t agy'], { env, timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true });
    const lastLine = stdout.trim().split(/\r?\n/).at(-1)?.trim();
    if (lastLine !== 'function') return direct;
  } catch {
    return direct;
  }
  // `exec` would bypass the function; pass the args as shell positional
  // parameters so the fixed command string never interpolates user input.
  return { executable: shell, argsPrefix: ['-ic', 'agy "$@"', '--'] };
};
