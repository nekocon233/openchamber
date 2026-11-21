import type { Application, Response } from '../shared/http-contracts.js';
import type { JsonObject, JsonValue } from '../shared/json-values.js';
import type { SidebarSnapshot } from './schema.js';
import type { SidebarStateServerRuntime } from './server-runtime.js';
import {
  SidebarStateConflictError,
  SidebarStateError,
  SidebarStateIdempotencyError,
  SidebarStateLegacyWriteError,
  SidebarStateValidationError,
} from './errors.js';

const isErrorWithCode = (error: unknown): error is { code: string } => (
  Boolean(error && typeof error === 'object' && 'code' in error && typeof error.code === 'string')
);

const isPlainJsonObject = (value: unknown): value is JsonObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const isJsonValue = (value: unknown): value is JsonValue => (
  value === null
  || typeof value === 'string'
  || typeof value === 'number'
  || typeof value === 'boolean'
  || Array.isArray(value)
  || isPlainJsonObject(value)
);

interface SidebarErrorPayload {
  error: string;
  code: string;
  latestSnapshot?: SidebarSnapshot;
}

const sendError = (
  res: Response,
  status: number,
  error: SidebarStateError,
  extra?: { latestSnapshot?: SidebarSnapshot },
) => {
  const payload: SidebarErrorPayload = {
    error: error.message,
    code: error.code,
  };
  if (extra?.latestSnapshot !== undefined) {
    payload.latestSnapshot = extra.latestSnapshot;
  }
  return res.status(status).json(payload);
};

export const registerSidebarStateRoutes = (
  app: Application,
  sidebarStateRuntime: Pick<SidebarStateServerRuntime, 'readSnapshot' | 'applyMutation'>,
) => {
  app.get('/api/sidebar-state', async (_req, res) => {
    try {
      return res.json(await sidebarStateRuntime.readSnapshot());
    } catch (error) {
      return res.status(500).json({
        error: 'Failed to read authoritative sidebar state',
        code: isErrorWithCode(error) ? error.code : 'SIDEBAR_STATE_READ_FAILED',
      });
    }
  });

  app.post('/api/sidebar-state/mutations', async (req, res) => {
    try {
      const body = isJsonValue(req.body) ? req.body : undefined;
      return res.json(await sidebarStateRuntime.applyMutation(body));
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
        code: isErrorWithCode(error) ? error.code : 'SIDEBAR_STATE_STORAGE_FAILED',
      });
    }
  });
};
