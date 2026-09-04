import { beforeEach, describe, expect, it, vi } from 'vitest';

import { registerSmallModelRoutes } from './routes.js';

const handlers = {};
const service = {
  describeSmallModel: vi.fn(),
  generateSmallModelText: vi.fn(),
  listAuthenticatedProviders: vi.fn(),
};

const app = {
  get: (route, handler) => { handlers[`GET ${route}`] = handler; },
  post: (route, handler) => { handlers[`POST ${route}`] = handler; },
};

registerSmallModelRoutes(app, { getSmallModelService: async () => service });

const response = () => {
  const res = {
    statusCode: 200,
    body: null,
    status: vi.fn((statusCode) => {
      res.statusCode = statusCode;
      return res;
    }),
    json: vi.fn((body) => {
      res.body = body;
      return res;
    }),
  };
  return res;
};

describe('small-model routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    service.describeSmallModel.mockResolvedValue(null);
    service.generateSmallModelText.mockResolvedValue({ text: 'ok' });
    service.listAuthenticatedProviders.mockResolvedValue([]);
  });

  it('uses the same directory for describe and picker provider resolution', async () => {
    const res = response();

    await handlers['GET /api/small-model']({
      query: { directory: '/workspace', providerID: 'anthropic', modelID: 'haiku' },
    }, res);

    expect(service.describeSmallModel).toHaveBeenCalledWith({
      directory: '/workspace',
      preferredProviderID: 'anthropic',
      preferredModelID: 'haiku',
    });
    expect(service.listAuthenticatedProviders).toHaveBeenCalledWith('/workspace');
    expect(res.statusCode).toBe(200);
  });

  it('preserves an omitted restriction so the core default remains active', async () => {
    const res = response();

    await handlers['POST /api/small-model/generate']({
      body: { prompt: 'summarize', preferredProviderID: 'anthropic' },
    }, res);

    expect(service.generateSmallModelText).toHaveBeenCalledWith(expect.objectContaining({
      preferredProviderID: 'anthropic',
      restrictToPreferredProvider: undefined,
    }));
  });

  it('preserves an explicit cross-provider opt-out', async () => {
    const res = response();

    await handlers['POST /api/small-model/generate']({
      body: {
        prompt: 'summarize',
        preferredProviderID: 'anthropic',
        restrictToPreferredProvider: false,
      },
    }, res);

    expect(service.generateSmallModelText).toHaveBeenCalledWith(expect.objectContaining({
      restrictToPreferredProvider: false,
    }));
  });

  it('keeps no-model failures as HTTP 404', async () => {
    const res = response();
    service.generateSmallModelText.mockRejectedValue(Object.assign(
      new Error('No small model available within the session provider'),
      { statusCode: 404 },
    ));

    await handlers['POST /api/small-model/generate']({ body: { prompt: 'summarize' } }, res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'No small model available within the session provider' });
  });
});
