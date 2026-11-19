import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const selectionSchema = z.strictObject({
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
});
const route = '/api/pwa/session-selection';

export const registerPwaSessionSelectionRoutes = (app, { express, dataDir }) => {
  const file = join(dataDir, 'pwa-session-selection.json');
  let writes = Promise.resolve();

  app.get(route, async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      await writes;
      const raw = await readFile(file, 'utf8');
      res.json(selectionSchema.parse(JSON.parse(raw)));
    } catch (error) {
      if (error.code === 'ENOENT') return res.json({ sessionId: null });
      res.status(500).json({ error: 'Could not read the PWA session selection' });
    }
  });

  app.put(route, express.json({ limit: '1kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const selection = selectionSchema.safeParse(req.body);
    if (!selection.success) return res.status(400).json({ error: 'Invalid PWA session selection' });

    const write = writes.then(async () => {
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(selection.data), { flag: 'wx', mode: 0o600 });
        await rename(temporary, file);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
    });
    writes = write.catch(() => {});
    try {
      await write;
      res.sendStatus(204);
    } catch {
      res.status(500).json({ error: 'Could not save the PWA session selection' });
    }
  });
};
