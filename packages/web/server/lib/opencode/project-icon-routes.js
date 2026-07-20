export const registerProjectIconRoutes = (app, dependencies) => {
  const {
    fsPromises,
    path,
    crypto,
    openchamberDataDir,
    readSettingsFromDiskMigrated,
    createFsSearchRuntime,
    spawn,
    resolveGitBinaryForSpawn,
    sidebarStateRuntime,
  } = dependencies;

  const projectIconsDirPath = path.join(openchamberDataDir, 'project-icons');
  const projectIconMimeToExtension = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/svg+xml': 'svg',
    'image/webp': 'webp',
    'image/x-icon': 'ico',
  };
  const projectIconExtensionToMime = Object.fromEntries(
    Object.entries(projectIconMimeToExtension).map(([mime, ext]) => [ext, mime])
  );
  const projectIconSupportedMimes = new Set(Object.keys(projectIconMimeToExtension));
  const projectIconMaxBytes = 5 * 1024 * 1024;
  const projectIconThemeColors = {
    light: '#111111',
    dark: '#f5f5f5',
  };
  const projectIconHexColorPattern = /^#(?:[\da-fA-F]{3}|[\da-fA-F]{4}|[\da-fA-F]{6}|[\da-fA-F]{8})$/;

  const normalizeProjectIconMime = (value) => {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim().toLowerCase();
    if (normalized === 'image/jpg') {
      return 'image/jpeg';
    }
    if (projectIconSupportedMimes.has(normalized)) {
      return normalized;
    }
    return null;
  };

  const projectIconBaseName = (projectId) => {
    const hash = crypto.createHash('sha1').update(projectId).digest('hex');
    return `project-${hash}`;
  };

  const projectIconPathForMime = (projectId, mime) => {
    const normalizedMime = normalizeProjectIconMime(mime);
    if (!normalizedMime) {
      return null;
    }
    const ext = projectIconMimeToExtension[normalizedMime];
    return path.join(projectIconsDirPath, `${projectIconBaseName(projectId)}.${ext}`);
  };

  const projectIconPathCandidates = (projectId) => {
    const base = projectIconBaseName(projectId);
    return Object.values(projectIconMimeToExtension).map((ext) => path.join(projectIconsDirPath, `${base}.${ext}`));
  };

  const removeProjectIconFiles = async (projectId, keepPath) => {
    const candidates = projectIconPathCandidates(projectId);
    await Promise.all(candidates.map(async (candidatePath) => {
      if (keepPath && candidatePath === keepPath) {
        return;
      }
      try {
        await fsPromises.unlink(candidatePath);
      } catch (error) {
        if (!error || typeof error !== 'object' || error.code !== 'ENOENT') {
          throw error;
        }
      }
    }));
  };

  const parseProjectIconDataUrl = (value) => {
    if (typeof value !== 'string') {
      return { ok: false, error: 'dataUrl is required' };
    }

    const trimmed = value.trim();
    const match = trimmed.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/i);
    if (!match) {
      return { ok: false, error: 'Invalid dataUrl format' };
    }

    const mime = normalizeProjectIconMime(match[1]);
    if (!mime || !['image/png', 'image/jpeg', 'image/svg+xml'].includes(mime)) {
      return { ok: false, error: 'Icon must be PNG, JPEG, or SVG' };
    }

    try {
      const base64 = match[2].replace(/\s+/g, '');
      const bytes = Buffer.from(base64, 'base64');
      if (bytes.length === 0) {
        return { ok: false, error: 'Icon content is empty' };
      }
      if (bytes.length > projectIconMaxBytes) {
        return { ok: false, error: 'Icon exceeds size limit (5 MB)' };
      }
      return { ok: true, mime, bytes };
    } catch {
      return { ok: false, error: 'Failed to decode icon data' };
    }
  };

  const normalizeProjectIconThemeVariant = (value) => {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim().toLowerCase();
    if (normalized === 'light' || normalized === 'dark') {
      return normalized;
    }
    return null;
  };

  const normalizeProjectIconColor = (value) => {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    if (!projectIconHexColorPattern.test(normalized)) {
      return null;
    }
    return normalized;
  };

  const applyProjectIconSvgTheme = (svgMarkup, themeVariant, iconColor) => {
    if (typeof svgMarkup !== 'string') {
      return svgMarkup;
    }

    const color = iconColor || projectIconThemeColors[themeVariant];
    if (!color) {
      return svgMarkup;
    }

    const svgTagIndex = svgMarkup.search(/<svg\b/i);
    if (svgTagIndex === -1) {
      return svgMarkup;
    }

    const svgOpenTagEndIndex = svgMarkup.indexOf('>', svgTagIndex);
    if (svgOpenTagEndIndex === -1) {
      return svgMarkup;
    }

    const overrideStyle = `<style data-openchamber-theme-icon="1">:root{color:${color}!important;}</style>`;
    return `${svgMarkup.slice(0, svgOpenTagEndIndex + 1)}${overrideStyle}${svgMarkup.slice(svgOpenTagEndIndex + 1)}`;
  };

  const findProjectById = (projects, projectId) => {
    const index = projects.findIndex((project) => project.id === projectId);
    if (index === -1) {
      return { projects, index: -1, project: null };
    }
    return { projects, index, project: projects[index] };
  };

  let iconMutationQueue = Promise.resolve();
  const enqueueIconMutation = (task) => {
    const result = iconMutationQueue.then(task, task);
    iconMutationQueue = result.then(() => undefined, () => undefined);
    return result;
  };

  const readProjectFiles = async (projectId) => {
    const files = new Map();
    for (const candidatePath of projectIconPathCandidates(projectId)) {
      try {
        files.set(candidatePath, await fsPromises.readFile(candidatePath));
      } catch (error) {
        if (!error || typeof error !== 'object' || error.code !== 'ENOENT') throw error;
      }
    }
    return files;
  };

  const restoreProjectFiles = async (projectId, files) => {
    await removeProjectIconFiles(projectId);
    if (files.size === 0) return;
    await fsPromises.mkdir(projectIconsDirPath, { recursive: true });
    for (const [filePath, bytes] of files) {
      await fsPromises.writeFile(filePath, bytes);
    }
  };

  const readProjectSnapshot = async (projectId) => {
    const snapshot = await sidebarStateRuntime.readSnapshot();
    return {
      snapshot,
      ...findProjectById(snapshot.projects, projectId),
    };
  };

  const updateProjectIconMetadata = (projectId, iconImage) => sidebarStateRuntime.applyOperation({
    type: 'project.update',
    projectId,
    patch: { iconImage },
  });

  const buildMutationResponse = async (projectId, result) => {
    const project = result.snapshot.projects.find((entry) => entry.id === projectId) || null;
    const settings = await readSettingsFromDiskMigrated();
    return { project, settings, snapshot: result.snapshot };
  };

  const fsSearchRuntime = createFsSearchRuntime({
    fsPromises,
    path,
    spawn,
    resolveGitBinaryForSpawn,
  });

  app.get('/api/projects/:projectId/icon', async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId.trim() : '';
    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    try {
      const { project } = await readProjectSnapshot(projectId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const metadataMime = normalizeProjectIconMime(project.iconImage?.mime);
      const preferredPath = metadataMime ? projectIconPathForMime(projectId, metadataMime) : null;
      const candidates = preferredPath
        ? [preferredPath, ...projectIconPathCandidates(projectId).filter((candidate) => candidate !== preferredPath)]
        : projectIconPathCandidates(projectId);

      const themeQuery = Array.isArray(req.query?.theme) ? req.query.theme[0] : req.query?.theme;
      const requestedThemeVariant = normalizeProjectIconThemeVariant(themeQuery);
      const iconColorQuery = Array.isArray(req.query?.iconColor) ? req.query.iconColor[0] : req.query?.iconColor;
      const requestedIconColor = normalizeProjectIconColor(iconColorQuery);

      for (const iconPath of candidates) {
        try {
          const data = await fsPromises.readFile(iconPath);
          const ext = path.extname(iconPath).slice(1).toLowerCase();
          const resolvedMime = iconPath === preferredPath && metadataMime
            ? metadataMime
            : projectIconExtensionToMime[ext] || 'application/octet-stream';
          const contentType = resolvedMime === 'image/svg+xml' ? 'image/svg+xml; charset=utf-8' : resolvedMime;

          if (resolvedMime === 'image/svg+xml' && requestedThemeVariant) {
            const svgMarkup = data.toString('utf8');
            const themedSvgMarkup = applyProjectIconSvgTheme(svgMarkup, requestedThemeVariant, requestedIconColor);
            res.setHeader('Content-Type', contentType);
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            return res.send(themedSvgMarkup);
          }

          if (resolvedMime === 'image/svg+xml' && requestedIconColor) {
            const svgMarkup = data.toString('utf8');
            const themedSvgMarkup = applyProjectIconSvgTheme(svgMarkup, requestedThemeVariant, requestedIconColor);
            res.setHeader('Content-Type', contentType);
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            return res.send(themedSvgMarkup);
          }

          res.setHeader('Content-Type', contentType);
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          return res.send(data);
        } catch (error) {
          if (!error || typeof error !== 'object' || error.code !== 'ENOENT') {
            console.warn('Failed to read project icon:', error);
            return res.status(500).json({ error: 'Failed to read project icon' });
          }
        }
      }

      return res.status(404).json({ error: 'Project icon not found' });
    } catch (error) {
      console.warn('Failed to load project icon:', error);
      return res.status(500).json({ error: 'Failed to load project icon' });
    }
  });

  app.put('/api/projects/:projectId/icon', async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId.trim() : '';
    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    const parsed = parseProjectIconDataUrl(req.body?.dataUrl);
    if (!parsed.ok) {
      return res.status(400).json({ error: parsed.error });
    }

    try {
      const result = await enqueueIconMutation(async () => {
        const { project } = await readProjectSnapshot(projectId);
        if (!project) return null;
        const iconPath = projectIconPathForMime(projectId, parsed.mime);
        if (!iconPath) throw Object.assign(new Error('Unsupported icon format'), { status: 400 });
        const previousFiles = await readProjectFiles(projectId);
        try {
          await fsPromises.mkdir(projectIconsDirPath, { recursive: true });
          await fsPromises.writeFile(iconPath, parsed.bytes);
          await removeProjectIconFiles(projectId, iconPath);
          return await updateProjectIconMetadata(projectId, {
            mime: parsed.mime,
            updatedAt: Date.now(),
            source: 'custom',
          });
        } catch (error) {
          await restoreProjectFiles(projectId, previousFiles);
          throw error;
        }
      });
      if (!result) return res.status(404).json({ error: 'Project not found' });
      return res.json(await buildMutationResponse(projectId, result));
    } catch (error) {
      if (error?.status === 400) return res.status(400).json({ error: error.message });
      console.warn('Failed to upload project icon:', error);
      return res.status(500).json({ error: 'Failed to upload project icon' });
    }
  });

  app.delete('/api/projects/:projectId/icon', async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId.trim() : '';
    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    try {
      const result = await enqueueIconMutation(async () => {
        const { project } = await readProjectSnapshot(projectId);
        if (!project) return null;
        const previousFiles = await readProjectFiles(projectId);
        try {
          await removeProjectIconFiles(projectId);
          return await updateProjectIconMetadata(projectId, null);
        } catch (error) {
          await restoreProjectFiles(projectId, previousFiles);
          throw error;
        }
      });
      if (!result) return res.status(404).json({ error: 'Project not found' });
      return res.json(await buildMutationResponse(projectId, result));
    } catch (error) {
      console.warn('Failed to remove project icon:', error);
      return res.status(500).json({ error: 'Failed to remove project icon' });
    }
  });

  app.post('/api/projects/:projectId/icon/discover', async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId.trim() : '';
    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    try {
      const force = req.body?.force === true;
      const payload = await enqueueIconMutation(async () => {
        const { project } = await readProjectSnapshot(projectId);
        if (!project) return { status: 404, error: 'Project not found' };
        if (project.iconImage?.source === 'custom' && !force) {
          return { project, skipped: true, reason: 'custom-icon-present' };
        }

        const faviconCandidates = await fsSearchRuntime.searchFilesystemFiles(project.path, {
          limit: 200,
          query: 'favicon',
          includeHidden: true,
          respectGitignore: false,
        });
        const selected = faviconCandidates
          .filter((entry) => /(^|\/)favicon\.(ico|png|svg|jpg|jpeg|webp)$/i.test(entry.path))
          .sort((a, b) => a.path.length - b.path.length)[0];
        if (!selected) return { status: 404, error: 'No favicon found in project' };

        const ext = path.extname(selected.path).slice(1).toLowerCase();
        const mime = projectIconExtensionToMime[ext] || null;
        if (!mime) return { status: 415, error: 'Unsupported favicon format' };
        const bytes = await fsPromises.readFile(selected.path);
        if (bytes.length === 0) return { status: 400, error: 'Discovered icon is empty' };
        if (bytes.length > projectIconMaxBytes) {
          return { status: 400, error: 'Discovered icon exceeds size limit (5 MB)' };
        }
        const iconPath = projectIconPathForMime(projectId, mime);
        if (!iconPath) return { status: 415, error: 'Unsupported favicon format' };

        const previousFiles = await readProjectFiles(projectId);
        try {
          await fsPromises.mkdir(projectIconsDirPath, { recursive: true });
          await fsPromises.writeFile(iconPath, bytes);
          await removeProjectIconFiles(projectId, iconPath);
          const result = await updateProjectIconMetadata(projectId, {
            mime,
            updatedAt: Date.now(),
            source: 'auto',
          });
          return {
            result,
            discoveredPath: selected.path,
          };
        } catch (error) {
          await restoreProjectFiles(projectId, previousFiles);
          throw error;
        }
      });
      if (payload.status) return res.status(payload.status).json({ error: payload.error });
      if (!payload.result) return res.json(payload);
      return res.json({
        ...await buildMutationResponse(projectId, payload.result),
        discoveredPath: payload.discoveredPath,
      });
    } catch (error) {
      console.warn('Failed to discover project icon:', error);
      return res.status(500).json({ error: 'Failed to discover project icon' });
    }
  });
};
