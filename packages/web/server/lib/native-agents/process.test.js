import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { buildCliChildEnv } from './process.js';

describe('native CLI environment', () => {
  it('keeps server production mode and private runtime credentials out of project commands', () => {
    const parent = { ...process.env, NODE_ENV: 'production', OPENCHAMBER_TEST_SECRET: 'fixture', CLAUDECODE: '1', PROJECT_TEST_VALUE: 'retained' };
    const env = buildCliChildEnv(parent, process.env.PATH ?? '');
    const result = execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({ mode: process.env.NODE_ENV ?? null, privateValue: process.env.OPENCHAMBER_TEST_SECRET ?? null, nested: process.env.CLAUDECODE ?? null, project: process.env.PROJECT_TEST_VALUE }))'], { env, encoding: 'utf8' });
    expect(JSON.parse(result)).toEqual({ mode: null, privateValue: null, nested: null, project: 'retained' });
    expect(parent.NODE_ENV).toBe('production');
  });
});
