import { createHash, randomUUID } from 'node:crypto';

import {
  FollowUpQueueConflictError,
  FollowUpQueueCorruptError,
  FollowUpQueueIdempotencyError,
  FollowUpQueueItemConflictError,
  FollowUpQueueReadError,
  FollowUpQueueValidationError,
  FollowUpQueueWriteError,
} from './errors.js';

const FOLLOW_UP_QUEUE_STORAGE_VERSION = 1;
const DEFAULT_MUTATION_DEDUPE_LIMIT = 256;
const MAX_PERSISTED_MUTATION_DEDUPE = 4096;
const MAX_FOLLOW_UP_QUEUE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_ITEMS = 256;
const MAX_ATTACHMENTS_PER_ITEM = 32;
const MAX_ATTACHMENTS_PER_QUEUE = 512;
const MAX_CONTENT_BYTES = 1024 * 1024;
const MAX_TOTAL_CONTENT_BYTES = 4 * 1024 * 1024;
const MAX_ATTACHMENT_DATA_URL_BYTES = 56 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_STRING_BYTES = 56 * 1024 * 1024;
const MAX_ATTACHMENT_SIZE = 2 * 1024 * 1024 * 1024;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_SESSION_ID_LENGTH = 256;
const MAX_SESSION_ID_BYTES = 1024;
const MAX_MIME_TYPE_BYTES = 256;
const MAX_FILENAME_BYTES = 4096;
const MAX_ATTACHMENT_PATH_BYTES = 16 * 1024;
const MAX_SEND_CONFIG_STRING_BYTES = 1024;
const CLAIM_TTL_MS = 120_000;
const LOCK_OWNER_GRACE_MS = 5_000;
const MAX_LOCK_RETRY_MS = 100;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const isRecord = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const requireRecord = (value, field) => {
  if (!isRecord(value)) {
    throw new FollowUpQueueValidationError(`${field} must be an object`);
  }
  return value;
};

const requireAllowedKeys = (value, allowed, field) => {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new FollowUpQueueValidationError(`${field} contains unsupported field ${key}`);
    }
  }
};

const requireUtf8String = (value, field, maximumBytes, options = {}) => {
  if (typeof value !== 'string') {
    throw new FollowUpQueueValidationError(`${field} must be a string`);
  }
  if (options.nonEmpty === true && value.length === 0) {
    throw new FollowUpQueueValidationError(`${field} must not be empty`);
  }
  if (Buffer.byteLength(value, 'utf8') > maximumBytes) {
    throw new FollowUpQueueValidationError(`${field} exceeds its UTF-8 byte limit`);
  }
  if (options.controlFree === true && CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new FollowUpQueueValidationError(`${field} contains control characters`);
  }
  return value;
};

const normalizeNonNegativeInteger = (value, field, maximum = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new FollowUpQueueValidationError(`${field} must be a non-negative safe integer`);
  }
  return value;
};

const normalizePositiveInteger = (value, field) => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new FollowUpQueueValidationError(`${field} must be a positive safe integer`);
  }
  return value;
};

const normalizeSessionId = (value, field = 'sessionId') => {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_SESSION_ID_LENGTH
    || Buffer.byteLength(value, 'utf8') > MAX_SESSION_ID_BYTES
    || CONTROL_CHARACTER_PATTERN.test(value)
    || value === '.'
    || value === '..'
    || value.includes('/')
    || value.includes('\\')
  ) {
    throw new FollowUpQueueValidationError(`${field} is invalid`);
  }
  return value;
};

const normalizeIdentifier = (value, field) => requireUtf8String(
  value,
  field,
  MAX_IDENTIFIER_BYTES,
  { nonEmpty: true, controlFree: true },
);

const normalizeClientMutationId = (value) => normalizeIdentifier(value, 'clientMutationId');

const normalizeStatus = (value, field) => {
  if (value !== 'staged' && value !== 'queued') {
    throw new FollowUpQueueValidationError(`${field} is invalid`);
  }
  return value;
};

const normalizeAttachment = (value, field) => {
  const attachment = requireRecord(value, field);
  requireAllowedKeys(
    attachment,
    new Set([
      'id',
      'dataUrl',
      'mimeType',
      'filename',
      'size',
      'source',
      'serverPath',
      'vscodePath',
      'vscodeSource',
    ]),
    field,
  );
  if (attachment.source !== 'local' && attachment.source !== 'server' && attachment.source !== 'vscode') {
    throw new FollowUpQueueValidationError(`${field}.source is invalid`);
  }

  const normalized = {
    id: normalizeIdentifier(attachment.id, `${field}.id`),
    dataUrl: requireUtf8String(attachment.dataUrl, `${field}.dataUrl`, MAX_ATTACHMENT_DATA_URL_BYTES),
    mimeType: requireUtf8String(
      attachment.mimeType,
      `${field}.mimeType`,
      MAX_MIME_TYPE_BYTES,
      { nonEmpty: true, controlFree: true },
    ),
    filename: requireUtf8String(
      attachment.filename,
      `${field}.filename`,
      MAX_FILENAME_BYTES,
      { controlFree: true },
    ),
    size: normalizeNonNegativeInteger(attachment.size, `${field}.size`, MAX_ATTACHMENT_SIZE),
    source: attachment.source,
  };
  if (hasOwn(attachment, 'serverPath')) {
    normalized.serverPath = requireUtf8String(
      attachment.serverPath,
      `${field}.serverPath`,
      MAX_ATTACHMENT_PATH_BYTES,
      { controlFree: true },
    );
  }
  if (hasOwn(attachment, 'vscodePath')) {
    normalized.vscodePath = requireUtf8String(
      attachment.vscodePath,
      `${field}.vscodePath`,
      MAX_ATTACHMENT_PATH_BYTES,
      { controlFree: true },
    );
  }
  if (hasOwn(attachment, 'vscodeSource')) {
    if (attachment.vscodeSource !== 'file' && attachment.vscodeSource !== 'selection') {
      throw new FollowUpQueueValidationError(`${field}.vscodeSource is invalid`);
    }
    normalized.vscodeSource = attachment.vscodeSource;
  }
  return normalized;
};

const normalizeAttachments = (value, field) => {
  if (!Array.isArray(value)) {
    throw new FollowUpQueueValidationError(`${field} must be an array`);
  }
  if (value.length > MAX_ATTACHMENTS_PER_ITEM) {
    throw new FollowUpQueueValidationError(`${field} exceeds its item limit`);
  }
  const attachments = value.map((attachment, index) => normalizeAttachment(attachment, `${field}[${index}]`));
  const seenIds = new Set();
  for (const attachment of attachments) {
    if (seenIds.has(attachment.id)) {
      throw new FollowUpQueueValidationError(`${field} contains duplicate attachment ids`);
    }
    seenIds.add(attachment.id);
  }
  return attachments;
};

const normalizeSendConfig = (value, field) => {
  const sendConfig = requireRecord(value, field);
  requireAllowedKeys(sendConfig, new Set(['providerID', 'modelID', 'agent', 'variant']), field);
  const normalized = {
    providerID: requireUtf8String(
      sendConfig.providerID,
      `${field}.providerID`,
      MAX_SEND_CONFIG_STRING_BYTES,
      { nonEmpty: true, controlFree: true },
    ),
    modelID: requireUtf8String(
      sendConfig.modelID,
      `${field}.modelID`,
      MAX_SEND_CONFIG_STRING_BYTES,
      { nonEmpty: true, controlFree: true },
    ),
  };
  if (hasOwn(sendConfig, 'agent')) {
    normalized.agent = requireUtf8String(
      sendConfig.agent,
      `${field}.agent`,
      MAX_SEND_CONFIG_STRING_BYTES,
      { controlFree: true },
    );
  }
  if (hasOwn(sendConfig, 'variant')) {
    normalized.variant = requireUtf8String(
      sendConfig.variant,
      `${field}.variant`,
      MAX_SEND_CONFIG_STRING_BYTES,
      { controlFree: true },
    );
  }
  return normalized;
};

const normalizeClaim = (value, field) => {
  const claim = requireRecord(value, field);
  requireAllowedKeys(claim, new Set(['id', 'expiresAt']), field);
  return {
    id: normalizeIdentifier(claim.id, `${field}.id`),
    expiresAt: normalizeNonNegativeInteger(claim.expiresAt, `${field}.expiresAt`),
  };
};

const normalizeItem = (value, field, options = {}) => {
  const item = requireRecord(value, field);
  requireAllowedKeys(
    item,
    new Set(['id', 'messageId', 'content', 'attachments', 'createdAt', 'status', 'sendConfig', 'claim']),
    field,
  );
  if (options.allowClaim === false && hasOwn(item, 'claim')) {
    throw new FollowUpQueueValidationError(`${field}.claim is host-owned`);
  }

  const normalized = {
    id: normalizeIdentifier(item.id, `${field}.id`),
    messageId: normalizeIdentifier(item.messageId, `${field}.messageId`),
    content: requireUtf8String(item.content, `${field}.content`, MAX_CONTENT_BYTES),
  };
  if (hasOwn(item, 'attachments')) {
    normalized.attachments = normalizeAttachments(item.attachments, `${field}.attachments`);
  }
  normalized.createdAt = normalizeNonNegativeInteger(item.createdAt, `${field}.createdAt`);
  normalized.status = normalizeStatus(item.status, `${field}.status`);
  if (hasOwn(item, 'sendConfig')) {
    normalized.sendConfig = normalizeSendConfig(item.sendConfig, `${field}.sendConfig`);
  }
  if (hasOwn(item, 'claim')) {
    normalized.claim = normalizeClaim(item.claim, `${field}.claim`);
  }
  return normalized;
};

const getAttachmentStringBytes = (attachment) => {
  let total = 0;
  for (const value of Object.values(attachment)) {
    if (typeof value === 'string') total += Buffer.byteLength(JSON.stringify(value), 'utf8') - 2;
  }
  return total;
};

const assertItemsWithinLimits = (items, field = 'items') => {
  if (items.length > MAX_ITEMS) {
    throw new FollowUpQueueValidationError(`${field} exceeds its item limit`);
  }
  const seenIds = new Set();
  const seenMessageIds = new Set();
  let totalContentBytes = 0;
  let totalAttachments = 0;
  let totalAttachmentStringBytes = 0;
  for (const item of items) {
    if (seenIds.has(item.id)) {
      throw new FollowUpQueueValidationError(`${field} contains duplicate item ids`);
    }
    if (seenMessageIds.has(item.messageId)) {
      throw new FollowUpQueueValidationError(`${field} contains duplicate message ids`);
    }
    seenIds.add(item.id);
    seenMessageIds.add(item.messageId);
    totalContentBytes += Buffer.byteLength(JSON.stringify(item.content), 'utf8') - 2;
    for (const attachment of item.attachments ?? []) {
      totalAttachments += 1;
      totalAttachmentStringBytes += getAttachmentStringBytes(attachment);
    }
  }
  if (totalContentBytes > MAX_TOTAL_CONTENT_BYTES) {
    throw new FollowUpQueueValidationError(`${field} exceeds its total content limit`);
  }
  if (totalAttachments > MAX_ATTACHMENTS_PER_QUEUE) {
    throw new FollowUpQueueValidationError(`${field} exceeds its total attachment count limit`);
  }
  if (totalAttachmentStringBytes > MAX_TOTAL_ATTACHMENT_STRING_BYTES) {
    throw new FollowUpQueueValidationError(`${field} exceeds its total attachment string limit`);
  }
};

const normalizeItems = (value, field = 'items') => {
  if (!Array.isArray(value)) {
    throw new FollowUpQueueValidationError(`${field} must be an array`);
  }
  const items = value.map((item, index) => normalizeItem(item, `${field}[${index}]`));
  assertItemsWithinLimits(items, field);
  return items;
};

const normalizeOperation = (value) => {
  const operation = requireRecord(value, 'operation');
  if (operation.type === 'add') {
    requireAllowedKeys(operation, new Set(['type', 'item']), 'operation');
    return { type: 'add', item: normalizeItem(operation.item, 'operation.item', { allowClaim: false }) };
  }
  if (operation.type === 'remove') {
    requireAllowedKeys(operation, new Set(['type', 'itemId']), 'operation');
    return { type: 'remove', itemId: normalizeIdentifier(operation.itemId, 'operation.itemId') };
  }
  if (operation.type === 'set-status') {
    requireAllowedKeys(operation, new Set(['type', 'itemId', 'status']), 'operation');
    return {
      type: 'set-status',
      itemId: normalizeIdentifier(operation.itemId, 'operation.itemId'),
      status: normalizeStatus(operation.status, 'operation.status'),
    };
  }
  if (operation.type === 'move') {
    requireAllowedKeys(operation, new Set(['type', 'itemId', 'beforeId']), 'operation');
    if (operation.beforeId !== null && typeof operation.beforeId !== 'string') {
      throw new FollowUpQueueValidationError('operation.beforeId must be a string or null');
    }
    return {
      type: 'move',
      itemId: normalizeIdentifier(operation.itemId, 'operation.itemId'),
      beforeId: operation.beforeId === null
        ? null
        : normalizeIdentifier(operation.beforeId, 'operation.beforeId'),
    };
  }
  if (operation.type === 'claim') {
    requireAllowedKeys(operation, new Set(['type', 'itemId', 'claimId', 'mode']), 'operation');
    if (operation.mode !== 'manual' && operation.mode !== 'auto') {
      throw new FollowUpQueueValidationError('operation.mode is invalid');
    }
    return {
      type: 'claim',
      itemId: normalizeIdentifier(operation.itemId, 'operation.itemId'),
      claimId: normalizeIdentifier(operation.claimId, 'operation.claimId'),
      mode: operation.mode,
    };
  }
  if (operation.type === 'complete') {
    requireAllowedKeys(operation, new Set(['type', 'itemId', 'claimId']), 'operation');
    return {
      type: 'complete',
      itemId: normalizeIdentifier(operation.itemId, 'operation.itemId'),
      claimId: normalizeIdentifier(operation.claimId, 'operation.claimId'),
    };
  }
  if (operation.type === 'release') {
    requireAllowedKeys(operation, new Set(['type', 'itemId', 'claimId', 'status']), 'operation');
    return {
      type: 'release',
      itemId: normalizeIdentifier(operation.itemId, 'operation.itemId'),
      claimId: normalizeIdentifier(operation.claimId, 'operation.claimId'),
      status: normalizeStatus(operation.status, 'operation.status'),
    };
  }
  throw new FollowUpQueueValidationError('operation.type is unsupported');
};

const normalizeMutationRequest = (value) => {
  const mutation = requireRecord(value, 'mutation');
  requireAllowedKeys(
    mutation,
    new Set(['sessionId', 'baseRevision', 'clientMutationId', 'operation']),
    'mutation',
  );
  return {
    sessionId: normalizeSessionId(mutation.sessionId),
    baseRevision: normalizeNonNegativeInteger(mutation.baseRevision, 'baseRevision'),
    clientMutationId: normalizeClientMutationId(mutation.clientMutationId),
    operation: normalizeOperation(mutation.operation),
  };
};

const normalizeScope = (value, field = 'scope') => {
  const scope = requireRecord(value, field);
  requireAllowedKeys(scope, new Set(['kind', 'sessionId']), field);
  if (scope.kind !== 'session') {
    throw new FollowUpQueueValidationError(`${field}.kind is unsupported`);
  }
  return { kind: 'session', sessionId: normalizeSessionId(scope.sessionId, `${field}.sessionId`) };
};

const normalizeStoredMutations = (value, revision) => {
  if (!Array.isArray(value) || value.length > MAX_PERSISTED_MUTATION_DEDUPE) {
    throw new FollowUpQueueValidationError('recentMutations is invalid');
  }
  const records = [];
  const seenIds = new Set();
  let previousMutationRevision = 0;
  for (let index = 0; index < value.length; index += 1) {
    const field = `recentMutations[${index}]`;
    const record = requireRecord(value[index], field);
    requireAllowedKeys(record, new Set(['clientMutationId', 'fingerprint', 'mutationRevision']), field);
    const clientMutationId = normalizeClientMutationId(record.clientMutationId);
    if (seenIds.has(clientMutationId)) {
      throw new FollowUpQueueValidationError('recentMutations contains duplicate clientMutationId values');
    }
    if (typeof record.fingerprint !== 'string' || !/^[\da-f]{64}$/.test(record.fingerprint)) {
      throw new FollowUpQueueValidationError(`${field}.fingerprint is invalid`);
    }

    let mutationRevision = null;
    if (record.mutationRevision !== null) {
      mutationRevision = normalizePositiveInteger(record.mutationRevision, `${field}.mutationRevision`);
      if (mutationRevision > revision || mutationRevision <= previousMutationRevision) {
        throw new FollowUpQueueValidationError(`${field}.mutationRevision is inconsistent`);
      }
      previousMutationRevision = mutationRevision;
    }
    seenIds.add(clientMutationId);
    records.push({ clientMutationId, fingerprint: record.fingerprint, mutationRevision });
  }
  return records;
};

const normalizeStorageEnvelope = (value, expectedScope) => {
  const envelope = requireRecord(value, 'follow-up queue file');
  requireAllowedKeys(
    envelope,
    new Set(['storageVersion', 'scope', 'revision', 'items', 'recentMutations', 'terminal']),
    'follow-up queue file',
  );
  if (envelope.storageVersion !== FOLLOW_UP_QUEUE_STORAGE_VERSION) {
    throw new FollowUpQueueValidationError('storageVersion is unsupported');
  }
  const scope = normalizeScope(envelope.scope, 'stored scope');
  if (JSON.stringify(scope) !== JSON.stringify(expectedScope)) {
    throw new FollowUpQueueValidationError('stored scope does not match its file token');
  }
  const revision = normalizeNonNegativeInteger(envelope.revision, 'revision');
  const items = normalizeItems(envelope.items);
  if (hasOwn(envelope, 'terminal') && envelope.terminal !== true) {
    throw new FollowUpQueueValidationError('terminal must be true when present');
  }
  const terminal = envelope.terminal === true;
  if (terminal && (revision < 1 || items.length !== 0)) {
    throw new FollowUpQueueValidationError('terminal follow-up queue state is invalid');
  }
  return {
    storageVersion: FOLLOW_UP_QUEUE_STORAGE_VERSION,
    scope,
    revision,
    items,
    recentMutations: normalizeStoredMutations(envelope.recentMutations, revision),
    terminal,
  };
};

const cloneAttachment = (attachment) => ({ ...attachment });

const cloneItem = (item) => {
  const cloned = {
    id: item.id,
    messageId: item.messageId,
    content: item.content,
  };
  if (hasOwn(item, 'attachments')) {
    cloned.attachments = item.attachments.map(cloneAttachment);
  }
  cloned.createdAt = item.createdAt;
  cloned.status = item.status;
  if (hasOwn(item, 'sendConfig')) cloned.sendConfig = { ...item.sendConfig };
  if (hasOwn(item, 'claim')) cloned.claim = { ...item.claim };
  return cloned;
};

const cloneItems = (items) => items.map(cloneItem);
const cloneScope = (scope) => ({ kind: 'session', sessionId: scope.sessionId });

const createStorageEnvelope = (scope, revision, items, recentMutations, terminal = false) => ({
  storageVersion: FOLLOW_UP_QUEUE_STORAGE_VERSION,
  scope: cloneScope(scope),
  revision,
  items: cloneItems(items),
  recentMutations: recentMutations.map((record) => ({ ...record })),
  ...(terminal ? { terminal: true } : {}),
});

const createSnapshot = (scopeToken, envelope) => ({
  scopeToken,
  revision: envelope?.revision ?? 0,
  items: cloneItems(envelope?.items ?? []),
});

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const getScopeToken = (scope) => sha256(JSON.stringify(scope));
const fingerprintOperation = (operation) => sha256(JSON.stringify(operation));
const isMissingFileError = (error) => Boolean(error && typeof error === 'object' && error.code === 'ENOENT');

const requireDependency = (value, name) => {
  if (!value) throw new FollowUpQueueValidationError(`${name} is required`);
  return value;
};

const itemsEqual = (first, second) => JSON.stringify(first) === JSON.stringify(second);

const applyOperation = (items, operation, now) => {
  const itemIndex = operation.type === 'add'
    ? -1
    : items.findIndex((item) => item.id === operation.itemId);

  if (operation.type === 'add') {
    const identityMatches = items.filter(
      (item) => item.id === operation.item.id || item.messageId === operation.item.messageId,
    );
    if (identityMatches.length > 0) {
      if (identityMatches.length === 1 && itemsEqual(identityMatches[0], operation.item)) {
        return { items, changed: false };
      }
      throw new FollowUpQueueItemConflictError();
    }
    const nextItems = [...items, operation.item];
    assertItemsWithinLimits(nextItems);
    return { items: nextItems, changed: true };
  }

  if (itemIndex === -1) return { items, changed: false };

  if (operation.type === 'remove') {
    return { items: items.filter((_, index) => index !== itemIndex), changed: true };
  }

  if (operation.type === 'set-status') {
    if (items[itemIndex].status === operation.status) return { items, changed: false };
    const nextItems = items.slice();
    nextItems[itemIndex] = { ...items[itemIndex], status: operation.status };
    return { items: nextItems, changed: true };
  }

  if (operation.type === 'move') {
    if (operation.beforeId === operation.itemId) return { items, changed: false };
    const nextItems = items.slice();
    const [moved] = nextItems.splice(itemIndex, 1);
    const targetIndex = operation.beforeId === null
      ? nextItems.length
      : nextItems.findIndex((item) => item.id === operation.beforeId);
    if (targetIndex === -1) return { items, changed: false };
    nextItems.splice(targetIndex, 0, moved);
    const changed = nextItems.some((item, index) => item !== items[index]);
    return changed ? { items: nextItems, changed: true } : { items, changed: false };
  }

  if (operation.type === 'claim') {
    const item = items[itemIndex];
    if (operation.mode === 'auto' && item.status !== 'queued') return { items, changed: false };
    const timestamp = now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > Number.MAX_SAFE_INTEGER - CLAIM_TTL_MS) {
      throw new FollowUpQueueWriteError();
    }
    if (item.claim && item.claim.expiresAt > timestamp && item.claim.id !== operation.claimId) {
      return { items, changed: false };
    }
    const claim = { id: operation.claimId, expiresAt: timestamp + CLAIM_TTL_MS };
    if (item.claim?.id === claim.id && item.claim.expiresAt === claim.expiresAt) {
      return { items, changed: false };
    }
    const nextItems = items.slice();
    nextItems[itemIndex] = { ...item, claim };
    return { items: nextItems, changed: true };
  }

  if (operation.type === 'complete') {
    if (items[itemIndex].claim?.id !== operation.claimId) return { items, changed: false };
    return { items: items.filter((_, index) => index !== itemIndex), changed: true };
  }

  if (operation.type === 'release') {
    const item = items[itemIndex];
    if (item.claim?.id !== operation.claimId) return { items, changed: false };
    const { claim: _claim, ...released } = item;
    void _claim;
    const nextItems = items.slice();
    nextItems[itemIndex] = { ...released, status: operation.status };
    return { items: nextItems, changed: true };
  }

  return { items, changed: false };
};

export const createFollowUpQueueCore = (dependencies) => {
  const options = isRecord(dependencies) ? dependencies : {};
  const fsPromises = requireDependency(options.fsPromises, 'fsPromises');
  const path = requireDependency(options.path, 'path');
  const rootDirectory = options.rootDirectory;
  const dedupeLimit = options.dedupeLimit ?? DEFAULT_MUTATION_DEDUPE_LIMIT;
  const createTempId = options.createTempId ?? randomUUID;
  const createLockId = options.createLockId ?? randomUUID;
  const now = options.now ?? Date.now;
  const waitForLock = options.waitForLock ?? ((delayMs) => new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  }));

  for (const method of ['stat', 'readFile', 'writeFile', 'mkdir', 'rename', 'unlink', 'rmdir']) {
    if (typeof fsPromises[method] !== 'function') {
      throw new FollowUpQueueValidationError(`fsPromises.${method} is required`);
    }
  }
  if (
    typeof path.isAbsolute !== 'function'
    || typeof path.join !== 'function'
    || typeof path.dirname !== 'function'
  ) {
    throw new FollowUpQueueValidationError('path.isAbsolute, path.join, and path.dirname are required');
  }
  if (
    typeof rootDirectory !== 'string'
    || rootDirectory.length === 0
    || rootDirectory.includes('\u0000')
    || !path.isAbsolute(rootDirectory)
  ) {
    throw new FollowUpQueueValidationError('rootDirectory must be an absolute path');
  }
  if (
    !Number.isSafeInteger(dedupeLimit)
    || dedupeLimit < 1
    || dedupeLimit > MAX_PERSISTED_MUTATION_DEDUPE
  ) {
    throw new FollowUpQueueValidationError('dedupeLimit is invalid');
  }
  if (
    typeof createTempId !== 'function'
    || typeof createLockId !== 'function'
    || typeof now !== 'function'
    || typeof waitForLock !== 'function'
  ) {
    throw new FollowUpQueueValidationError('createTempId, createLockId, now, and waitForLock must be functions');
  }

  const scopeQueues = new Map();
  let temporarySequence = 0;
  let lockSequence = 0;
  let rootDirectoryPromise = null;

  const enqueue = (scopeToken, task) => {
    const previous = scopeQueues.get(scopeToken) ?? Promise.resolve();
    const result = previous.then(task, task);
    const tail = result.then(() => undefined, () => undefined);
    scopeQueues.set(scopeToken, tail);
    void tail.then(() => {
      if (scopeQueues.get(scopeToken) === tail) scopeQueues.delete(scopeToken);
    });
    return result;
  };

  const filePathForToken = (scopeToken) => path.join(rootDirectory, `${scopeToken}.json`);
  const terminalFencePathForToken = (scopeToken) => path.join(rootDirectory, `.terminal-${scopeToken}.json`);

  const ensureRootDirectory = () => {
    if (rootDirectoryPromise) return rootDirectoryPromise;
    rootDirectoryPromise = (async () => {
      try {
        const created = await fsPromises.mkdir(rootDirectory, { recursive: true, mode: 0o700 });
        if (
          created
          && process.platform !== 'win32'
          && typeof fsPromises.open === 'function'
        ) {
          const parent = await fsPromises.open(path.dirname(rootDirectory), 'r');
          try {
            await parent.sync();
          } finally {
            await parent.close();
          }
        }
      } catch {
        rootDirectoryPromise = null;
        throw new FollowUpQueueWriteError();
      }
    })();
    return rootDirectoryPromise;
  };

  const isErrorCode = (error, code) => Boolean(
    error && typeof error === 'object' && error.code === code
  );

  const isDirectoryCollision = async (error, targetDirectory) => {
    if (isErrorCode(error, 'EEXIST') || isErrorCode(error, 'ENOTEMPTY')) return true;
    if (!isErrorCode(error, 'EACCES') && !isErrorCode(error, 'EPERM')) return false;
    try {
      const stats = await fsPromises.stat(targetDirectory);
      return typeof stats.isDirectory !== 'function' || stats.isDirectory();
    } catch {
      return false;
    }
  };

  const isPidAlive = (pid) => {
    if (!Number.isSafeInteger(pid) || pid < 1) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return isErrorCode(error, 'EPERM');
    }
  };

  const nextLockSuffix = () => {
    lockSequence += 1;
    const randomPart = String(createLockId());
    if (randomPart.length > 128 || !/^[A-Za-z0-9_-]+$/.test(randomPart)) {
      throw new FollowUpQueueWriteError();
    }
    return `${process.pid}-${lockSequence}-${randomPart}`;
  };

  const removeOwnedLockDirectory = async (lockDirectory, ownerFile) => {
    await fsPromises.unlink(ownerFile).catch(() => {});
    await fsPromises.rmdir(lockDirectory).catch(() => {});
  };

  const tryClearStaleLock = async (lockDirectory, ownerFile) => {
    let owner = null;
    let ownerRaw = null;
    try {
      ownerRaw = await fsPromises.readFile(ownerFile, 'utf8');
      let parsed;
      try {
        parsed = JSON.parse(ownerRaw);
      } catch {
        throw new FollowUpQueueWriteError();
      }
      if (
        isRecord(parsed)
        && Number.isSafeInteger(parsed.pid)
        && parsed.pid > 0
        && typeof parsed.token === 'string'
        && parsed.token.length <= 192
        && /^[A-Za-z0-9_-]+$/.test(parsed.token)
      ) {
        owner = parsed;
      }
      if (!owner) throw new FollowUpQueueWriteError();
    } catch (error) {
      if (error instanceof FollowUpQueueWriteError) throw error;
      if (!isErrorCode(error, 'ENOENT')) throw new FollowUpQueueWriteError();
    }
    if (owner && isPidAlive(owner.pid)) return false;

    let lockStats = null;
    if (!owner) {
      try {
        lockStats = await fsPromises.stat(lockDirectory);
        const modifiedAt = Number(lockStats.mtimeMs);
        if (Number.isFinite(modifiedAt) && Date.now() - modifiedAt < LOCK_OWNER_GRACE_MS) return false;
      } catch (error) {
        if (isErrorCode(error, 'ENOENT')) return true;
        throw new FollowUpQueueWriteError();
      }
    }

    const staleKey = owner?.token ?? createHash('sha256')
      .update(ownerRaw ?? JSON.stringify({
        ino: String(lockStats?.ino ?? ''),
        modifiedAt: Number(lockStats?.mtimeMs ?? 0),
      }))
      .digest('hex');
    const staleDirectory = `${lockDirectory}.stale-${staleKey}`;
    try {
      await fsPromises.rename(lockDirectory, staleDirectory);
    } catch (error) {
      if (isErrorCode(error, 'ENOENT') || await isDirectoryCollision(error, staleDirectory)) return true;
      throw new FollowUpQueueWriteError();
    }
    return true;
  };

  const acquireScopeLock = async (scopeToken) => {
    await ensureRootDirectory();
    const lockDirectory = path.join(rootDirectory, `.lock-${scopeToken}`);
    const ownerFile = path.join(lockDirectory, 'owner.json');
    let retryMs = 5;

    while (true) {
      const token = nextLockSuffix();
      const candidateDirectory = `${lockDirectory}.candidate-${token}`;
      const candidateOwnerFile = path.join(candidateDirectory, 'owner.json');
      try {
        await fsPromises.mkdir(candidateDirectory, { mode: 0o700 });
        try {
          await fsPromises.writeFile(candidateOwnerFile, JSON.stringify({ pid: process.pid, token }), {
            encoding: 'utf8',
            mode: 0o600,
            flag: 'wx',
            flush: true,
          });
        } catch {
          await removeOwnedLockDirectory(candidateDirectory, candidateOwnerFile);
          throw new FollowUpQueueWriteError();
        }

        try {
          await fsPromises.rename(candidateDirectory, lockDirectory);
        } catch (error) {
          await removeOwnedLockDirectory(candidateDirectory, candidateOwnerFile);
          if (await isDirectoryCollision(error, lockDirectory)) {
            const cleared = await tryClearStaleLock(lockDirectory, ownerFile);
            if (!cleared) {
              await waitForLock(retryMs);
              retryMs = Math.min(retryMs * 2, MAX_LOCK_RETRY_MS);
            }
            continue;
          }
          throw new FollowUpQueueWriteError();
        }

        let released = false;
        return async () => {
          if (released) return;
          const releasedDirectory = `${lockDirectory}.released-${token}`;
          let retryMs = 5;
          while (true) {
            let currentToken = null;
            try {
              const parsed = JSON.parse(await fsPromises.readFile(ownerFile, 'utf8'));
              currentToken = isRecord(parsed) ? parsed.token : null;
            } catch (error) {
              if (isErrorCode(error, 'ENOENT')) throw new FollowUpQueueWriteError();
              await waitForLock(retryMs);
              retryMs = Math.min(retryMs * 2, MAX_LOCK_RETRY_MS);
              continue;
            }
            if (currentToken !== token) throw new FollowUpQueueWriteError();
            try {
              await fsPromises.rename(lockDirectory, releasedDirectory);
              released = true;
              break;
            } catch (error) {
              if (isErrorCode(error, 'ENOENT') || isErrorCode(error, 'EEXIST')) {
                throw new FollowUpQueueWriteError();
              }
              await waitForLock(retryMs);
              retryMs = Math.min(retryMs * 2, MAX_LOCK_RETRY_MS);
            }
          }
          await removeOwnedLockDirectory(releasedDirectory, path.join(releasedDirectory, 'owner.json'));
        };
      } catch (error) {
        await removeOwnedLockDirectory(candidateDirectory, candidateOwnerFile);
        if (!isErrorCode(error, 'EEXIST')) throw error;
      }
    }
  };

  const withScopeLock = async (scopeToken, task) => {
    const release = await acquireScopeLock(scopeToken);
    try {
      return await task();
    } finally {
      await release();
    }
  };

  const readEnvelope = async (filePath, scope) => {
    let raw;
    try {
      if (typeof fsPromises.stat === 'function') {
        const stats = await fsPromises.stat(filePath);
        if (!Number.isSafeInteger(stats.size) || stats.size > MAX_FOLLOW_UP_QUEUE_FILE_BYTES) {
          throw new FollowUpQueueCorruptError();
        }
      }
      raw = await fsPromises.readFile(filePath, 'utf8');
    } catch (error) {
      if (isMissingFileError(error)) return null;
      if (error instanceof FollowUpQueueCorruptError) throw error;
      throw new FollowUpQueueReadError();
    }
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_FOLLOW_UP_QUEUE_FILE_BYTES) {
      throw new FollowUpQueueCorruptError();
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new FollowUpQueueCorruptError();
    }
    try {
      return normalizeStorageEnvelope(parsed, scope);
    } catch (error) {
      if (error instanceof FollowUpQueueValidationError) throw new FollowUpQueueCorruptError();
      throw error;
    }
  };

  const readCorruptRevision = async (filePath) => {
    try {
      const stats = await fsPromises.stat(filePath);
      if (!Number.isSafeInteger(stats.size) || stats.size > MAX_FOLLOW_UP_QUEUE_FILE_BYTES) return null;
      const raw = await fsPromises.readFile(filePath, 'utf8');
      if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_FOLLOW_UP_QUEUE_FILE_BYTES) return null;
      const parsed = JSON.parse(raw);
      if (
        !isRecord(parsed)
        || !Number.isSafeInteger(parsed.revision)
        || parsed.revision < 0
        || parsed.revision >= Number.MAX_SAFE_INTEGER
      ) return null;
      return parsed.revision;
    } catch {
      return null;
    }
  };

  const nextTemporaryPath = (filePath) => {
    temporarySequence += 1;
    const randomPart = String(createTempId());
    if (randomPart.length > 128 || !/^[A-Za-z0-9_-]+$/.test(randomPart)) {
      throw new FollowUpQueueValidationError('createTempId returned an invalid value');
    }
    return `${filePath}.tmp-${process.pid}-${temporarySequence}-${randomPart}`;
  };

  const writeEnvelope = async (filePath, envelope) => {
    const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_FOLLOW_UP_QUEUE_FILE_BYTES) {
      throw new FollowUpQueueWriteError();
    }

    let temporaryPath;
    let renamed = false;
    try {
      await ensureRootDirectory();
      temporaryPath = nextTemporaryPath(filePath);
      await fsPromises.writeFile(temporaryPath, serialized, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
        flush: true,
      });
      await fsPromises.rename(temporaryPath, filePath);
      renamed = true;
      if (process.platform !== 'win32' && typeof fsPromises.open === 'function') {
        const directory = await fsPromises.open(rootDirectory, 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } catch {
      if (temporaryPath && !renamed) {
        await fsPromises.unlink(temporaryPath).catch(() => {});
      }
      throw new FollowUpQueueWriteError();
    }
  };

  const hasTerminalFence = async (scopeToken) => {
    try {
      await fsPromises.stat(terminalFencePathForToken(scopeToken));
      return true;
    } catch (error) {
      if (isErrorCode(error, 'ENOENT')) return false;
      throw new FollowUpQueueReadError();
    }
  };

  const ensureTerminalFence = async (scope, scopeToken) => {
    try {
      await ensureRootDirectory();
      try {
        await fsPromises.writeFile(
          terminalFencePathForToken(scopeToken),
          `${JSON.stringify({ storageVersion: FOLLOW_UP_QUEUE_STORAGE_VERSION, scope: cloneScope(scope) })}\n`,
          { encoding: 'utf8', mode: 0o600, flag: 'wx', flush: true },
        );
      } catch (error) {
        if (!isErrorCode(error, 'EEXIST')) throw error;
      }
      if (process.platform !== 'win32' && typeof fsPromises.open === 'function') {
        const directory = await fsPromises.open(rootDirectory, 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } catch (error) {
      throw new FollowUpQueueWriteError();
    }
  };

  const appendMutation = (recentMutations, clientMutationId, fingerprint, mutationRevision) => ([
    ...recentMutations,
    { clientMutationId, fingerprint, mutationRevision },
  ].slice(-dedupeLimit));

  const load = async (inputSessionId) => {
    const scope = { kind: 'session', sessionId: normalizeSessionId(inputSessionId) };
    const scopeToken = getScopeToken(scope);
    const filePath = filePathForToken(scopeToken);
    return enqueue(scopeToken, async () => {
      const envelope = await readEnvelope(filePath, scope);
      if (await hasTerminalFence(scopeToken) && !envelope?.terminal) {
        throw new FollowUpQueueReadError();
      }
      return createSnapshot(scopeToken, envelope);
    });
  };

  const applyMutation = async (input) => {
    const mutation = normalizeMutationRequest(input);
    const scope = { kind: 'session', sessionId: mutation.sessionId };
    const scopeToken = getScopeToken(scope);
    const fingerprint = fingerprintOperation(mutation.operation);
    const filePath = filePathForToken(scopeToken);

    return enqueue(scopeToken, () => withScopeLock(scopeToken, async () => {
      const stored = await readEnvelope(filePath, scope);
      if (await hasTerminalFence(scopeToken) && !stored?.terminal) {
        throw new FollowUpQueueReadError();
      }
      const envelope = stored ?? createStorageEnvelope(scope, 0, [], []);
      const existingMutation = envelope.recentMutations.find(
        (record) => record.clientMutationId === mutation.clientMutationId,
      );
      if (existingMutation) {
        if (existingMutation.fingerprint !== fingerprint) {
          throw new FollowUpQueueIdempotencyError();
        }
        return {
          snapshot: createSnapshot(scopeToken, envelope),
          applied: false,
          deduplicated: true,
          mutationRevision: existingMutation.mutationRevision,
        };
      }

      if (mutation.baseRevision !== envelope.revision) {
        throw new FollowUpQueueConflictError(
          mutation.baseRevision,
          createSnapshot(scopeToken, envelope),
        );
      }

      let items = envelope.items;
      let applied = false;
      let mutationRevision = null;
      if (!envelope.terminal) {
        const result = applyOperation(envelope.items, mutation.operation, now);
        items = result.items;
        applied = result.changed;
        if (applied) {
          if (envelope.revision === Number.MAX_SAFE_INTEGER) throw new FollowUpQueueWriteError();
          mutationRevision = envelope.revision + 1;
        }
      }
      const revision = mutationRevision ?? envelope.revision;
      const recentMutations = appendMutation(
        envelope.recentMutations,
        mutation.clientMutationId,
        fingerprint,
        mutationRevision,
      );
      const nextEnvelope = createStorageEnvelope(
        scope,
        revision,
        items,
        recentMutations,
        envelope.terminal,
      );
      await writeEnvelope(filePath, nextEnvelope);
      return {
        snapshot: createSnapshot(scopeToken, nextEnvelope),
        applied,
        deduplicated: false,
        mutationRevision,
      };
    }));
  };

  const terminalizeSession = async (inputSessionId, inputClientMutationId) => {
    const scope = { kind: 'session', sessionId: normalizeSessionId(inputSessionId) };
    const clientMutationId = normalizeClientMutationId(inputClientMutationId);
    const operation = { type: 'terminalize' };
    const fingerprint = fingerprintOperation(operation);
    const scopeToken = getScopeToken(scope);
    const filePath = filePathForToken(scopeToken);

    return enqueue(scopeToken, () => withScopeLock(scopeToken, async () => {
      await ensureTerminalFence(scope, scopeToken);
      let stored;
      try {
        stored = await readEnvelope(filePath, scope);
      } catch (error) {
        if (!(error instanceof FollowUpQueueCorruptError)) throw error;
        const corruptRevision = await readCorruptRevision(filePath);
        stored = corruptRevision === null
          ? null
          : createStorageEnvelope(scope, corruptRevision, [], []);
      }
      const envelope = stored ?? createStorageEnvelope(scope, 0, [], []);
      const existingMutation = envelope.recentMutations.find(
        (record) => record.clientMutationId === clientMutationId,
      );
      if (existingMutation) {
        if (existingMutation.fingerprint !== fingerprint) {
          throw new FollowUpQueueIdempotencyError();
        }
        return {
          snapshot: createSnapshot(scopeToken, envelope),
          applied: false,
          deduplicated: true,
          mutationRevision: existingMutation.mutationRevision,
        };
      }

      let revision = envelope.revision;
      let mutationRevision = null;
      const applied = !envelope.terminal;
      if (applied) {
        if (revision === Number.MAX_SAFE_INTEGER) throw new FollowUpQueueWriteError();
        revision += 1;
        mutationRevision = revision;
      }
      const recentMutations = appendMutation(
        envelope.recentMutations,
        clientMutationId,
        fingerprint,
        mutationRevision,
      );
      const nextEnvelope = createStorageEnvelope(scope, revision, [], recentMutations, true);
      await writeEnvelope(filePath, nextEnvelope);
      return {
        snapshot: createSnapshot(scopeToken, nextEnvelope),
        applied,
        deduplicated: false,
        mutationRevision,
      };
    }));
  };

  const listStoredSessions = async () => {
    if (typeof fsPromises.readdir !== 'function') {
      throw new FollowUpQueueReadError();
    }
    let names;
    try {
      names = await fsPromises.readdir(rootDirectory);
    } catch (error) {
      if (isErrorCode(error, 'ENOENT')) return { sessions: [], unreadable: 0 };
      throw new FollowUpQueueReadError();
    }

    const sessions = [];
    const sessionsByToken = new Map();
    let unreadable = 0;
    for (const name of names.sort()) {
      const match = /^([\da-f]{64})\.json$/.exec(name);
      if (!match) continue;
      try {
        const filePath = path.join(rootDirectory, name);
        const stats = await fsPromises.stat(filePath);
        if (!Number.isSafeInteger(stats.size) || stats.size > MAX_FOLLOW_UP_QUEUE_FILE_BYTES) {
          unreadable += 1;
          continue;
        }
        const raw = await fsPromises.readFile(filePath, 'utf8');
        if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_FOLLOW_UP_QUEUE_FILE_BYTES) {
          unreadable += 1;
          continue;
        }
        const parsed = JSON.parse(raw);
        const scope = normalizeScope(requireRecord(parsed, 'follow-up queue file').scope, 'stored scope');
        if (getScopeToken(scope) !== match[1]) {
          unreadable += 1;
          continue;
        }
        let terminal = false;
        let corrupt = false;
        try {
          terminal = normalizeStorageEnvelope(parsed, scope).terminal;
        } catch {
          corrupt = true;
        }
        const entry = { sessionId: scope.sessionId, terminal, corrupt, terminalPending: false };
        sessions.push(entry);
        sessionsByToken.set(match[1], entry);
      } catch {
        unreadable += 1;
      }
    }

    for (const name of names.sort()) {
      const match = /^\.terminal-([\da-f]{64})\.json$/.exec(name);
      if (!match) continue;
      try {
        const raw = await fsPromises.readFile(path.join(rootDirectory, name), 'utf8');
        const parsed = requireRecord(JSON.parse(raw), 'follow-up queue terminal fence');
        requireAllowedKeys(parsed, new Set(['storageVersion', 'scope']), 'follow-up queue terminal fence');
        if (parsed.storageVersion !== FOLLOW_UP_QUEUE_STORAGE_VERSION) throw new Error('invalid fence version');
        const scope = normalizeScope(parsed.scope, 'terminal fence scope');
        if (getScopeToken(scope) !== match[1]) throw new Error('invalid fence scope');
        const existing = sessionsByToken.get(match[1]);
        if (existing) {
          existing.terminalPending = !existing.terminal;
        } else {
          const entry = {
            sessionId: scope.sessionId,
            terminal: false,
            corrupt: true,
            terminalPending: true,
          };
          sessions.push(entry);
          sessionsByToken.set(match[1], entry);
        }
      } catch {
        unreadable += 1;
      }
    }
    return { sessions, unreadable };
  };

  return { load, applyMutation, terminalizeSession, listStoredSessions };
};
