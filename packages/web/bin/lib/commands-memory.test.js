import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './cli-args.js';

const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
let port;
let requests = 0;
const server = createServer((req, res) => {
  requests += 1;
  res.setHeader('Content-Type', 'application/json');
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const input = JSON.parse(body);
    if (input.action !== 'memory.read') { res.writeHead(400); res.end(JSON.stringify({ error: 'Unexpected action' })); return; }
    res.end(JSON.stringify({ memory: { memoryId: 'm1', scope: 'project', title: 'Tests', body: 'Run the focused tests.' } }));
  });
});
beforeAll(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [cli, 'memory', ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', (code) => resolve({ code, stdout, stderr }));
});

describe('memory CLI contract', () => {
  it('parses scoped memory flags and rejects a missing flag value', () => {
    expect(parseArgs(['memory', 'save', '--scope', 'project', '--body-file', '/tmp/memory.txt', '--title', 'Tests']).memoryAction).toBe('save');
    expect(parseArgs(['memory', 'save', '--body-file']).removedFlagErrors).toContain('--body-file requires a value.');
  });
  it.each([{ flags: [] }, { flags: ['--json'] }, { flags: ['--quiet'] }])('reads through the shared control channel in non-interactive mode $flags', async ({ flags }) => {
    const result = await run(['read', '--port', String(port), '--directory', '/project', '--title', 'Tests', ...flags]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).memory.body).toBe('Run the focused tests.');
    expect(result.stderr).toBe('');
  });
  it('returns JSON-only help and JSON-only validation failures without contacting a server', async () => {
    const before = requests;
    const help = await run(['--help', '--json']);
    expect(help.code).toBe(0);
    expect(JSON.parse(help.stdout).usage).toContain('openchamber memory');
    const failed = await run(['read', '--json']);
    expect(failed.code).not.toBe(0);
    expect(JSON.parse(failed.stdout).status).toBe('error');
    expect(requests).toBe(before);
  });
});
