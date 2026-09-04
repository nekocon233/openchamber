import fs from 'node:fs';
import path from 'node:path';

type ProcessLaunchOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
};

type ProcessLaunchSpec = { binary: string; args: string[] };

const executableExtensions = (env: NodeJS.ProcessEnv): string[] =>
  (env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean)
    .map((extension) => extension.startsWith('.') ? extension : `.${extension}`);

export const isExecutable = (filePath: string, options: ProcessLaunchOptions = {}): boolean => {
  if (!filePath) return false;
  const platform = options.platform ?? process.platform;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (platform === 'win32') {
      const extension = path.extname(filePath).toLowerCase();
      return !extension || ['.exe', '.cmd', '.bat', '.com'].includes(extension);
    }
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export const findExecutableInPath = (
  binaryName: string,
  options: ProcessLaunchOptions = {},
): string | null => {
  const trimmed = binaryName.trim();
  if (!trimmed) return null;
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const searchPath = env.PATH || '';
  if (!searchPath) return null;
  const extensions = platform === 'win32' ? executableExtensions(env) : [''];

  for (const segment of searchPath.split(path.delimiter)) {
    const directory = segment.trim();
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, platform === 'win32' ? `${trimmed}${extension}` : trimmed);
      if (isExecutable(candidate, { platform, env })) return candidate;
    }
  }
  return null;
};

export const resolveWindowsLaunchSpec = (
  binary: string,
  args: string[],
  options: ProcessLaunchOptions = {},
): ProcessLaunchSpec => {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform !== 'win32') return { binary, args };

  const trimmed = binary.trim();
  const extension = path.extname(trimmed).toLowerCase();
  const isBatchShim = extension === '.cmd' || extension === '.bat';
  const isBareName = !extension && !trimmed.includes('\\') && !trimmed.includes('/');
  if (!isBatchShim && !isBareName) return { binary: trimmed, args };

  return {
    binary: env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', 'call', trimmed, ...args],
  };
};
