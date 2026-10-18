import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { spawnCliProcess } from '../process.js';
import { createDeepseekInstallation } from './installation.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const setup = async ({ scenario = 'success', platform = process.platform, timeoutMs, enterpriseMode = () => false } = {}) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openchamber-dsh-install-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const npm = path.join(root, 'npm-cli.js');
  const argsFile = path.join(root, 'args.json');
  await writeFile(npm, `
    const fs = require('node:fs');
    const path = require('node:path');
    const args = process.argv.slice(2);
    fs.writeFileSync(process.env.DSH_TEST_ARGS, JSON.stringify(args));
    const prefix = args[args.indexOf('--prefix') + 1];
    if (process.env.DSH_TEST_SCENARIO === 'wait') { setInterval(() => {}, 1000); }
    else if (process.env.DSH_TEST_SCENARIO === 'fail') {
      fs.writeFileSync(path.join(prefix, 'partial'), 'partial download'); process.exit(1);
    } else setTimeout(() => {
      const win = process.env.DSH_TEST_PLATFORM === 'win32';
      const root = path.join(prefix, ...(win ? [] : ['lib']), 'node_modules', '@deepseek-ai', 'dsh');
      fs.mkdirSync(path.join(root, 'lib'), {recursive:true});
      fs.writeFileSync(path.join(root,'package.json'), JSON.stringify({name:'@deepseek-ai/dsh',version:'0.2.0-rc.2',bin:{dsh:'lib/bin.js'}}));
      fs.writeFileSync(path.join(root,'lib','bin.js'),process.env.DSH_TEST_SCENARIO === 'invalid-cli' ? 'throw new Error("missing peer");' : 'console.log("0.2.0-rc.2");');
      if (win) fs.writeFileSync(path.join(prefix,'dsh.cmd'),'fake npm shim');
      else {
        fs.mkdirSync(path.join(prefix,'bin'), {recursive:true});
        fs.writeFileSync(path.join(prefix,'bin','dsh'),'#!/usr/bin/env node\\nconsole.log("0.2.0-rc.2");',{mode:0o700});
      }
    }, 30);
  `);
  const launches = [];
  const dataDir = path.join(root, 'data');
  const installation = createDeepseekInstallation({
    dataDir, platform, timeoutMs, enterpriseMode,
    resolveExecutable: async (name) => name === 'node' ? process.execPath : name === 'npm' ? npm : null,
    buildEnv: () => ({ ...process.env, DSH_TEST_ARGS: argsFile, DSH_TEST_SCENARIO: scenario, DSH_TEST_PLATFORM: platform }),
    spawnProcess: (executable, args, options) => { launches.push({ executable, args, stdio: options.stdio }); return spawnCliProcess(executable, args, options); },
  });
  cleanups.push(() => installation.shutdown());
  return { installation, dataDir, launches, argsFile };
};

describe('managed DeepSeek CLI installation', () => {
  it('installs once into a private prefix and reuses the published CLI', async () => {
    const { installation, dataDir, launches, argsFile } = await setup();
    expect(await installation.resolve()).toBeNull();
    const results = await Promise.all([installation.prepare(), installation.prepare()]);
    expect(results[0]).toBe(results[1]);
    expect(await installation.resolve()).toBe(results[0]);
    expect(await installation.prepare()).toBe(results[0]);
    expect(launches).toHaveLength(2);
    expect(launches[0]).toMatchObject({ executable: process.execPath, stdio: 'ignore' });
    const args = JSON.parse(await readFile(argsFile, 'utf8'));
    expect(args).toContain('@deepseek-ai/dsh@0.2.0-rc.2');
    expect(args).toContain('--ignore-scripts');
    expect(args).not.toContain('--legacy-peer-deps');
    expect(args[args.indexOf('--prefix') + 1].startsWith(path.join(dataDir, 'native-agents', 'deepseek', '.install-'))).toBe(true);
    expect(await readdir(path.join(dataDir, 'native-agents', 'deepseek'))).toEqual([`cli-v0.2.0-rc.2-${process.platform}-${process.arch}`]);
    const restarted = createDeepseekInstallation({ dataDir, resolveExecutable: async () => null, buildEnv: () => ({}) });
    expect(await restarted.resolve()).toBe(results[0]);
    expect(await restarted.prepare()).toBe(results[0]);
    await restarted.shutdown();
  });

  it('refuses to publish a complete package whose CLI cannot load its runtime', async () => {
    const { installation, dataDir } = await setup({ scenario: 'invalid-cli' });
    await expect(installation.prepare()).rejects.toMatchObject({ code: 'NATIVE_DEEPSEEK_INSTALL_FAILED' });
    expect(await installation.resolve()).toBeNull();
    expect(await readdir(path.join(dataDir, 'native-agents', 'deepseek'))).toEqual([]);
  });

  it('does not publish partial downloads and allows another attempt', async () => {
    const { installation, dataDir, launches } = await setup({ scenario: 'fail' });
    await expect(installation.prepare()).rejects.toMatchObject({ code: 'NATIVE_DEEPSEEK_INSTALL_FAILED' });
    expect(await installation.resolve()).toBeNull();
    expect(await readdir(path.join(dataDir, 'native-agents', 'deepseek'))).toEqual([]);
    await expect(installation.prepare()).rejects.toMatchObject({ code: 'NATIVE_DEEPSEEK_INSTALL_FAILED' });
    expect(launches).toHaveLength(2);
  });

  it('cancels a running installer on shutdown and cleans its staging directory', async () => {
    const { installation, dataDir } = await setup({ scenario: 'wait' });
    const pending = installation.prepare();
    pending.catch(() => {});
    await expect.poll(async () => (await readdir(path.join(dataDir, 'native-agents', 'deepseek')).catch(() => [])).length).toBe(1);
    await installation.shutdown();
    await expect(pending).rejects.toMatchObject({ code: 'NATIVE_DEEPSEEK_INSTALL_CANCELLED' });
    expect(await readdir(path.join(dataDir, 'native-agents', 'deepseek'))).toEqual([]);
  });

  it('bounds an unresponsive installer and refuses enterprise mode before launch', async () => {
    const timed = await setup({ scenario: 'wait', timeoutMs: 100 });
    await expect(timed.installation.prepare()).rejects.toMatchObject({ code: 'NATIVE_DEEPSEEK_INSTALL_TIMEOUT' });
    const blocked = await setup({ enterpriseMode: () => true });
    await expect(blocked.installation.prepare()).rejects.toMatchObject({ code: 'enterprise_mode', status: 403 });
    expect(blocked.launches).toHaveLength(0);
  });

  it('runs npm through Node when publishing a Windows prefix', async () => {
    const { installation, launches } = await setup({ platform: 'win32' });
    expect(await installation.prepare()).toMatch(/dsh\.cmd$/);
    expect(launches[0].executable).toBe(process.execPath);
    expect(launches[0].args[0]).toMatch(/npm-cli\.js$/);
  });

  it('refuses a Windows Node batch shim before running npm', async () => {
    const { dataDir } = await setup({ platform: 'win32' });
    const installation = createDeepseekInstallation({
      dataDir, platform: 'win32', enterpriseMode: () => false,
      resolveExecutable: async (name) => name === 'node' ? 'C:\\tools\\node.cmd' : null,
      buildEnv: () => { throw new Error('A batch shim must never reach process launch'); },
    });
    await expect(installation.prepare()).rejects.toMatchObject({ code: 'NATIVE_DEEPSEEK_NODE_MISSING' });
    await installation.shutdown();
  });

  it('uses a CLI already found on the server without installing another one', async () => {
    const { dataDir } = await setup();
    const installation = createDeepseekInstallation({
      dataDir, enterpriseMode: () => false,
      resolveExecutable: async (name) => name === 'dsh' ? '/existing/dsh' : null,
      buildEnv: () => { throw new Error('An existing CLI needs no installation'); },
    });
    expect(await installation.prepare()).toBe('/existing/dsh');
    expect(await installation.resolve()).toBe('/existing/dsh');
    await installation.shutdown();
  });
});
