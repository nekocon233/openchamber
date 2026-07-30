import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerAuthAndAccessRoutes, registerCommonRequestMiddleware } from '../opencode/core-routes.js';
import { createFollowUpQueueServerRuntime } from './index.js';
import { parseFollowUpQueueBody, registerFollowUpQueueRoutes } from './routes.js';

const temporaryRoots = new Set();

afterEach(async () => {
  const roots = [...temporaryRoots];
  temporaryRoots.clear();
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
});

const createRuntime = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-follow-up-routes-'));
  temporaryRoots.add(root);
  const rootDirectory = path.join(root, 'follow-up-queue');
  const runtime = createFollowUpQueueServerRuntime({
    fsPromises: fs,
    path,
    rootDirectory,
    broadcastGlobalUiEvent: vi.fn(),
    now: () => 1_000,
  });
  return { runtime, rootDirectory };
};

const item = {
  id: 'item-route',
  messageId: 'message-route',
  content: 'synthetic route content',
  createdAt: 1_000,
  status: 'staged',
};

describe('follow-up queue routes', () => {
  it('serves both route namespaces with no-store validation, conflict, and storage responses', async () => {
    const { runtime, rootDirectory } = await createRuntime();
    const app = express();
    registerFollowUpQueueRoutes(app, runtime);
    const sessionId = 'session-route';

    for (const route of [
      '/auth/follow-up-queue/capabilities',
      '/api/follow-up-queue/capabilities',
    ]) {
      const response = await request(app).get(route).expect(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toEqual({ authority: 'openchamber-host', version: 1 });
    }

    const loaded = await request(app)
      .post('/auth/follow-up-queue/load')
      .send({ sessionId })
      .expect(200);
    expect(loaded.headers['cache-control']).toBe('no-store');
    expect(loaded.body).toEqual({
      scopeToken: expect.stringMatching(/^[\da-f]{64}$/),
      revision: 0,
      items: [],
    });
    await request(app)
      .post('/api/follow-up-queue/load')
      .send({ sessionId })
      .expect(200, loaded.body);

    const invalidLoad = await request(app)
      .post('/api/follow-up-queue/load')
      .send({ sessionId, extra: true })
      .expect(400);
    expect(invalidLoad.headers['cache-control']).toBe('no-store');
    expect(invalidLoad.body.code).toBe('FOLLOW_UP_QUEUE_VALIDATION');

    const invalidMutation = await request(app)
      .post('/api/follow-up-queue/mutations')
      .send({
        sessionId,
        baseRevision: 0,
        clientMutationId: 'route-invalid',
        operation: { type: 'add', item: { ...item, file: {} } },
      })
      .expect(400);
    expect(invalidMutation.body.code).toBe('FOLLOW_UP_QUEUE_VALIDATION');

    const invalidJson = await request(app)
      .post('/api/follow-up-queue/load')
      .set('Content-Type', 'application/json')
      .send('{')
      .expect(400);
    expect(invalidJson.headers['cache-control']).toBe('no-store');
    expect(invalidJson.body.error).toBe('Follow-up queue request body must be valid JSON');

    const invalidMediaType = await request(app)
      .post('/api/follow-up-queue/load')
      .type('form')
      .send({ sessionId })
      .expect(415);
    expect(invalidMediaType.body.error).toBe('Follow-up queue requests require application/json');

    const oversizedResponse = {
      headers: {},
      statusCode: 0,
      body: null,
      setHeader(name, value) {
        this.headers[name.toLowerCase()] = value;
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      },
    };
    parseFollowUpQueueBody({
      headers: { 'content-length': String((64 * 1024 * 1024) + 1) },
      is: () => true,
    }, oversizedResponse, () => {
      throw new Error('oversized body must not reach the JSON parser');
    });
    expect(oversizedResponse.statusCode).toBe(413);
    expect(oversizedResponse.headers['cache-control']).toBe('no-store');
    expect(oversizedResponse.body.error).toBe('Follow-up queue request exceeds maximum size of 67108864 bytes');

    const mutation = {
      sessionId,
      baseRevision: 0,
      clientMutationId: 'route-add',
      operation: { type: 'add', item },
    };
    const applied = await request(app)
      .post('/auth/follow-up-queue/mutations')
      .send(mutation)
      .expect(200);
    expect(applied.body).toMatchObject({ applied: true, mutationRevision: 1 });

    const conflict = await request(app)
      .post('/api/follow-up-queue/mutations')
      .send({
        sessionId,
        baseRevision: 0,
        clientMutationId: 'route-stale',
        operation: { type: 'remove', itemId: item.id },
      })
      .expect(409);
    expect(conflict.headers['cache-control']).toBe('no-store');
    expect(conflict.body).toMatchObject({
      code: 'FOLLOW_UP_QUEUE_CONFLICT',
      latestSnapshot: { revision: 1, items: [{ id: item.id }] },
    });

    const reused = await request(app)
      .post('/api/follow-up-queue/mutations')
      .send({
        ...mutation,
        operation: { type: 'remove', itemId: item.id },
      })
      .expect(409);
    expect(reused.body.code).toBe('FOLLOW_UP_QUEUE_IDEMPOTENCY_KEY_REUSED');

    await fs.writeFile(path.join(rootDirectory, `${loaded.body.scopeToken}.json`), '{', 'utf8');
    const loadFailure = await request(app)
      .post('/api/follow-up-queue/load')
      .send({ sessionId })
      .expect(500);
    expect(loadFailure.body).toEqual({
      error: 'Failed to load authoritative follow-up queue',
      code: 'FOLLOW_UP_QUEUE_CORRUPT',
    });
    const mutationFailure = await request(app)
      .post('/api/follow-up-queue/mutations')
      .send({
        sessionId,
        baseRevision: 1,
        clientMutationId: 'route-corrupt',
        operation: { type: 'remove', itemId: item.id },
      })
      .expect(500);
    expect(mutationFailure.body).toEqual({
      error: 'Failed to persist authoritative follow-up queue',
      code: 'FOLLOW_UP_QUEUE_CORRUPT',
    });
  });

  it('authenticates both namespaces before buffering their route-local JSON bodies', async () => {
    const runtime = {
      load: vi.fn(async () => ({ scopeToken: 'a'.repeat(64), revision: 0, items: [] })),
      applyMutation: vi.fn(async () => ({
        snapshot: { scopeToken: 'a'.repeat(64), revision: 0, items: [] },
        applied: false,
        deduplicated: false,
        mutationRevision: null,
      })),
    };
    const app = express();
    registerCommonRequestMiddleware(app, { express });
    registerAuthAndAccessRoutes(app, {
      express,
      tunnelAuthController: {
        classifyRequestScope: () => 'unknown-public',
        getTunnelSessionFromRequest: () => null,
        clearTunnelSessionCookie: vi.fn(),
        exchangeBootstrapToken: vi.fn(),
      },
      uiAuthController: {
        enabled: false,
        requireAuth: vi.fn((_req, _res, next) => next()),
        requireClientAuth: vi.fn((req, res, next) => {
          if (req.headers.authorization === 'Bearer synthetic-client') return next();
          return res.status(401).json({ error: 'Client authentication required' });
        }),
        handleSessionStatus: vi.fn(),
        handleSessionCreate: vi.fn(),
        handleUrlAuthToken: vi.fn(),
        handlePasskeyStatus: vi.fn(),
        handlePasskeyAuthenticationOptions: vi.fn(),
        handlePasskeyAuthenticationVerify: vi.fn(),
        handlePasskeyRegistrationOptions: vi.fn(),
        handlePasskeyRegistrationVerify: vi.fn(),
        handlePasskeyList: vi.fn(),
        handlePasskeyRevoke: vi.fn(),
        handleResetAuth: vi.fn(),
      },
      readSettingsFromDiskMigrated: vi.fn(async () => ({})),
      normalizeTunnelSessionTtlMs: vi.fn(),
    });
    registerFollowUpQueueRoutes(app, runtime);

    for (const route of [
      '/auth/follow-up-queue/mutations',
      '/api/follow-up-queue/mutations',
    ]) {
      const response = await request(app)
        .post(route)
        .set('Content-Type', 'application/json')
        .set('Content-Length', String((64 * 1024 * 1024) + 1))
        .expect(401, { error: 'Client authentication required' });
      expect(response.headers['cache-control']).toBe('no-store');
    }
    expect(runtime.applyMutation).not.toHaveBeenCalled();

    await request(app)
      .post('/auth/follow-up-queue/load')
      .set('Authorization', 'Bearer synthetic-client')
      .send({ sessionId: 'session-auth-route' })
      .expect(200);
    await request(app)
      .post('/api/follow-up-queue/load')
      .set('Authorization', 'Bearer synthetic-client')
      .send({ sessionId: 'session-auth-route' })
      .expect(200);
    expect(runtime.load).toHaveBeenCalledTimes(2);
  });
});
