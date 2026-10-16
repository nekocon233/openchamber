/**
 * Project setup routes: the client-owned part of a project's config file
 * (worktree setup commands, project actions, draft starters).
 *
 * These replace the shared UI's direct `/api/fs/*` access to
 * `~/.config/openchamber/projects/<projectId>.json`. The client no longer
 * resolves the home directory or composes the path, and every write goes
 * through the same lock the scheduled-task writers hold.
 *
 * `/api/projects` is on the JSON-body allowlist in `core-routes.js`, so
 * `req.body` is parsed here without a per-route parser.
 */

import { isRecord as isObjectRecord } from '../shared/guards.js';
import path from 'node:path';
import { z } from 'zod';
import { createProjectIdFromPath } from './project-id.js';
import { isProjectSetupValidationError } from './project-setup.js';

const directoryRequestSchema = z.object({
  path: z.string().trim().catch(''),
  create: z.literal(true).catch(false),
}).catch({ path: '', create: false });

const respondWithError = (res, error, fallbackMessage) => {
  const message = error instanceof Error ? error.message : fallbackMessage;
  if (isProjectSetupValidationError(error)) {
    return res.status(400).json({ error: message });
  }
  return res.status(500).json({ error: message || fallbackMessage });
};

export const registerProjectDirectoryRoutes = (app, dependencies) => {
  const { fsPromises, validateDirectoryPath, sidebarStateRuntime, readSettingsFromDisk, persistSettings } = dependencies;

  app.post('/api/openchamber/directory', async (req, res) => {
    try {
      const { path: requestedPath, create } = directoryRequestSchema.parse(req.body);
      if (!requestedPath) {
        return res.status(400).json({ error: 'Path is required' });
      }

      if (create) {
        await fsPromises.mkdir(path.resolve(requestedPath), { recursive: true });
      }

      const validated = await validateDirectoryPath(requestedPath);
      if (!validated.ok) {
        return res.status(400).json({ error: validated.error });
      }

      const resolvedPath = validated.directory;
      // Projects belong to the revisioned sidebar state, so activation adds the
      // project through `project.add` instead of writing `settings.projects`
      // directly; `persistSettings` rejects that write at the server boundary.
      const currentSnapshot = await sidebarStateRuntime.readSnapshot();
      const existing = currentSnapshot.projects.find((project) => project.path === resolvedPath) || null;
      if (!existing) {
        await sidebarStateRuntime.applyOperation({
          type: 'project.add',
          project: {
            id: createProjectIdFromPath(resolvedPath),
            path: resolvedPath,
            addedAt: Date.now(),
          },
        });
      }

      await persistSettings({ lastDirectory: resolvedPath });
      const updated = await sidebarStateRuntime.projectSettingsProjection(await readSettingsFromDisk());

      return res.json({
        success: true,
        restarted: false,
        path: resolvedPath,
        settings: updated,
      });
    } catch (error) {
      console.error('Failed to update project directory:', error);
      return res.status(500).json({ error: error.message || 'Failed to update working directory' });
    }
  });
};

export const registerProjectSetupRoutes = (app, dependencies) => {
  const { projectConfigRuntime } = dependencies;

  app.get('/api/projects/:projectId/config', async (req, res) => {
    try {
      return res.json(await projectConfigRuntime.readProjectSetup(req.params.projectId));
    } catch (error) {
      return respondWithError(res, error, 'Failed to read project config');
    }
  });

  // The team's shared file in the checkout; see `updateSharedProjectSetup`.
  app.put('/api/projects/:projectId/config/shared', async (req, res) => {
    if (!isObjectRecord(req.body)) {
      return res.status(400).json({ error: 'Body must be an object' });
    }
    try {
      return res.json(await projectConfigRuntime.updateSharedProjectSetup(req.params.projectId, req.body));
    } catch (error) {
      return respondWithError(res, error, 'Failed to save the shared project config');
    }
  });

  app.put('/api/projects/:projectId/config', async (req, res) => {
    if (!isObjectRecord(req.body)) {
      return res.status(400).json({ error: 'Body must be an object' });
    }
    try {
      return res.json(await projectConfigRuntime.updateProjectSetup(req.params.projectId, req.body));
    } catch (error) {
      return respondWithError(res, error, 'Failed to save project config');
    }
  });
};
