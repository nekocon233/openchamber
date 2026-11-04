import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'jsonc-parser';
import { prepareAgyDelegation, prepareAgyChecklist } from './mcp-setup.js';

const cleanup = [];
afterEach(async () => { for (const directory of cleanup.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });
const fixture = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-agy-tools-'));
  cleanup.push(directory);
  const config = path.join(directory, '.gemini', 'config');
  await fs.mkdir(config, { recursive: true });
  const tools = { command: process.execPath, args: ['/managed/native-delegation-mcp.mjs'], env: { OPENCHAMBER_DELEGATION_TOKEN: 'must-not-be-written' } };
  return { directory, config, tools };
};
describe('Antigravity managed delegation registration', () => {
  it('registers an independent checklist without writing environment or delegation hooks', async () => {
    const { directory, config } = await fixture();
    const tools = { command: process.execPath, args: ['/managed/native-agy-checklist-mcp.mjs'], env: { OPENCHAMBER_AGY_CHECKLIST: '1' } };
    await prepareAgyChecklist(tools, { HOME: directory });
    const file = path.join(config, 'mcp_config.json');
    const first = await fs.readFile(file, 'utf8');
    await prepareAgyChecklist(tools, { HOME: directory });
    expect(await fs.readFile(file, 'utf8')).toBe(first);
    expect(parse(first).mcpServers.openchamber_checklist).toEqual({ command: tools.command, args: tools.args });
    expect(first).not.toContain('OPENCHAMBER_AGY_CHECKLIST');
    await expect(fs.stat(path.join(config, 'hooks.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses user-owned checklist registrations and malformed configuration', async () => {
    const { directory, config } = await fixture();
    for (const original of ['{broken', '{"mcpServers":{"openchamber_checklist":{"command":"user-owned"}}}']) {
      const file = path.join(config, 'mcp_config.json');
      await fs.writeFile(file, original);
      await expect(prepareAgyChecklist({ command: 'node', args: ['/managed/checklist-mcp.mjs'] }, { HOME: directory }))
        .rejects.toMatchObject({ code: 'NATIVE_ANTIGRAVITY_CHECKLIST_SETUP_FAILED' });
      expect(await fs.readFile(file, 'utf8')).toBe(original);
    }
  });
  it('preserves JSONC comments and unrelated servers without persisting credentials', async () => {
    const { directory, config, tools } = await fixture();
    await fs.writeFile(path.join(config, 'mcp_config.json'), '// user servers\n{"mcpServers":{"existing":{"command":"existing-worker"}},}\n');
    await fs.writeFile(path.join(config, 'hooks.json'), '{"user-hook":{"enabled":false}}');
    await prepareAgyDelegation(tools, { HOME: directory });
    const mcp = await fs.readFile(path.join(config, 'mcp_config.json'), 'utf8');
    const hooks = await fs.readFile(path.join(config, 'hooks.json'), 'utf8');
    expect(mcp).toContain('// user servers');
    expect(parse(mcp).mcpServers.existing).toEqual({ command: 'existing-worker' });
    expect(parse(hooks)['user-hook']).toEqual({ enabled: false });
    expect(mcp + hooks).not.toContain('must-not-be-written');
    expect(parse(hooks)['openchamber-delegation'].PreToolUse[0].matcher).toContain('invoke_subagent');
  });
  it('accepts the CLI empty MCP file and makes repeated registration idempotent', async () => {
    const { directory, config, tools } = await fixture();
    const file = path.join(config, 'mcp_config.json');
    await fs.writeFile(file, '');
    await prepareAgyDelegation(tools, { HOME: directory });
    const before = await fs.readFile(file, 'utf8');
    await prepareAgyDelegation(tools, { HOME: directory });
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    expect(Object.keys(parse(before).mcpServers)).toEqual(['openchamber_subagents']);
  });
  it('refuses malformed hooks before changing the MCP configuration', async () => {
    const { directory, config, tools } = await fixture();
    const original = '{"mcpServers":{"existing":{"command":"existing-worker"}}}';
    await fs.writeFile(path.join(config, 'mcp_config.json'), original);
    await fs.writeFile(path.join(config, 'hooks.json'), '{broken');
    await expect(prepareAgyDelegation(tools, { HOME: directory })).rejects.toMatchObject({ code: 'NATIVE_DELEGATION_SETUP_FAILED' });
    expect(await fs.readFile(path.join(config, 'mcp_config.json'), 'utf8')).toBe(original);
  });
  it('preserves a user-owned MCP entry using the reserved name', async () => {
    const { directory, config, tools } = await fixture();
    const original = '{"mcpServers":{"openchamber_subagents":{"command":"user-worker"}}}';
    await fs.writeFile(path.join(config, 'mcp_config.json'), original);
    await expect(prepareAgyDelegation(tools, { HOME: directory })).rejects.toMatchObject({ code: 'NATIVE_DELEGATION_SETUP_FAILED' });
    expect(await fs.readFile(path.join(config, 'mcp_config.json'), 'utf8')).toBe(original);
  });
});
