import {
  SidebarStateConflictError,
  SidebarStateIdempotencyError,
  SidebarStateLegacyWriteError,
  SidebarStateValidationError,
} from './errors.js';

const sendError = (res, status, error, extra = {}) => res.status(status).json({
  error: error.message,
  code: error.code,
  ...extra,
});

export const registerSidebarStateRoutes = (app, sidebarStateRuntime) => {
  app.get('/api/sidebar-state', async (_req, res) => {
    try {
      return res.json(await sidebarStateRuntime.readSnapshot());
    } catch (error) {
      return res.status(500).json({
        error: 'Failed to read authoritative sidebar state',
        code: typeof error?.code === 'string' ? error.code : 'SIDEBAR_STATE_READ_FAILED',
      });
    }
  });

  app.post('/api/sidebar-state/mutations', async (req, res) => {
    try {
      return res.json(await sidebarStateRuntime.applyMutation(req.body));
    } catch (error) {
      if (error instanceof SidebarStateValidationError) {
        return sendError(res, 400, error);
      }
      if (error instanceof SidebarStateConflictError) {
        return sendError(res, 409, error, { latestSnapshot: error.latestSnapshot });
      }
      if (error instanceof SidebarStateIdempotencyError || error instanceof SidebarStateLegacyWriteError) {
        return sendError(res, 409, error);
      }
      return res.status(500).json({
        error: 'Failed to persist authoritative sidebar state',
        code: typeof error?.code === 'string' ? error.code : 'SIDEBAR_STATE_STORAGE_FAILED',
      });
    }
  });
};
