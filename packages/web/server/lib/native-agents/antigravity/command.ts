import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { cliMissingError } from '../errors.js';

export interface AgyCommand {
  executable: string;
  argsPrefix: string[];
}

export interface AgyCommandRunOptions {
  env: NodeJS.ProcessEnv;
  timeout: number;
  maxBuffer: number;
  windowsHide: boolean;
}

export type AgyCommandRunner = (
  file: string,
  args: string[],
  options: AgyCommandRunOptions,
) => Promise<{ stdout: string }>;

export interface ResolveAgyCommandOptions {
  resolveExecutable: () => Promise<string | null>;
  env: NodeJS.ProcessEnv;
  shell?: string | undefined;
  platform?: NodeJS.Platform | undefined;
  run?: AgyCommandRunner | undefined;
}

const execFileAsync = promisify(execFile);
const runFile: AgyCommandRunner = (file, args, options) => execFileAsync(file, args, options);

export const resolveAgyCommand = async ({
  resolveExecutable,
  env,
  shell = process.env.SHELL || '/bin/bash',
  platform = process.platform,
  run = runFile,
}: ResolveAgyCommandOptions): Promise<AgyCommand> => {
  const executable = await resolveExecutable();
  if (!executable) throw cliMissingError('agy');
  const direct: AgyCommand = { executable, argsPrefix: [] };
  if (platform === 'win32') return direct;
  const shellName = path.basename(shell);
  if (shellName !== 'bash' && shellName !== 'zsh') return direct;
  try {
    const { stdout } = await run(shell, ['-ic', 'type -t agy'], {
      env,
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
    const lastLine = stdout.trim().split(/\r?\n/).at(-1)?.trim();
    if (lastLine !== 'function') return direct;
  } catch {
    return direct;
  }
  return { executable: shell, argsPrefix: ['-ic', 'agy "$@"', '--'] };
};
