// npm's Windows .cmd launcher is replaced with the same package entry run by
// the user's Node executable. Prompts stay on HTTP, never on a shell command line.
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { z } from 'zod';
import { NativeAgentError } from '../errors.js';
import { isWindowsShim } from '../executables.js';

const manifest = z.object({ name: z.literal('@deepseek-ai/dsh'), bin: z.object({ dsh: z.string().min(1) }) });

export const resolveDeepseekLaunch = async ({ executable, args, resolveNodeExecutable, platform = process.platform }) => {
  if (!isWindowsShim(executable, platform)) return { executable, args };
  const node = await resolveNodeExecutable();
  if (!node || isWindowsShim(node, platform)) throw new NativeAgentError('Install Node.js on the server PATH to start dsh on Windows', {
    code: 'NATIVE_DEEPSEEK_NODE_MISSING', status: 503,
  });
  try {
    const packageFile = createRequire(executable).resolve('@deepseek-ai/dsh/package.json');
    const config = manifest.parse(JSON.parse(await fs.readFile(packageFile, 'utf8')));
    const root = path.dirname(packageFile);
    const entry = path.resolve(root, config.bin.dsh);
    if (!entry.startsWith(`${root}${path.sep}`) || !(await fs.stat(entry)).isFile()) throw new Error('Invalid dsh package entry');
    return { executable: node, args: [entry, ...args] };
  } catch {
    throw new NativeAgentError('The installed dsh Windows launcher could not be resolved. Reinstall the dsh CLI.', {
      code: 'NATIVE_DEEPSEEK_CLI_UNLAUNCHABLE', status: 503,
    });
  }
};
