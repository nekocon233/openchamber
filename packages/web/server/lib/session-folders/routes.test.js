import { describe, expect, it, vi } from 'vitest';

import { registerSessionFoldersRoutes } from './routes.js';

const createRouteRegistry = () => {
  const routes = new Map();
  return {
    app: {
      get(routePath, handler) {
        routes.set(`GET ${routePath}`, handler);
      },
      post(routePath, handler) {
        routes.set(`POST ${routePath}`, handler);
      },
    },
    getRoute(method, routePath) {
      return routes.get(`${method} ${routePath}`);
    },
  };
};

const createMockResponse = () => {
  let statusCode = 200;
  let body = null;
  return {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  };
};

describe('session folders compatibility routes', () => {
  it('projects authoritative folders through the legacy GET route', async () => {
    const { app, getRoute } = createRouteRegistry();
    const sidebarStateRuntime = {
      readSnapshot: vi.fn(async () => ({
        revision: 7,
        sessionFoldersByScope: {
          '/workspace/project': [{
            id: 'folder-one',
            name: 'Work',
            sessionIds: ['session-one'],
            createdAt: 1,
            parentId: null,
          }],
        },
      })),
    };
    registerSessionFoldersRoutes(app, { sidebarStateRuntime });

    const response = createMockResponse();
    await getRoute('GET', '/api/session-folders')({}, response);

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      version: 2,
      revision: 7,
      foldersMap: {
        '/workspace/project': [{
          id: 'folder-one',
          name: 'Work',
          sessionIds: ['session-one'],
          createdAt: 1,
          parentId: null,
        }],
      },
      collapsedFolderIds: [],
    });
  });

  it('does not turn an authoritative read failure into empty folders', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerSessionFoldersRoutes(app, {
      sidebarStateRuntime: { readSnapshot: vi.fn(async () => { throw new Error('read failed'); }) },
    });

    const response = createMockResponse();
    await getRoute('GET', '/api/session-folders')({}, response);

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({ error: 'Failed to read session folders' });
  });

  it('rejects legacy whole-file writes', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerSessionFoldersRoutes(app, { sidebarStateRuntime: {} });

    const response = createMockResponse();
    await getRoute('POST', '/api/session-folders')({ body: {} }, response);

    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({
      error: 'Session folders are revisioned through /api/sidebar-state/mutations',
      code: 'SIDEBAR_STATE_LEGACY_WRITE_REJECTED',
    });
  });
});
