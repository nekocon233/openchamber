import os from 'node:os';
import path from 'node:path';

import { claudeShimError, cliMissingError } from './errors.js';

export type NativeCliName = 'claude' | 'codex' | 'dsh' | 'agy' | 'node' | 'npm';

export interface CliResolverOptions {
  searchPathFor: (name: string, searchPath: string) => string | null;
  isExecutable: (candidate: string) => boolean;
  buildSearchPath: () => string;
  home?: string | undefined;
  platform?: NodeJS.Platform | undefined;
}

export type CliResolver = (cli: NativeCliName) => Promise<string | null>;

const WINDOWS_SHIM = /\.(?:cmd|bat)$/i;

export const isWindowsShim = (executable: string, platform: NodeJS.Platform = process.platform): boolean => (
  platform === 'win32' && WINDOWS_SHIM.test(executable)
);

export const launchableClaudeExecutable = async (
  resolveExecutable: () => Promise<string | null>,
  platform: NodeJS.Platform = process.platform,
): Promise<string> => {
  const executable = await resolveExecutable();
  if (!executable) throw cliMissingError('claude');
  if (isWindowsShim(executable, platform)) throw claudeShimError(executable);
  return executable;
};

const fallbackLocations = (cli: NativeCliName, home: string, platform: NodeJS.Platform): string[] => {
  const binary = platform === 'win32' ? `${cli}.exe` : cli;
  const locations = [path.join(home, '.local', 'bin', binary)];
  if (cli === 'claude') locations.push(path.join(home, '.claude', 'local', binary));
  if (cli === 'agy' && platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    locations.push(path.join(localAppData, 'agy', 'bin', binary));
  }
  return locations;
};

export const createCliResolver = ({
  searchPathFor,
  isExecutable,
  buildSearchPath,
  home = os.homedir(),
  platform = process.platform,
}: CliResolverOptions): CliResolver => {
  const found = new Map<NativeCliName, string>();
  return async (cli) => {
    const cached = found.get(cli);
    if (cached && isExecutable(cached)) return cached;
    const onPath = searchPathFor(cli, buildSearchPath());
    const installed = () => fallbackLocations(cli, home, platform).find((candidate) => isExecutable(candidate)) ?? null;
    const resolved = onPath !== null && !isWindowsShim(onPath, platform)
      ? onPath
      : installed() ?? onPath;
    if (resolved === null) found.delete(cli);
    else found.set(cli, resolved);
    return resolved;
  };
};
