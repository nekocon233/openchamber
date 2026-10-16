import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerCommonRequestMiddleware } from '../opencode/core-routes.js';
import { registerProjectDirectoryRoutes } from './routes.js';

const createApp = (overrides = {}) => {
  const app = express();
  registerCommonRequestMiddleware(app, { express });
  // One document behind both writers, so the response reflects what was stored
  // rather than what a mock happened to return.
  let storedSettings = { projects: [] };
  const dependencies = {
    fsPromises: { mkdir: vi.fn(async () => undefined) },
    validateDirectoryPath: vi.fn(async (directory) => ({ ok: true, directory })),
    sidebarStateRuntime: {
      readSnapshot: vi.fn(async () => ({ projects: [] })),
      applyOperation: vi.fn(async () => undefined),
      projectSettingsProjection: vi.fn(async (settings) => settings),
    },
    readSettingsFromDisk: vi.fn(async () => storedSettings),
    persistSettings: vi.fn(async (changes) => {
      storedSettings = { ...storedSettings, ...changes };
      return storedSettings;
    }),
    ...overrides,
  };
  registerProjectDirectoryRoutes(app, dependencies);
  return { app, dependencies };
};

describe('OpenChamber project directory route', () => {
  it('creates and activates a requested project outside the active workspace', async () => {
    const { app, dependencies } = createApp();

    const response = await request(app)
      .post('/api/openchamber/directory')
      .send({ path: '/projects/testing-one', create: true })
      .expect(200);

    expect(dependencies.fsPromises.mkdir).toHaveBeenCalledWith('/projects/testing-one', { recursive: true });
    expect(dependencies.validateDirectoryPath).toHaveBeenCalledWith('/projects/testing-one');
    expect(dependencies.sidebarStateRuntime.applyOperation).toHaveBeenCalledWith({
      type: 'project.add',
      project: expect.objectContaining({ path: '/projects/testing-one' }),
    });
    expect(dependencies.persistSettings).toHaveBeenCalledWith({ lastDirectory: '/projects/testing-one' });
    expect(response.body).toMatchObject({
      success: true,
      restarted: false,
      path: '/projects/testing-one',
      settings: { lastDirectory: '/projects/testing-one' },
    });
  });

  it('does not create a directory for the existing activation flow', async () => {
    const { app, dependencies } = createApp();

    await request(app)
      .post('/api/openchamber/directory')
      .send({ path: '/projects/existing' })
      .expect(200);

    expect(dependencies.fsPromises.mkdir).not.toHaveBeenCalled();
  });

  it('activates an existing project without adding it again', async () => {
    const project = { id: 'existing', path: '/projects/existing', addedAt: 123 };
    const { app, dependencies } = createApp({
      sidebarStateRuntime: {
        readSnapshot: vi.fn(async () => ({ projects: [project] })),
        applyOperation: vi.fn(async () => undefined),
        projectSettingsProjection: vi.fn(async () => ({ projects: [project], activeProjectId: 'existing', lastDirectory: '/projects/existing' })),
      },
    });

    const response = await request(app)
      .post('/api/openchamber/directory')
      .send({ path: ' /projects/existing ' })
      .expect(200);

    expect(dependencies.sidebarStateRuntime.applyOperation).not.toHaveBeenCalled();
    expect(dependencies.persistSettings).toHaveBeenCalledWith({ lastDirectory: '/projects/existing' });
    expect(response.body.settings).toEqual({
      projects: [project],
      activeProjectId: 'existing',
      lastDirectory: '/projects/existing',
    });
    expect(dependencies.validateDirectoryPath).toHaveBeenCalledWith('/projects/existing');
  });

  it('never writes the project list through the settings writer', async () => {
    const { app, dependencies } = createApp();

    await request(app)
      .post('/api/openchamber/directory')
      .send({ path: '/projects/testing-one', create: true })
      .expect(200);

    for (const [changes] of dependencies.persistSettings.mock.calls) {
      expect(changes).not.toHaveProperty('projects');
      expect(changes).not.toHaveProperty('activeProjectId');
    }
  });

  it.each([{}, { path: '' }, { path: '  ' }, { path: 42 }])('refuses an invalid path without side effects: %j', async (body) => {
    const { app, dependencies } = createApp();
    await request(app).post('/api/openchamber/directory').send(body).expect(400);
    expect(dependencies.fsPromises.mkdir).not.toHaveBeenCalled();
    expect(dependencies.validateDirectoryPath).not.toHaveBeenCalled();
    expect(dependencies.persistSettings).not.toHaveBeenCalled();
  });

  it('does not update settings when directory validation fails', async () => {
    const { app, dependencies } = createApp({
      validateDirectoryPath: vi.fn(async () => ({ ok: false, error: 'Directory not found' })),
    });
    const response = await request(app)
      .post('/api/openchamber/directory')
      .send({ path: '/projects/missing' })
      .expect(400);
    expect(response.body).toEqual({ error: 'Directory not found' });
    expect(dependencies.persistSettings).not.toHaveBeenCalled();
  });

  it('reports persistence failure rather than successful activation', async () => {
    const { app, dependencies } = createApp({
      persistSettings: vi.fn(async () => { throw new Error('Settings write failed'); }),
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await request(app)
        .post('/api/openchamber/directory')
        .send({ path: '/projects/new', create: true })
        .expect(500);
      expect(response.body).toEqual({ error: 'Settings write failed' });
      expect(dependencies.fsPromises.mkdir).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
    }
  });

  it('does not register the former OpenCode directory route', async () => {
    const { app, dependencies } = createApp();
    await request(app).post('/api/opencode/directory').send({ path: '/projects/existing' }).expect(404);
    expect(dependencies.persistSettings).not.toHaveBeenCalled();
  });
});
