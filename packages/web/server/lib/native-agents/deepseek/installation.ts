import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { isEnterpriseMode } from '../../enterprise-mode.js';
import { NativeAgentError } from '../errors.js';
import { isWindowsShim } from '../executables.js';
import { spawnCliProcess, terminateCliProcess } from '../process.js';
import type { SpawnCliProcessOptions } from '../process.js';

const VERSION = '0.2.0-rc.2';
const manifest = z.object({ name: z.literal('@deepseek-ai/dsh'), version: z.literal(VERSION) });
const fileError = z.object({ code: z.string() });
const failure = (code: string): NativeAgentError => new NativeAgentError('Could not install DeepSeek Harness on this server', { code, status: 503 });

export type DeepseekInstallCliName = 'dsh' | 'node' | 'npm';

export interface DeepseekInstallationOptions {
  dataDir: string;
  resolveExecutable: (cli: DeepseekInstallCliName) => Promise<string | null>;
  buildEnv: () => Record<string, string>;
  platform?: NodeJS.Platform | undefined;
  arch?: string | undefined;
  spawnProcess?: ((executable: string, args: string[], options: SpawnCliProcessOptions) => ChildProcess) | undefined;
  enterpriseMode?: (() => boolean) | undefined;
  timeoutMs?: number | undefined;
}

export interface DeepseekInstallation {
  resolve: () => Promise<string | null>;
  prepare: (options?: { signal?: AbortSignal | undefined }) => Promise<string>;
  shutdown: () => Promise<void>;
}

const runInstall = (
  node: string,
  args: string[],
  {
    cwd,
    env,
    signal,
    timeoutMs,
    spawnProcess,
  }: {
    cwd: string;
    env: Record<string, string>;
    signal: AbortSignal;
    timeoutMs: number;
    spawnProcess: (executable: string, args: string[], options: SpawnCliProcessOptions) => ChildProcess;
  },
): Promise<void> => new Promise((resolve, reject) => {
  signal.throwIfAborted();
  const child = spawnProcess(node, args, { cwd, env, stdio: 'ignore' });
  let settled = false;
  let stoppingError: NativeAgentError | null = null;
  const finish = (error: NativeAgentError | null): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    if (error) reject(error);
    else resolve();
  };
  const abort = (): void => {
    stoppingError = failure('NATIVE_DEEPSEEK_INSTALL_CANCELLED');
    void terminateCliProcess(child).then(() => finish(stoppingError));
  };
  const timer = setTimeout(() => {
    stoppingError = failure('NATIVE_DEEPSEEK_INSTALL_TIMEOUT');
    void terminateCliProcess(child).then(() => finish(stoppingError));
  }, timeoutMs);
  child.once('error', () => finish(failure('NATIVE_DEEPSEEK_INSTALL_FAILED')));
  child.once('exit', (code) => finish(stoppingError ?? (code === 0 ? null : failure('NATIVE_DEEPSEEK_INSTALL_FAILED'))));
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
});

const npmEntry = async (node: string, npm: string | null): Promise<string> => {
  const nodePath = await fs.realpath(node);
  const candidates = [
    path.join(path.dirname(nodePath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(path.dirname(nodePath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  if (npm) {
    const npmPath = await fs.realpath(npm);
    candidates.unshift(path.join(path.dirname(npmPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    if (path.basename(npmPath) === 'npm-cli.js') candidates.unshift(npmPath);
  }
  for (const candidate of candidates) {
    if (await fs.stat(candidate).then((stat) => stat.isFile(), () => false)) return candidate;
  }
  throw failure('NATIVE_DEEPSEEK_NPM_MISSING');
};

export const createDeepseekInstallation = ({
  dataDir,
  resolveExecutable,
  buildEnv,
  platform = process.platform,
  arch = process.arch,
  spawnProcess = spawnCliProcess,
  enterpriseMode = isEnterpriseMode,
  timeoutMs = 10 * 60_000,
}: DeepseekInstallationOptions): DeepseekInstallation => {
  const directory = path.join(dataDir, 'native-agents', 'deepseek');
  const installed = path.join(directory, `cli-v${VERSION}-${platform}-${arch}`);
  const binaryIn = (prefix: string): string => (platform === 'win32' ? path.join(prefix, 'dsh.cmd') : path.join(prefix, 'bin', 'dsh'));
  const packageIn = (prefix: string): string => path.join(prefix, ...(platform === 'win32' ? [] : ['lib']), 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
  const controller = new AbortController();
  let preparing: Promise<string> | null = null;

  const allowed = (signal?: AbortSignal): void => {
    controller.signal.throwIfAborted();
    signal?.throwIfAborted();
    if (enterpriseMode()) throw new NativeAgentError('DeepSeek Harness is unavailable in enterprise mode', { code: 'enterprise_mode', status: 403 });
  };

  const prepared = async (prefix: string): Promise<boolean> => {
    try {
      manifest.parse(JSON.parse(await fs.readFile(packageIn(prefix), 'utf8')));
      return (await fs.stat(binaryIn(prefix))).isFile();
    } catch (error) {
      if (fileError.safeParse(error).data?.code === 'ENOENT') return false;
      throw failure('NATIVE_DEEPSEEK_INSTALL_INVALID');
    }
  };

  return {
    async resolve() {
      const external = await resolveExecutable('dsh');
      if (external) return external;
      return await fs.stat(binaryIn(installed)).then((stat) => stat.isFile(), () => false) ? binaryIn(installed) : null;
    },
    async prepare({ signal } = {}) {
      allowed(signal);
      if (preparing) return preparing;
      preparing = (async () => {
        const external = await resolveExecutable('dsh');
        if (external) return external;
        if (await prepared(installed)) return binaryIn(installed);
        const node = await resolveExecutable('node');
        if (!node || isWindowsShim(node, platform)) throw failure('NATIVE_DEEPSEEK_NODE_MISSING');
        const npm = await npmEntry(node, await resolveExecutable('npm'));
        allowed(signal);
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        const staging = await fs.mkdtemp(path.join(directory, '.install-'));
        const installSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
        const env = buildEnv();
        try {
          await runInstall(node, [npm, 'install', '--global', '--prefix', staging, '--no-audit', '--no-fund', '--ignore-scripts', `@deepseek-ai/dsh@${VERSION}`], {
            cwd: staging,
            env,
            timeoutMs,
            spawnProcess,
            signal: installSignal,
          });
          allowed(signal);
          if (!await prepared(staging)) throw failure('NATIVE_DEEPSEEK_INSTALL_INVALID');
          await runInstall(node, [path.join(path.dirname(packageIn(staging)), 'lib', 'bin.js'), '--version'], {
            cwd: staging,
            env,
            timeoutMs: 5000,
            spawnProcess,
            signal: installSignal,
          });
          allowed(signal);
          try {
            await fs.rename(staging, installed);
          } catch (error) {
            const code = fileError.safeParse(error).data?.code;
            if ((code !== 'EEXIST' && code !== 'ENOTEMPTY') || !await prepared(installed)) throw error;
          }
          return binaryIn(installed);
        } finally {
          await fs.rm(staging, { recursive: true, force: true });
        }
      })();
      try {
        return await preparing;
      } finally {
        preparing = null;
      }
    },
    async shutdown() {
      controller.abort();
      await preparing?.catch(() => {});
    },
  };
};
