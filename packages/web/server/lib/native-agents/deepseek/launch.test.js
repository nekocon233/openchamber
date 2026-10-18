import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveDeepseekLaunch } from './launch.js';

const directories = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

describe('DeepSeek Windows npm launch', () => {
  it('runs the installed package entry directly with Node, preserving paths with spaces', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dsh launch '));
    directories.push(root);
    const packageRoot = path.join(root, 'node_modules', '@deepseek-ai', 'dsh');
    await mkdir(path.join(packageRoot, 'lib'), { recursive: true });
    await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', bin: { dsh: 'lib/bin.js' } }));
    const entry = path.join(packageRoot, 'lib', 'bin.js');
    await writeFile(entry, 'export {};');
    const launch = await resolveDeepseekLaunch({ executable: path.join(root, 'dsh.cmd'), args: ['--profile', 'web'], resolveNodeExecutable: async () => process.execPath, platform: 'win32' });
    expect(launch).toEqual({ executable: process.execPath, args: [entry, '--profile', 'web'] });
  });

  it('refuses a missing Node executable and leaves native launches unchanged', async () => {
    await expect(resolveDeepseekLaunch({ executable: '/dsh.cmd', args: [], resolveNodeExecutable: async () => null, platform: 'win32' })).rejects.toMatchObject({ code: 'NATIVE_DEEPSEEK_NODE_MISSING' });
    expect(await resolveDeepseekLaunch({ executable: '/dsh.exe', args: ['web'], resolveNodeExecutable: async () => null, platform: 'win32' })).toEqual({ executable: '/dsh.exe', args: ['web'] });
  });
});
