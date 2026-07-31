import express from 'express';

import {
  FollowUpQueueConflictError,
  FollowUpQueueIdempotencyError,
  FollowUpQueueItemConflictError,
  FollowUpQueueValidationError,
} from './errors.js';

const FOLLOW_UP_QUEUE_BODY_LIMIT_BYTES = 64 * 1024 * 1024;
const followUpQueueJson = express.json({ limit: FOLLOW_UP_QUEUE_BODY_LIMIT_BYTES });

export const parseFollowUpQueueBody = (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  const contentLength = Number.parseInt(req.headers['content-length'] || '0', 10);
  if (Number.isFinite(contentLength) && contentLength > FOLLOW_UP_QUEUE_BODY_LIMIT_BYTES) {
    return res.status(413).json({ error: 'Follow-up queue request exceeds maximum size of 67108864 bytes' });
  }
  if (!req.is('application/json')) {
    return res.status(415).json({ error: 'Follow-up queue requests require application/json' });
  }
  return followUpQueueJson(req, res, (error) => {
    if (!error) return next();
    if (error.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Follow-up queue request exceeds maximum size of 67108864 bytes' });
    }
    return res.status(400).json({ error: 'Follow-up queue request body must be valid JSON' });
  });
};

const isRecord = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const loadSessionIdFromBody = (body) => {
  if (!isRecord(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'sessionId')) {
    throw new FollowUpQueueValidationError('load request must contain only sessionId');
  }
  return body.sessionId;
};

const sendTypedError = (res, status, error, extra = {}) => res.status(status).json({
  error: error.message,
  code: error.code,
  ...extra,
});

const sendStorageError = (res, error, message) => res.status(500).json({
  error: message,
  code: typeof error?.code === 'string' ? error.code : 'FOLLOW_UP_QUEUE_STORAGE_FAILED',
});

export const registerFollowUpQueueRoutes = (app, followUpQueueRuntime) => {
  const sendCapabilities = (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ authority: 'openchamber-host', version: 2 });
  };
  app.get('/auth/follow-up-queue/capabilities', sendCapabilities);
  app.get('/api/follow-up-queue/capabilities', sendCapabilities);

  const loadQueue = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      return res.json(await followUpQueueRuntime.load(loadSessionIdFromBody(req.body)));
    } catch (error) {
      if (error instanceof FollowUpQueueValidationError) {
        return sendTypedError(res, 400, error);
      }
      return sendStorageError(res, error, 'Failed to load authoritative follow-up queue');
    }
  };

  const mutateQueue = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      return res.json(await followUpQueueRuntime.applyMutation(req.body));
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
      return sendStorageError(res, error, 'Failed to persist authoritative follow-up queue');
    }
  };

  app.post('/auth/follow-up-queue/load', parseFollowUpQueueBody, loadQueue);
  app.post('/auth/follow-up-queue/mutations', parseFollowUpQueueBody, mutateQueue);
  app.post('/api/follow-up-queue/load', parseFollowUpQueueBody, loadQueue);
  app.post('/api/follow-up-queue/mutations', parseFollowUpQueueBody, mutateQueue);
};
