import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

// Config modules capture their paths on import. Give each test file a home and
// data directory before it loads them. A suite can then supply its own paths.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-test-data-'));
const home = path.join(root, 'home');
const data = path.join(root, 'data');
fs.mkdirSync(home);
fs.mkdirSync(data);
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.OPENCHAMBER_DATA_DIR = data;
delete process.env.XDG_CONFIG_HOME;
delete process.env.XDG_DATA_HOME;
delete process.env.XDG_STATE_HOME;
delete process.env.XDG_CACHE_HOME;
delete process.env.OPENCODE_CONFIG_DIR;
delete process.env.OPENCODE_CONFIG;
delete process.env.OPENCODE_CONFIG_CONTENT;

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});
