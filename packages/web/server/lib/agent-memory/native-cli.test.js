import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentMemoryRuntime } from './runtime.js';
import { createAgentMemoryActions } from './actions.js';

const entry = process.env.OPENCHAMBER_TEST_MEMORY_CLI ?? fileURLToPath(new URL('./native-cli.mjs', import.meta.url));
let root, memory, actions;
let port;
let requests = 0;
let enabled = true;
const server = createServer((req, res) => {
  let source = '';
  req.on('data', (part) => { source += part; });
  req.on('end', async () => {
    requests += 1;
    res.setHeader('Content-Type', 'application/json');
    try {
      const input = JSON.parse(source);
      res.end(JSON.stringify(await actions.execute(input.action, input.input, input.input.directory)));
    } catch (error) { res.writeHead(error.status ?? 500); res.end(JSON.stringify({ error: error.message })); }
  });
});
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'native memory cli '));
  memory = createAgentMemoryRuntime({ fsPromises: fs, path, userConfigRoot: root, projectsDirPath: path.join(root, 'projects') });
  await memory.create({ scope: 'project', projectId: 'project' }, { title: 'Tests', body: 'A stored project fact.' });
  await fs.writeFile(path.join(root, 'body.txt'), 'Fact written by a managed CLI.');
  actions = createAgentMemoryActions({ agentMemoryRuntime: memory, isAgentMemoryEnabled: () => enabled,
    resolveProjectId: () => 'project', createError: (message, status) => Object.assign(new Error(message), { status }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); port = server.address().port;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [entry, ...args], { env: { ...process.env, PATH: '' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', (part) => { stdout += part; }); child.stderr.on('data', (part) => { stderr += part; });
  child.once('error', reject); child.once('close', (code) => resolve({ code, stdout, stderr }));
});

describe('managed memory command entry', () => {
  it.each([{ flags: [] }, { flags: ['--quiet'] }, { flags: ['--json'] }])('reads without a global CLI and returns JSON only ($flags)', async ({ flags }) => {
    const result = await run(['memory', 'read', '--title', 'Tests', '--port', String(port), ...flags]);
    expect(result.code).toBe(0); expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout).memory.body).toBe('A stored project fact.');
  });
  it('validates before connecting and refuses unrelated commands and hook enrollment', async () => {
    const before = requests;
    for (const args of [['memory', 'read'], ['memory', 'save', '--body-file'], ['memory', 'connect', '--backend', 'claude'], ['serve']]) {
      const result = await run(args);
      expect(result.code).not.toBe(0); expect(result.stderr).toBe(''); expect(JSON.parse(result.stdout).status).toBe('error');
    }
    const help = await run(['memory', '--help']); expect(help.code).toBe(0); expect(JSON.parse(help.stdout).usage).toContain('list|read|save|delete');
    expect(requests).toBe(before);
  });
  it('saves a real project memory from a body file and reads it back through the same entry', async () => {
    const saved = await run(['memory', 'save', '--scope', 'project', '--title', 'Saved', '--body-file', path.join(root, 'body.txt'), '--directory', root, '--port', String(port)]);
    expect(saved.code).toBe(0); expect(JSON.parse(saved.stdout).saved).toBe(true);
    const read = await run(['memory', 'read', '--scope', 'project', '--title', 'Saved', '--directory', root, '--port', String(port)]);
    expect(read.code).toBe(0); expect(JSON.parse(read.stdout).memory.body).toBe('Fact written by a managed CLI.');
    expect((await memory.readAll('project')).project.some((entry) => entry.title === 'Saved')).toBe(true);
  });
  it('does not turn a disabled memory service into an empty successful result', async () => {
    enabled = false;
    try {
      const result = await run(['memory', 'read', '--title', 'Tests', '--port', String(port)]);
      expect(result.code).not.toBe(0); expect(JSON.parse(result.stdout).status).toBe('error');
    } finally { enabled = true; }
  });
});
