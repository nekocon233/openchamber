import { describe, expect, it } from 'vitest';
import { registerOpenChamberRoutes } from './openchamber-routes.js';

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
    });
  });
});
