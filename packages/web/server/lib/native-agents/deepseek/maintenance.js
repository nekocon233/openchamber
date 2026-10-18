import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { NativeAgentError } from '../errors.js';
import { spawnCliProcess, terminateCliProcess } from '../process.js';
import { isWindowsShim } from '../executables.js';
import { isEnterpriseMode } from '../../enterprise-mode.js';

const manifest = z.object({ name: z.literal('@deepseek-ai/dsh'), version: z.literal('0.2.0-rc.2') });
const descriptor = z.object({ root: z.string().min(1), compression: z.enum(['none', 'zstd']) });
const resultSchema = z.object({ ok: z.boolean(), deleted: z.boolean().optional(), code: z.string().optional(), nativeIds: z.array(z.string()).optional() });
const failure = (code, status = 503) => new NativeAgentError('DeepSeek Harness session maintenance could not complete. Retry after checking the server installation.', { code, status });

/** Resolve the CLI's own packages; no workspace dependency or user profile edit. */
export const deepseekPackage = async (executable) => {
  let current = await fs.realpath(executable);
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = path.join(current, 'package.json');
    try {
      manifest.parse(JSON.parse(await fs.readFile(candidate, 'utf8')));
      return candidate;
    } catch { /* A launcher may live in bin/ or lib/. */ }
    current = path.dirname(current);
  }
  try {
    const candidate = createRequire(executable).resolve('@deepseek-ai/dsh/package.json');
    manifest.parse(JSON.parse(await fs.readFile(candidate, 'utf8')));
    return candidate;
  } catch { return null; }
};

export const createDeepseekMaintenance = ({
  dataDir, resolveNodeExecutable, buildEnv, spawnProcess = spawnCliProcess,
  workerPath = process.env.OPENCHAMBER_DSH_WORKER_PATH ?? fileURLToPath(new URL('./maintenance-worker.mjs', import.meta.url)),
  pluginPath = process.env.OPENCHAMBER_DSH_PLUGIN_PATH ?? fileURLToPath(new URL('./maintenance-plugin.js', import.meta.url)),
}) => {
  const directory = path.join(dataDir, 'native-agents', 'deepseek', 'maintenance');
  let child = null;
  let disposed = false;
  const allowed = () => {
    if (isEnterpriseMode()) throw new NativeAgentError('DeepSeek Harness is unavailable in enterprise mode', { status: 403, code: 'enterprise_mode' });
    if (disposed) throw failure('NATIVE_DEEPSEEK_MAINTENANCE_CANCELLED');
  };
  const run = async (input) => {
    allowed();
    const executable = await resolveNodeExecutable();
    if (!executable || isWindowsShim(executable)) throw failure('NATIVE_DEEPSEEK_NODE_MISSING');
    if (child) throw failure('NATIVE_DEEPSEEK_MAINTENANCE_BUSY', 409);
    return new Promise((resolve, reject) => {
      const running = spawnProcess(executable, [workerPath], { cwd: directory, env: buildEnv() });
      child = running;
      let output = '';
      let invalid = false;
      running.stdout.on('data', (chunk) => { if (output.length + chunk.length > 65536) invalid = true; else output += chunk; });
      running.stderr.resume();
      const timer = setTimeout(() => { invalid = true; void terminateCliProcess(running); }, 60_000);
      const finish = (error) => {
        clearTimeout(timer);
        if (child === running) child = null;
        if (error || invalid) { reject(failure('NATIVE_DEEPSEEK_MAINTENANCE_FAILED')); return; }
        try {
          const result = resultSchema.parse(JSON.parse(output));
          if (!result.ok && !result.deleted) reject(failure(result.code ?? 'NATIVE_DEEPSEEK_MAINTENANCE_FAILED', result.code === 'NATIVE_DEEPSEEK_WRITER_HELD' ? 409 : 503));
          else resolve(result);
        } catch { reject(failure('NATIVE_DEEPSEEK_MAINTENANCE_FAILED')); }
      };
      running.once('error', finish);
      running.once('exit', () => finish());
      running.stdin.end(JSON.stringify({ ...input, directory }));
    });
  };
  return {
    async prepare(executable) {
      allowed();
      const packageFile = await deepseekPackage(executable);
      if (!packageFile) return null;
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      // Recover interrupted deletions before DSH can discover their artifacts.
      await run({ operation: 'recover', packageFile });
      const overlay = path.join(directory, 'overlay.json');
      await fs.writeFile(overlay, JSON.stringify([{ insert: [{ id: 'openchamber-maintenance', name: pathToFileURL(pluginPath).href }] }]), { mode: 0o600 });
      return { packageFile, overlay };
    },
    async remove(config, nativeIds) {
      allowed();
      return run({ operation: 'delete', packageFile: config.packageFile, storage: descriptor.parse(config), nativeIds });
    },
    async shutdown() { disposed = true; if (child) await terminateCliProcess(child); },
  };
};
