import express from 'express';
import type { Application, RequestHandler, Response } from '../shared/http-contracts.js';
import type { JsonObject, JsonValue } from '../shared/json-values.js';
import type { FollowUpQueueSnapshot } from './core.js';
import type { FollowUpQueueServerRuntime } from './server-runtime.js';

import {
  FollowUpQueueConflictError,
  FollowUpQueueError,
  FollowUpQueueIdempotencyError,
  FollowUpQueueItemConflictError,
  FollowUpQueueValidationError,
} from './errors.js';

const FOLLOW_UP_QUEUE_BODY_LIMIT_BYTES = 64 * 1024 * 1024;
const followUpQueueJson = express.json({ limit: FOLLOW_UP_QUEUE_BODY_LIMIT_BYTES });

const isEntityTooLargeError = (error: unknown): error is { type: 'entity.too.large' } => (
  Boolean(error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large')
);

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

export const parseFollowUpQueueBody: RequestHandler = (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  const rawLength = req.headers['content-length'];
  const contentLength = Number.parseInt(Array.isArray(rawLength) ? (rawLength[0] ?? '0') : (rawLength || '0'), 10);
  if (Number.isFinite(contentLength) && contentLength > FOLLOW_UP_QUEUE_BODY_LIMIT_BYTES) {
    return res.status(413).json({ error: 'Follow-up queue request exceeds maximum size of 67108864 bytes' });
  }
  if (!req.is('application/json')) {
    return res.status(415).json({ error: 'Follow-up queue requests require application/json' });
  }
  return followUpQueueJson(req, res, (error) => {
    if (!error) return next();
    if (isEntityTooLargeError(error)) {
      return res.status(413).json({ error: 'Follow-up queue request exceeds maximum size of 67108864 bytes' });
    }
    return res.status(400).json({ error: 'Follow-up queue request body must be valid JSON' });
  });
};

const loadSessionIdFromBody = (body: JsonValue | undefined): JsonValue | undefined => {
  if (!isPlainJsonObject(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'sessionId')) {
    throw new FollowUpQueueValidationError('load request must contain only sessionId');
  }
  return body.sessionId;
};

interface FollowUpQueueErrorPayload {
  error: string;
  code: string;
  latestSnapshot?: FollowUpQueueSnapshot;
}

const sendTypedError = (
  res: Response,
  status: number,
  error: FollowUpQueueError,
  extra?: { latestSnapshot?: FollowUpQueueSnapshot },
) => {
  const payload: FollowUpQueueErrorPayload = {
    error: error.message,
    code: error.code,
  };
  if (extra?.latestSnapshot !== undefined) {
    payload.latestSnapshot = extra.latestSnapshot;
  }
  return res.status(status).json(payload);
};

const sendStorageError = (res: Response, error: Error | FollowUpQueueError | { code?: string } | null, message: string) => (
  res.status(500).json({
    error: message,
    code: isErrorWithCode(error) ? error.code : 'FOLLOW_UP_QUEUE_STORAGE_FAILED',
  })
);

export const registerFollowUpQueueRoutes = (
  app: Application,
  followUpQueueRuntime: Pick<FollowUpQueueServerRuntime, 'load' | 'applyMutation'>,
) => {
  const sendCapabilities: RequestHandler = (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ authority: 'openchamber-host', version: 2 });
  };
  app.get('/auth/follow-up-queue/capabilities', sendCapabilities);
  app.get('/api/follow-up-queue/capabilities', sendCapabilities);

  const loadQueue: RequestHandler = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const body = isJsonValue(req.body) ? req.body : undefined;
      return res.json(await followUpQueueRuntime.load(loadSessionIdFromBody(body)));
    } catch (error) {
      if (error instanceof FollowUpQueueValidationError) {
        return sendTypedError(res, 400, error);
      }
      return sendStorageError(res, error instanceof Error ? error : (isErrorWithCode(error) ? error : null), 'Failed to load authoritative follow-up queue');
    }
  };

  const mutateQueue: RequestHandler = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const body = isJsonValue(req.body) ? req.body : undefined;
      return res.json(await followUpQueueRuntime.applyMutation(body));
    } catch (error) {
      if (error instanceof FollowUpQueueValidationError) {
        return sendTypedError(res, 400, error);
      }
      if (error instanceof FollowUpQueueConflictError) {
        return sendTypedError(res, 409, error, { latestSnapshot: error.latestSnapshot });
      }
      if (
        error instanceof FollowUpQueueIdempotencyError
        || error instanceof FollowUpQueueItemConflictError
      ) {
        return sendTypedError(res, 409, error);
      }
      return sendStorageError(res, error instanceof Error ? error : (isErrorWithCode(error) ? error : null), 'Failed to persist authoritative follow-up queue');
    }
  };

  app.post('/auth/follow-up-queue/load', parseFollowUpQueueBody, loadQueue);
  app.post('/auth/follow-up-queue/mutations', parseFollowUpQueueBody, mutateQueue);
  app.post('/api/follow-up-queue/load', parseFollowUpQueueBody, loadQueue);
  app.post('/api/follow-up-queue/mutations', parseFollowUpQueueBody, mutateQueue);
};
