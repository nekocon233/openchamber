export const registerSessionFoldersRoutes = (app, dependencies) => {
  const { sidebarStateRuntime } = dependencies;

  app.get('/api/session-folders', async (_req, res) => {
    try {
      const snapshot = await sidebarStateRuntime.readSnapshot();
      return res.json({
        version: 2,
        revision: snapshot.revision,
        foldersMap: snapshot.sessionFoldersByScope,
        collapsedFolderIds: [],
      });
    } catch {
      return res.status(500).json({ error: 'Failed to read session folders' });
    }
  });

  app.post('/api/session-folders', async (_req, res) => {
    return res.status(409).json({
      error: 'Session folders are revisioned through /api/sidebar-state/mutations',
      code: 'SIDEBAR_STATE_LEGACY_WRITE_REJECTED',
    });
  });
};
