import express from 'express';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerPwaSessionSelectionRoutes } from './pwa-session-selection-routes.js';

const route = '/api/pwa/session-selection';

describe('PWA session selection', () => {
  let dataDir;
  let file;

  const client = () => {
    const app = express();
    registerPwaSessionSelectionRoutes(app, { express, dataDir });
    return request(app);
  };

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'pwa-session-selection-'));
    file = join(dataDir, 'pwa-session-selection.json');
  });

  afterEach(() => rm(dataDir, { recursive: true, force: true }));

  it('reads the latest selection from disk after a server restart', async () => {
    const app = client();
    await app.get(route).expect('Cache-Control', 'no-store').expect(200, { sessionId: null });

    await app.put(route).send({ sessionId: 'ses_first' }).expect(204);
    await app.put(route).send({ sessionId: 'ncv_second' }).expect(204);
    await client().get(route).expect(200, { sessionId: 'ncv_second' });
  });

  it('rejects missing IDs and extra fields without overwriting a selection', async () => {
    const app = client();
    await app.put(route).send({ sessionId: 'ses_first' }).expect(204);

    await app.put(route).send({ sessionId: null }).expect(400);
    await app.put(route).send({ sessionId: 'ses_second', directory: '/project' }).expect(400);
    await app.get(route).expect(200, { sessionId: 'ses_first' });
  });

  it('reports storage failures and accepts later writes', async () => {
    const app = client();
    await writeFile(file, 'broken');
    await app.get(route).expect(500);
    expect(await readFile(file, 'utf8')).toBe('broken');

    await rm(file);
    await mkdir(file);
    await app.put(route).send({ sessionId: 'ses_first' }).expect(500);

    await rm(file, { recursive: true });
    await app.put(route).send({ sessionId: 'ses_second' }).expect(204);
    await app.get(route).expect(200, { sessionId: 'ses_second' });
  });
});
