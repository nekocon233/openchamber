import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { parse, modify, applyEdits } from 'jsonc-parser';
import { withMemoryFileLock } from '../../agent-memory/file-lock.js';
import { NativeAgentError } from '../errors.js';

const object = z.record(z.string(), z.json());
const quote = (value) => process.platform === 'win32' ? `"${value.replaceAll('"', '""')}"` : `'${value.replaceAll("'", "'\\''")}'`;
const read = async (file) => {
  try {
    const contents = await fs.readFile(file, 'utf8');
    const errors = [];
    const document = parse(contents.trim() ? contents : '{}', errors, { allowTrailingComma: true });
    if (errors.length) throw new Error('Invalid CLI configuration');
    return { contents, document: object.parse(document ?? {}) };
  } catch (error) { if (error.code === 'ENOENT') return { contents: '{}\n', document: {} }; throw error; }
};
const update = async (file, keys, value) => withMemoryFileLock(file, async () => {
  const { contents } = await read(file);
  const edits = modify(contents, keys, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } });
  const after = applyEdits(contents, edits);
  if (contents === after) return;
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try { await fs.writeFile(temporary, after, { mode: 0o600, flag: 'wx' }); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
});

/** A credential-free registration; the process environment enables its tools. */
export const prepareAgyDelegation = async (tools, env) => {
  const directory = path.join(env.HOME || os.homedir(), '.gemini', 'config');
  try {
    const mcpFile = path.join(directory, 'mcp_config.json');
    const hookFile = path.join(directory, 'hooks.json');
    const { document } = await read(mcpFile);
    const hooks = await read(hookFile);
    const existingHook = hooks.document['openchamber-delegation'];
    if (existingHook && !JSON.stringify(existingHook).includes('--deny-native')) throw new Error('Hook name collision');
    const servers = document.mcpServers === undefined ? {} : object.parse(document.mcpServers);
    const previous = servers.openchamber_subagents;
    if (previous && !JSON.stringify(previous).includes('delegation-mcp.mjs')) throw new Error('MCP name collision');
    const server = { command: tools.command, args: tools.args, timeoutSeconds: 3600 };
    await update(mcpFile, ['mcpServers', 'openchamber_subagents'], server);
    try {
      await update(hookFile, ['openchamber-delegation'], { PreToolUse: [{ matcher: '^(invoke_subagent|define_subagent)$',
        hooks: [{ type: 'command', command: `${quote(tools.command)} ${quote(tools.args[0])} --deny-native`, timeout: 5 }],
      }] });
    } catch (error) {
      const current = await read(mcpFile);
      const held = object.parse(current.document.mcpServers).openchamber_subagents;
      if (JSON.stringify(held) === JSON.stringify(server)) await update(mcpFile, ['mcpServers', 'openchamber_subagents'], previous);
      throw error;
    }
  } catch {
    throw new NativeAgentError('Could not register the Antigravity subagent tools. Check the CLI configuration and retry.', { status: 503, code: 'NATIVE_DELEGATION_SETUP_FAILED' });
  }
};

/** This registration carries no credentials and leaves native delegation intact. */
export const prepareAgyChecklist = async (tools, env, workspace) => {
  const directory = path.join(env.HOME || os.homedir(), '.gemini', 'config');
  try {
    if (workspace) {
      const local = await read(path.join(workspace, '.agents', 'mcp_config.json'));
      if (local.document.mcpServers && Object.hasOwn(object.parse(local.document.mcpServers), 'openchamber_checklist')) throw new Error('Workspace MCP name collision');
    }
    const file = path.join(directory, 'mcp_config.json');
    const { document } = await read(file);
    const servers = document.mcpServers === undefined ? {} : object.parse(document.mcpServers);
    const existing = servers.openchamber_checklist;
    if (existing && !JSON.stringify(existing).includes('checklist-mcp.mjs')) throw new Error('MCP name collision');
    await update(file, ['mcpServers', 'openchamber_checklist'], { command: tools.command, args: tools.args });
  } catch {
    throw new NativeAgentError('Could not register the Antigravity checklist tool. Check the CLI MCP configuration and retry.', { status: 503, code: 'NATIVE_ANTIGRAVITY_CHECKLIST_SETUP_FAILED' });
  }
};
