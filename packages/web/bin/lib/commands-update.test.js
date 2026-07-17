import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

import { createUpdateCommand } from './commands-update.js';

async function withTempOpenChamberDataDir(fn) {
  const previous = process.env.OPENCHAMBER_DATA_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-update-test-'));
  process.env.OPENCHAMBER_DATA_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (typeof previous === 'string') {
      process.env.OPENCHAMBER_DATA_DIR = previous;
    } else {
      delete process.env.OPENCHAMBER_DATA_DIR;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('update command', () => {
  it('uses the package-manager helpers on the update-available path', async () => {
    await withTempOpenChamberDataDir(async () => {
      const originalWrite = process.stdout.write;
      process.stdout.write = vi.fn(() => true);
      const executeUpdate = vi.fn(() => ({ success: true, exitCode: 0 }));
      const updateCommand = createUpdateCommand({
        packageManagerPath: '/fake/package-manager.js',
        serveCommand: vi.fn(),
        importFromFilePath: vi.fn(async () => ({
          checkForUpdates: vi.fn(async () => ({ available: true, version: '9.9.9' })),
          detectPackageManager: vi.fn(() => 'npm'),
          executeUpdate,
          getCurrentVersion: vi.fn(() => '1.0.0'),
        })),
      });

      try {
        await updateCommand({ json: true });

        expect(executeUpdate).toHaveBeenCalledWith('npm', { silent: true });
      } finally {
        process.stdout.write = originalWrite;
      }
    });
  });

  it('does not invoke the official updater for externally managed distributions', async () => {
    await withTempOpenChamberDataDir(async () => {
      const originalWrite = process.stdout.write;
      let output = '';
      process.stdout.write = vi.fn((chunk) => {
        output += String(chunk);
        return true;
      });
      const checkForUpdates = vi.fn();
      const executeUpdate = vi.fn();
      const updateCommand = createUpdateCommand({
        packageManagerPath: '/fake/package-manager.js',
        serveCommand: vi.fn(),
        distributionPolicy: {
          id: 'nekocon233/openchamber',
          repositoryUrl: 'https://github.com/nekocon233/openchamber',
          webUpdateMode: 'external',
        },
        importFromFilePath: vi.fn(async () => ({
          checkForUpdates,
          detectPackageManager: vi.fn(),
          executeUpdate,
          getCurrentVersion: vi.fn(() => '1.16.1'),
        })),
      });

      try {
        await updateCommand({ json: true });

        expect(JSON.parse(output)).toMatchObject({
          status: 'ok',
          currentVersion: '1.16.1',
          updated: false,
          selfUpdate: 'external',
          distribution: 'nekocon233/openchamber',
        });
        expect(checkForUpdates).not.toHaveBeenCalled();
        expect(executeUpdate).not.toHaveBeenCalled();
      } finally {
        process.stdout.write = originalWrite;
      }
    });
  });
});
