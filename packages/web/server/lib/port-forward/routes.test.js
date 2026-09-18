import { beforeEach, describe, expect, test } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createPortForwardRuntime } from './runtime.js';
import { registerPortForwardRoutes } from './routes.js';

const TEMPLATE = 'oc--{port}.example.com';

let template;
let templateReadFails;
let app;
let runtime;

beforeEach(() => {
  template = TEMPLATE;
  templateReadFails = false;
  runtime = createPortForwardRuntime({
    discoverDevServers: async () => ({ ok: true, servers: [{ port: 5173 }] }),
  });
  app = express();
  registerPortForwardRoutes(app, {
    runtime,
    readHostTemplate: async () => {
      if (templateReadFails) throw new Error('disk is on fire');
      return template;
    },
  });
});

describe('GET /api/port-forward', () => {
  test('reports the template in force and what is forwarded', async () => {
    runtime.configure(TEMPLATE);
    runtime.enable(5173);

    const response = await request(app).get('/api/port-forward').expect(200);

    expect(response.body).toEqual({
      configured: true,
      template: TEMPLATE,
      templateError: null,
      forwards: [{ port: 5173, origin: 'https://oc--5173.example.com' }],
    });
  });

  test('says why a stored template was refused, rather than looking unconfigured', async () => {
    template = 'oc.example.com';

    const response = await request(app).get('/api/port-forward').expect(200);

    expect(response.body.configured).toBe(false);
    expect(response.body.templateError).toContain('{port}');
  });

  test('reports a failed read as an error, not as "no template"', async () => {
    templateReadFails = true;

    const response = await request(app).get('/api/port-forward').expect(200);

    expect(response.body.templateError).toBe('Could not read the forward host template');
  });
});

describe('POST /api/port-forward', () => {
  test('turns a port on and returns the origin it now answers on', async () => {
    const response = await request(app).post('/api/port-forward').send({ port: 5173 }).expect(200);

    expect(response.body).toEqual({ port: 5173, origin: 'https://oc--5173.example.com' });
  });

  test('accepts a port sent as a string, as a form or URL would', async () => {
    await request(app).post('/api/port-forward').send({ port: '5173' }).expect(200);
    expect(runtime.list()).toHaveLength(1);
  });

  test('refuses when no template is configured', async () => {
    template = '';

    const response = await request(app).post('/api/port-forward').send({ port: 5173 }).expect(409);

    expect(response.body.reason).toBe('no-template');
  });

  test.each([
    ['a missing port', {}],
    ['a non-numeric port', { port: 'vite' }],
    ['a fractional port', { port: 1.5 }],
    ['a port out of range', { port: 70_000 }],
    // `Number(true)` is 1, which is a valid port and not what was meant.
    ['a boolean', { port: true }],
  ])('refuses %s', async (_label, body) => {
    await request(app).post('/api/port-forward').send(body).expect(400);
    expect(runtime.list()).toEqual([]);
  });
});

describe('DELETE /api/port-forward/:port', () => {
  test('stops a forward', async () => {
    runtime.configure(TEMPLATE);
    runtime.enable(5173);

    await request(app).delete('/api/port-forward/5173').expect(200, { stopped: true });
    expect(runtime.list()).toEqual([]);
  });

  test('stopping something already stopped is not an error', async () => {
    await request(app).delete('/api/port-forward/5173').expect(200, { stopped: false });
  });

  test('refuses a port that is not one', async () => {
    await request(app).delete('/api/port-forward/vite').expect(400);
  });
});

describe('POST /api/port-forward/grant', () => {
  test('mints a single-use URL for a forwarded port', async () => {
    await request(app).post('/api/port-forward').send({ port: 5173 }).expect(200);

    const response = await request(app)
      .post('/api/port-forward/grant')
      .send({ port: 5173, path: '/docs' })
      .expect(200);

    const url = new URL(response.body.url);
    expect(url.origin).toBe('https://oc--5173.example.com');
    expect(url.pathname).toBe('/docs');
    expect(url.searchParams.get('__oc_fwd')).toBeTruthy();
  });

  test('defaults to the root when no path is given', async () => {
    await request(app).post('/api/port-forward').send({ port: 5173 });

    const response = await request(app).post('/api/port-forward/grant').send({ port: 5173 }).expect(200);

    expect(new URL(response.body.url).pathname).toBe('/');
  });

  test('refuses a port that is not forwarded', async () => {
    await request(app).post('/api/port-forward/grant').send({ port: 5173 }).expect(404);
  });

  test.each([
    ['an absolute URL', 'https://evil.example/'],
    ['a protocol-relative URL', '//evil.example/'],
    ['a relative path', 'docs'],
  ])('refuses %s as a target', async (_label, path) => {
    await request(app).post('/api/port-forward').send({ port: 5173 });
    await request(app).post('/api/port-forward/grant').send({ port: 5173, path }).expect(400);
  });
});

describe('template synchronisation', () => {
  test('a template edited under a running server takes effect on the next call', async () => {
    await request(app).post('/api/port-forward').send({ port: 5173 }).expect(200);

    template = 'dev--{port}.example.com';

    // The forward is dropped rather than kept: the hostname the user was given
    // no longer routes anywhere, so leaving it listed would offer a dead URL.
    const response = await request(app).get('/api/port-forward').expect(200);
    expect(response.body.template).toBe('dev--{port}.example.com');
    expect(response.body.forwards).toEqual([]);
  });
});
