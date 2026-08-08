import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import path from 'node:path';
import request from 'supertest';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock('../package-manager.js', () => ({
  checkForUpdates: vi.fn(),
  detectPackageManagerDetails: vi.fn(),
  getCurrentVersion: vi.fn(),
  getUpdateCommand: vi.fn(),
}));

const childProcess = await import('child_process');
const packageManager = await import('../package-manager.js');
const { registerOpenChamberRoutes } = await import('./openchamber-routes.js');

const SELF_UPDATE_DISTRIBUTION_POLICY = {
  id: 'openchamber/openchamber',
  repositoryUrl: 'https://github.com/openchamber/openchamber',
  webUpdateMode: 'self',
};

const createRouteRegistry = () => {
  const routes = new Map();
  return {
    app: {
      get(path, handler) {
        routes.set(`GET ${path}`, handler);
      },
      post(path, handler) {
        routes.set(`POST ${path}`, handler);
      },
    },
    get(method, path) {
      return routes.get(`${method} ${path}`);
    },
  };
};

const createResponse = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
});

describe('OpenChamber fork update policy', () => {
  it('reports web updates as externally managed', async () => {
    const registry = createRouteRegistry();
    registerOpenChamberRoutes(registry.app, {});
    const handler = registry.get('GET', '/api/openchamber/update-check');
    const response = createResponse();

    await handler({ query: { appType: 'web' }, headers: {} }, response);

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      available: false,
      updatePolicy: 'external',
      distribution: 'nekocon233/openchamber',
      repositoryUrl: 'https://github.com/nekocon233/openchamber',
    });
  });

  it('blocks the web update installer before spawning a package manager', async () => {
    const registry = createRouteRegistry();
    registerOpenChamberRoutes(registry.app, {});
    const handler = registry.get('POST', '/api/openchamber/update-install');
    const response = createResponse();

    await handler({}, response);

    expect(response.statusCode).toBe(403);
    expect(response.body).toMatchObject({
      updatePolicy: 'external',
      distribution: 'nekocon233/openchamber',
      repositoryUrl: 'https://github.com/nekocon233/openchamber',
    });
  });
});

const createApp = ({ environment = {}, storedOptions = {} } = {}) => {
  const app = express();
  const dependencies = {
    fs: {
      existsSync: vi.fn(() => false),
      promises: {
        readFile: vi.fn(async () => JSON.stringify({
          launchMode: 'foreground',
          port: 7897,
          ...storedOptions,
        })),
      },
    },
    path,
    process: {
      env: environment,
      platform: 'linux',
      execPath: '/usr/bin/node',
    },
    server: {
      address: () => ({ port: 7897 }),
    },
    __dirname: '/opt/openchamber/server',
    openchamberDataDir: '/tmp/openchamber',
    modelsDevApiUrl: 'https://models.example.test',
    modelsMetadataCacheTtl: 0,
    readSettingsFromDiskMigrated: vi.fn(),
    fetchFreeZenModels: vi.fn(),
    getCachedZenModels: vi.fn(),
    distributionPolicy: SELF_UPDATE_DISTRIBUTION_POLICY,
  };

  registerOpenChamberRoutes(app, dependencies);
  return { app, dependencies };
};

beforeEach(() => {
  packageManager.getCurrentVersion.mockReturnValue('1.18.1');
  packageManager.checkForUpdates.mockResolvedValue({
    available: true,
    version: '1.17.1',
  });
  packageManager.detectPackageManagerDetails.mockReturnValue({
    packageManager: 'npm',
  });
  packageManager.getUpdateCommand.mockReturnValue('npm install -g @openchamber/web@latest');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('OpenChamber foreground update route', () => {
  it('rejects a foreground update when the server is not owned by systemd', async () => {
    const { app } = createApp();

    await request(app)
      .post('/api/openchamber/update-install')
      .expect(409, {
        error: 'Foreground servers must be updated by their service manager. Set OPENCHAMBER_SYSTEMD_UNIT when running under systemd, or run openchamber update and restart the service.',
      });

    expect(childProcess.spawnSync).not.toHaveBeenCalled();
  });

  it('rejects an unsafe systemd unit override before starting an update job', async () => {
    const { app } = createApp({
      environment: {
        INVOCATION_ID: 'systemd-invocation',
        OPENCHAMBER_SYSTEMD_UNIT: 'openchamber.service; rm -rf /',
      },
    });

    await request(app)
      .post('/api/openchamber/update-install')
      .expect(409, {
        error: 'Foreground servers must be updated by their service manager. Set OPENCHAMBER_SYSTEMD_UNIT when running under systemd, or run openchamber update and restart the service.',
      });

    expect(childProcess.spawnSync).not.toHaveBeenCalled();
  });

  it('queues the install in a transient systemd unit and returns its job identifier', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    childProcess.spawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    const { app } = createApp({
      environment: {
        INVOCATION_ID: 'systemd-invocation',
        OPENCHAMBER_SYSTEMD_UNIT: 'openchamber@wsl.service',
        PATH: '/home/syu/.npm-global/bin:/usr/bin:/bin',
      },
    });

    await request(app)
      .post('/api/openchamber/update-install')
      .expect(200, {
        success: true,
        message: 'Update queued; OpenChamber will restart after installation completes',
        version: '1.17.1',
        packageManager: 'npm',
        autoRestart: true,
        restartManager: 'systemd',
        jobId: 'openchamber-update-1700000000000',
        logPath: 'journalctl --user-unit openchamber-update-1700000000000.service',
      });

    expect(childProcess.spawnSync).toHaveBeenCalledWith('systemd-run', [
      '--user',
      '--unit=openchamber-update-1700000000000',
      '--collect',
      '--service-type=exec',
      '--setenv=PATH=/home/syu/.npm-global/bin:/usr/bin:/bin',
      '/bin/sh',
      '-c',
      "set -eu\nnpm install -g @openchamber/web@latest\nsystemctl --user restart 'openchamber@wsl.service'",
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    });
  });
});
