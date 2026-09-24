// Finds the user's `claude` and `codex` binaries. The login shell's PATH comes
// first; the installers' default locations cover servers whose PATH does not
// include them. Found paths are cached; a miss is looked up again next time,
// so a CLI installed while the server runs is picked up.
//
// On Windows, npm installs a CLI as a `.cmd` shim, which Node cannot start
// without a shell. A native `.exe` (the installers put one in `~/.local/bin`)
// wins over a shim found first on PATH; see `isWindowsShim` for what a shim
// can still do.

import os from 'node:os';
import path from 'node:path';

const WINDOWS_SHIM = /\.(?:cmd|bat)$/i;

/** True for a Windows batch shim, which runs only through `cmd.exe`. */
export const isWindowsShim = (executable, platform = process.platform) => (
  platform === 'win32' && WINDOWS_SHIM.test(executable)
);

const fallbackLocations = (cli, home, platform) => {
  const binary = platform === 'win32' ? `${cli}.exe` : cli;
  const locations = [path.join(home, '.local', 'bin', binary)];
  if (cli === 'claude') locations.push(path.join(home, '.claude', 'local', binary));
  return locations;
};

/**
 * @param {object} options
 * @param {(name: string, searchPath: string) => string | null} options.searchPathFor
 * @param {(candidate: string) => boolean} options.isExecutable
 * @param {() => string} options.buildSearchPath
 * @param {string} [options.home]
 * @param {NodeJS.Platform} [options.platform]
 * @returns {(cli: 'claude' | 'codex') => Promise<string | null>}
 */
export const createCliResolver = ({ searchPathFor, isExecutable, buildSearchPath, home = os.homedir(), platform = process.platform }) => {
  const found = new Map();
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
