// Private entry for managed agents. Reuse the public memory command's policy,
// auth and output adapter without requiring an executable on the agent's PATH.
import { existsSync } from 'node:fs';

const sourceLoader = new URL('../../../scripts/register-server-sources.mjs', import.meta.url);
if (!process.versions.bun && existsSync(sourceLoader)) await import(sourceLoader.href);

const { parseArgs } = await import('../../../bin/lib/cli-args.js');
const { memoryCommand } = await import('../../../bin/lib/commands-memory.js');
const { printJson } = await import('../../../bin/cli-output.js');
const { EXIT_CODE, TunnelCliError } = await import('../../../bin/lib/cli-errors.js');

try {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.command !== 'memory' || parsed.removedFlagErrors.length) throw new TunnelCliError('Invalid memory arguments', EXIT_CODE.USAGE_ERROR);
  if (parsed.helpRequested) {
    printJson({ usage: 'memory <list|read|save|delete> [OPTIONS]', options: ['--directory <cwd>', '--scope global|project', '--title <title>', '--memory-id <id>', '--body-file <file>', '--port <port>', '--json', '--quiet'] });
  } else {
    if (!['list', 'read', 'save', 'delete'].includes(parsed.memoryAction)) throw new TunnelCliError('Unsupported managed memory action', EXIT_CODE.USAGE_ERROR);
    await memoryCommand({ ...parsed.options, json: true }, parsed.memoryAction);
  }
} catch (error) {
  printJson({ status: 'error', code: 'NATIVE_MEMORY_CLI_FAILED', error: 'Shared memory is unavailable. Check the command arguments, server connection and memory switch.' });
  process.exitCode = error instanceof TunnelCliError ? error.exitCode : EXIT_CODE.GENERAL_ERROR;
}
