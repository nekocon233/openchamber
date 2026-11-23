import { fileURLToPath } from 'node:url';
import { cliMissingError, NativeAgentError } from '../errors.js';
import { spawnCliProcess, signalCliProcess } from '../process.js';
import { parseAntigravityModels, type AgyCatalogModel } from './catalog.js';
import type { AgyCommand } from './command.js';
import { createAntigravityCommands } from './commands.js';
import { prepareAgyChecklist } from './mcp-setup.js';
import { agyDiagnostic } from './process.js';
import { createAntigravityQuota } from './quota.js';
import type { CreateAntigravityBackendOptions } from './backend-contract.js';

const MINIMUM_VERSION = [1, 1, 15] as const;

export const backendError = (message: string, code = 'NATIVE_ANTIGRAVITY_ERROR') => new NativeAgentError(message, { code, status: 502 });

const versionSupported = (version: string): boolean => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const actual = match.slice(1).map(Number);
  for (let index = 0; index < 3; index += 1) {
    const current = actual[index];
    const minimum = MINIMUM_VERSION[index];
    if (current === undefined || minimum === undefined) return false;
    if (current > minimum) return true;
    if (current < minimum) return false;
  }
  return true;
};

interface AntigravityCommandOptions extends Pick<CreateAntigravityBackendOptions, 'buildEnv' | 'resolveExecutable'> {
  resolveCommand: NonNullable<CreateAntigravityBackendOptions['resolveCommand']>;
  resolveNodeExecutable: NonNullable<CreateAntigravityBackendOptions['resolveNodeExecutable']>;
  now: () => number;
  setModelAliases: (aliases: Map<string, string>) => void;
}

export function createAntigravityCommandRuntime({
  buildEnv, resolveExecutable, resolveCommand, resolveNodeExecutable, now, setModelAliases,
}: AntigravityCommandOptions) {
  const checklistLaunch = async (directory: string): Promise<{ env: Record<string, string>; instructions: string }> => {
    const env = buildEnv();
    const command = await resolveNodeExecutable();
    if (!command) return { env, instructions: '' };
    const helper = process.env.OPENCHAMBER_AGY_CHECKLIST_MCP_PATH ?? fileURLToPath(new URL('./checklist-mcp.mjs', import.meta.url));
    await prepareAgyChecklist({ command, args: [helper] }, env, directory);
    return {
      env: { ...env, OPENCHAMBER_AGY_CHECKLIST: '1' },
      instructions: 'For multi-step work, maintain this conversation\'s checklist with the openchamber_checklist update_checklist tool. Send the complete list each time and keep stable ids. Update it as work progresses and verify a step before marking it completed. This checklist is separate from manage_task background commands.',
    };
  };

  let commandPromise: Promise<AgyCommand> | null = null;
  const requireCommand = (): Promise<AgyCommand> => {
    commandPromise ??= resolveCommand({ resolveExecutable, env: buildEnv() }).catch((error) => {
      commandPromise = null;
      throw error;
    });
    return commandPromise;
  };

  const probe = async (
    args: string[],
    { native = false, cwd = process.cwd(), timeoutMs = 10_000 }: { native?: boolean | undefined; cwd?: string | undefined; timeoutMs?: number | undefined } = {},
  ): Promise<string> => {
    const command = native
      ? { executable: await resolveExecutable(), argsPrefix: [] }
      : await requireCommand();
    const executable = command.executable;
    if (!executable) throw cliMissingError('agy');
    return new Promise<string>((resolve, reject) => {
      const child = spawnCliProcess(executable, [...command.argsPrefix, ...args], { cwd, env: buildEnv() });
      const { stdout: stdoutStream, stderr: stderrStream } = child;
      if (!stdoutStream || !stderrStream) {
        reject(backendError('Antigravity probe stdio pipes are unavailable'));
        return;
      }
      let stdout = '';
      let stderr = '';
      let outputExceeded = false;
      const deadline = setTimeout(() => {
        signalCliProcess(child, 'SIGKILL');
        reject(backendError(`Antigravity discovery timed out: ${args.join(' ')}`, 'NATIVE_ANTIGRAVITY_PROBE_TIMEOUT'));
      }, timeoutMs);
      deadline.unref?.();
      stdoutStream.on('data', (chunk: Buffer | string) => {
        if (outputExceeded) return;
        stdout += chunk.toString();
        if (stdout.length > 1024 * 1024) {
          outputExceeded = true;
          signalCliProcess(child, 'SIGKILL');
          reject(backendError('Antigravity discovery output exceeded its limit', 'NATIVE_ANTIGRAVITY_PROBE_OUTPUT'));
        }
      });
      stderrStream.on('data', (chunk: Buffer | string) => {
        stderr = (stderr + chunk.toString()).slice(-8192);
      });
      child.on('error', (error: Error) => {
        clearTimeout(deadline);
        reject(backendError(error.message));
      });
      child.on('close', (code) => {
        clearTimeout(deadline);
        if (code === 0) resolve(stdout);
        else {
          const diagnostic = stderr.trim() || `agy exited with code ${code}`;
          const unauthenticated = /auth|sign[ -]?in|log[ -]?in/i.test(diagnostic);
          reject(backendError(agyDiagnostic(diagnostic), unauthenticated ? 'NATIVE_ANTIGRAVITY_UNAUTHENTICATED' : 'NATIVE_ANTIGRAVITY_ERROR'));
        }
      });
    });
  };

  const commands = createAntigravityCommands({
    now,
    readSkills: (directory) => probe([
      '--settings', JSON.stringify({ model: '' }),
      '--disable-slash-commands=false', '--print', '/skills', '--print-timeout', '10s',
      '--add-dir', directory,
    ], { native: true, cwd: directory, timeoutMs: 25_000 }),
  });

  const quota = createAntigravityQuota({
    resolveExecutable,
    readUsage: () => probe([
      '--settings', JSON.stringify({ modelProvider: '', model: '' }),
      '--disable-slash-commands=false', '--print', '/usage', '--print-timeout', '10s',
    ], { native: true }),
  });

  const readCatalog = async (): Promise<AgyCatalogModel[]> => {
    const version = (await probe(['--version'])).trim();
    if (!versionSupported(version)) {
      throw backendError(`Antigravity ${version || 'version'} is unsupported. Update agy to 1.1.15 or later.`, 'NATIVE_ANTIGRAVITY_VERSION');
    }
    const settings = JSON.stringify({ customModelsConfig: { customModels: {} } });
    const models = parseAntigravityModels(await probe(['--settings', settings, 'models']));
    setModelAliases(new Map(models.flatMap((model) => model.aliases.map((alias) => [alias.id, model.id]))));
    return models;
  };

  return { checklistLaunch, requireCommand, commands, quota, readCatalog };
}
