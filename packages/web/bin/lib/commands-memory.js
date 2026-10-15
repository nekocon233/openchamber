import fs from 'node:fs/promises';
import { z } from 'zod';
import { resolveTargetPort } from './cli-api-target.js';
import { requestControlAction } from './cli-control.js';
import { requestJson } from './cli-http.js';
import { TunnelCliError, EXIT_CODE } from './cli-errors.js';
import { isJsonMode, printJson, logStatus } from '../cli-output.js';

const backend = z.enum(['claude', 'codex']);
const actions = new Set(['status', 'list', 'read', 'save', 'delete', 'connect', 'disconnect']);

export const memoryCommand = async (options = {}, action = 'status') => {
  if (action === 'help') {
    const help = {
      usage: 'openchamber memory <status|list|read|save|delete|connect|disconnect> [OPTIONS]',
      options: ['--directory <cwd>', '--scope global|project', '--title <title>', '--memory-id <id>', '--body-file <file>', '--backend claude|codex', '--port <port>', '--json', '--quiet'],
    };
    if (isJsonMode(options)) printJson(help);
    else process.stdout.write(`${help.usage}\n\n${help.options.join('\n')}\n`);
    return;
  }
  if (!actions.has(action)) throw new TunnelCliError(`Unknown memory command '${action}'.`, EXIT_CODE.USAGE_ERROR);
  const input = { directory: options.directory || process.cwd() };
  if (options.scope) input.scope = options.scope;
  if (options.title) input.title = options.title;
  if (options.memoryId) input.memoryId = options.memoryId;
  if (action === 'save') {
    if (!input.title) throw new TunnelCliError('memory save requires --title.', EXIT_CODE.USAGE_ERROR);
    if (!options.bodyFile) throw new TunnelCliError('memory save requires --body-file.', EXIT_CODE.USAGE_ERROR);
    if (!['global', 'project'].includes(input.scope)) throw new TunnelCliError('memory save requires --scope global|project.', EXIT_CODE.USAGE_ERROR);
    input.body = await fs.readFile(options.bodyFile, 'utf8');
    if (input.body.length > 2000) throw new TunnelCliError('Memory body must not exceed 2000 characters.', EXIT_CODE.USAGE_ERROR);
  }
  if (action === 'read' && !input.title && !input.memoryId) throw new TunnelCliError('memory read requires --title or --memory-id.', EXIT_CODE.USAGE_ERROR);
  if (action === 'delete' && (!input.memoryId || !['global', 'project'].includes(input.scope))) throw new TunnelCliError('memory delete requires --memory-id and --scope.', EXIT_CODE.USAGE_ERROR);
  const selectedBackend = action === 'connect' || action === 'disconnect' ? backend.parse(options.backend) : null;
  const port = await resolveTargetPort(options);
  let result;
  if (action === 'status' || selectedBackend) {
    const route = action === 'status'
      ? `/api/native/memory?directory=${encodeURIComponent(input.directory)}`
      : `/api/native/memory/${selectedBackend}${action === 'connect' ? '/connect' : ''}`;
    const response = await requestJson(port, route, { ...options, method: action === 'status' ? 'GET' : action === 'connect' ? 'POST' : 'DELETE' });
    if (!response.response.ok) throw new TunnelCliError('The memory operation failed. Check the server and memory settings.', EXIT_CODE.GENERAL_ERROR);
    result = response.body;
  } else result = await requestControlAction(port, `memory.${action}`, input, options);
  if (isJsonMode(options)) printJson(result);
  else if (options.quiet || !process.stdout.isTTY) process.stdout.write(`${JSON.stringify(result, null, options.quiet ? 0 : 2)}\n`);
  else logStatus('info', 'Shared memory', JSON.stringify(result, null, 2));
};

