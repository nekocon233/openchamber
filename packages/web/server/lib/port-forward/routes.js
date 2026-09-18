/**
 * The control surface for forwarded ports, on the OpenChamber origin.
 *
 * These run behind the normal `/api` authentication, and deliberately not
 * behind the host-local restriction the tunnel routes use: the whole point of a
 * forward is that a remote client — a browser on another machine — can reach a
 * dev server, so a remote client has to be able to turn one on.
 *
 * Every handler re-reads the configured host template first. The template is a
 * setting, so it can change under a long-lived server, and a forward built on a
 * hostname that no longer routes anywhere would hand out URLs that answer
 * nothing.
 */
import express from 'express';

import { isSafeRequestPath } from './runtime.js';

const portForwardJson = express.json({ limit: '4kb' });

/**
 * A port from JSON or from a route parameter. `Number()` turns `true` into 1,
 * which is not a port anybody asked for, so booleans are excluded first.
 */
const readPort = (value) => {
  if (value === true || value === false) return null;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
};

export const registerPortForwardRoutes = (app, { runtime, readHostTemplate }) => {
  /**
   * Returns the template error when there is one, so the client can say why
   * forwarding is unavailable instead of showing a control that does nothing.
   */
  const syncTemplate = async () => {
    try {
      return runtime.configure(await readHostTemplate());
    } catch {
      return { ok: false, error: 'Could not read the forward host template' };
    }
  };

  app.get('/api/port-forward', async (_req, res) => {
    const applied = await syncTemplate();
    res.json({
      configured: runtime.configured,
      template: runtime.template,
      templateError: applied.ok ? null : applied.error,
      forwards: runtime.list(),
    });
  });

  app.post('/api/port-forward', portForwardJson, async (req, res) => {
    const applied = await syncTemplate();
    if (!applied.ok) {
      res.status(409).json({ error: applied.error });
      return;
    }
    if (!runtime.configured) {
      res.status(409).json({
        error: 'Set a forward host template before forwarding a port.',
        reason: 'no-template',
      });
      return;
    }

    const port = readPort(req.body?.port);
    if (port === null) {
      res.status(400).json({ error: 'A valid port is required' });
      return;
    }

    const result = runtime.enable(port);
    if (!result.ok) {
      res.status(400).json({ error: 'That port cannot be forwarded', reason: result.error });
      return;
    }
    res.json({ port: result.port, origin: result.origin });
  });

  app.delete('/api/port-forward/:port', async (req, res) => {
    await syncTemplate();
    const port = readPort(req.params.port);
    if (port === null) {
      res.status(400).json({ error: 'A valid port is required' });
      return;
    }
    res.json({ stopped: runtime.disable(port) });
  });

  /**
   * Mints the single-use URL that opens a forwarded page. The browser follows
   * it, trades it for a cookie, and never carries it again.
   */
  app.post('/api/port-forward/grant', portForwardJson, async (req, res) => {
    await syncTemplate();
    const port = readPort(req.body?.port);
    if (port === null) {
      res.status(400).json({ error: 'A valid port is required' });
      return;
    }

    const path = req.body?.path ?? '/';
    if (!isSafeRequestPath(path)) {
      res.status(400).json({ error: 'path must be an absolute path on the forwarded origin' });
      return;
    }

    const url = runtime.issueGrantUrl(port, path);
    if (!url) {
      res.status(404).json({ error: `Port ${port} is not being forwarded` });
      return;
    }
    res.json({ url });
  });
};
