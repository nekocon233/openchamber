import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type fsPromisesModule from 'node:fs/promises';
import type pathModule from 'node:path';
import { agentModelSchema } from '../native-agents/agent-configuration.js';
import type { AgentModel } from '../native-agents/agent-configuration.js';
import type { JsonObject, JsonValue } from '../shared/json-values.js';

import {
  FollowUpQueueConflictError,
  FollowUpQueueCorruptError,
  FollowUpQueueIdempotencyError,
  FollowUpQueueItemConflictError,
  FollowUpQueueReadError,
  FollowUpQueueValidationError,
  FollowUpQueueWriteError,
} from './errors.js';

export type FollowUpQueueStatus = 'staged' | 'queued';
export type FollowUpQueueAttachmentSource = 'local' | 'server' | 'vscode';
export type FollowUpQueueVscodeSource = 'file' | 'selection';
export type FollowUpQueueExecutionFramework = 'opencode' | 'claude-code';

export interface FollowUpQueueAttachment {
  id: string;
  dataUrl: string;
  mimeType: string;
  filename: string;
  size: number;
  source: FollowUpQueueAttachmentSource;
  serverPath?: string;
  vscodePath?: string;
  vscodeSource?: FollowUpQueueVscodeSource;
}

export interface FollowUpQueueContextMetadata {
  openchamberContext: JsonObject;
}

export interface FollowUpQueueAdditionalPart {
  text: string;
  attachments?: FollowUpQueueAttachment[];
  synthetic?: boolean;
  metadata?: FollowUpQueueContextMetadata;
}

export interface FollowUpQueueSendConfig {
  providerID: string;
  modelID: string;
  agent?: string;
  subagentModel?: AgentModel | null;
  variant?: string;
  executionFramework?: FollowUpQueueExecutionFramework;
}

export interface FollowUpQueueClaim {
  id: string;
  expiresAt: number;
}

export interface FollowUpQueueItem {
  id: string;
  messageId: string | null;
  content: string;
  attachments?: FollowUpQueueAttachment[];
  additionalParts?: FollowUpQueueAdditionalPart[];
  agentMentionName?: string;
  createdAt: number;
  status: FollowUpQueueStatus;
  sendConfig?: FollowUpQueueSendConfig;
  claim?: FollowUpQueueClaim;
  goal?: { objective?: string; tokenBudget: number | null };
}

export interface FollowUpQueueScope {
  kind: 'session';
  sessionId: string;
}

export interface FollowUpQueueMutationRecord {
  clientMutationId: string;
  fingerprint: string;
  mutationRevision: number | null;
}

export interface FollowUpQueueStoredEnvelope {
  storageVersion: 1;
  scope: FollowUpQueueScope;
  revision: number;
  items: FollowUpQueueItem[];
  recentMutations: FollowUpQueueMutationRecord[];
  terminal?: true;
}

interface NormalizedStorageEnvelope {
  storageVersion: 1;
  scope: FollowUpQueueScope;
  revision: number;
  items: FollowUpQueueItem[];
  recentMutations: FollowUpQueueMutationRecord[];
  terminal: boolean;
}

export interface FollowUpQueueSnapshot {
  scopeToken: string;
  revision: number;
  items: FollowUpQueueItem[];
}

export interface FollowUpQueueMutationResult {
  snapshot: FollowUpQueueSnapshot;
  applied: boolean;
  deduplicated: boolean;
  mutationRevision: number | null;
}

export interface FollowUpQueueStoredSessionEntry {
  sessionId: string;
  terminal: boolean;
  corrupt: boolean;
  terminalPending: boolean;
}

export interface FollowUpQueueStoredSessionsResult {
  sessions: FollowUpQueueStoredSessionEntry[];
  unreadable: number;
}

type FollowUpQueueOperation =
  | { type: 'add'; item: FollowUpQueueItem }
  | { type: 'remove'; itemId: string }
  | { type: 'set-status'; itemId: string; status: FollowUpQueueStatus }
  | { type: 'move'; itemId: string; beforeId: string | null }
  | { type: 'claim'; itemId: string; claimId: string; mode: 'manual' | 'auto' }
  | { type: 'complete'; itemId: string; claimId: string }
  | { type: 'release'; itemId: string; claimId: string; status: FollowUpQueueStatus };

interface NormalizedMutationRequest {
  sessionId: string;
  baseRevision: number;
  clientMutationId: string;
  operation: FollowUpQueueOperation;
}

export type FollowUpQueueFsPromises = Pick<
  typeof fsPromisesModule,
  'stat' | 'readFile' | 'writeFile' | 'mkdir' | 'rename' | 'unlink' | 'rmdir'
> & Partial<Pick<typeof fsPromisesModule, 'open' | 'readdir'>>;

export type FollowUpQueuePath = Pick<typeof pathModule, 'isAbsolute' | 'join' | 'dirname'>;

export interface FollowUpQueueCoreOptions {
  fsPromises: FollowUpQueueFsPromises;
  path: FollowUpQueuePath;
  rootDirectory: string;
  dedupeLimit?: number;
  createTempId?: () => string;
  createLockId?: () => string;
  now?: () => number;
  createMessageId?: (timestamp: number) => string;
  waitForLock?: (delayMs: number) => Promise<void>;
}

const FOLLOW_UP_QUEUE_STORAGE_VERSION = 1 as const;
const DEFAULT_MUTATION_DEDUPE_LIMIT = 256;
const MAX_PERSISTED_MUTATION_DEDUPE = 4096;
const MAX_FOLLOW_UP_QUEUE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_ITEMS = 256;
const MAX_ATTACHMENTS_PER_ITEM = 32;
const MAX_ATTACHMENTS_PER_QUEUE = 512;
const MAX_ADDITIONAL_PARTS_PER_ITEM = 64;
const MAX_ADDITIONAL_PARTS_PER_QUEUE = 1024;
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
const MAX_AGENT_MENTION_NAME_BYTES = 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_TOTAL_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_METADATA_DEPTH = 8;
const MAX_METADATA_CONTAINER_ENTRIES = 256;
const CLAIM_TTL_MS = 120_000;
const LOCK_OWNER_GRACE_MS = 5_000;
const MAX_LOCK_RETRY_MS = 100;
const hasControlCharacter = (text: string): boolean => {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
};
const MESSAGE_ID_RANDOM_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const MESSAGE_ID_RANDOM_LENGTH = 14;

let lastMessageIdTimestamp = 0;
let messageIdCounter = 0;

const createOpenCodeMessageId = (timestamp: number): string => {
  if (timestamp !== lastMessageIdTimestamp) {
    lastMessageIdTimestamp = timestamp;
    messageIdCounter = 0;
  }
  messageIdCounter += 1;

  const sortable = BigInt(timestamp) * BigInt(0x1000) + BigInt(messageIdCounter);
  const time = Array.from({ length: 6 }, (_, index) => (
    Number((sortable >> BigInt(40 - 8 * index)) & BigInt(0xff)).toString(16).padStart(2, '0')
  )).join('');
  const random = Array.from(randomBytes(MESSAGE_ID_RANDOM_LENGTH), (byte) => (
    MESSAGE_ID_RANDOM_CHARS[byte % MESSAGE_ID_RANDOM_CHARS.length] ?? ''
  )).join('');
  return `msg_${time}${random}`;
};

const hasOwn = (value: JsonObject, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

const isString = (value: unknown): value is string => typeof value === 'string';
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isSafeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
const isCallable = (value: unknown): value is CallableFunction => typeof value === 'function';
const isCoreOptions = (value: unknown): value is Partial<FollowUpQueueCoreOptions> => Boolean(value && typeof value === 'object');

const isRecord = (value: unknown): value is JsonObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const isErrorWithCode = (error: unknown): error is { code: string } => (
  Boolean(error && typeof error === 'object' && 'code' in error && typeof error.code === 'string')
);

const isErrorCode = (error: unknown, code: string): error is { code: string } => isErrorWithCode(error) && error.code === code;

const isMissingFileError = (error: unknown): error is { code: 'ENOENT' } => isErrorCode(error, 'ENOENT');

const requireRecord = (value: JsonValue | undefined, field: string): JsonObject => {
  if (!isRecord(value)) {
    throw new FollowUpQueueValidationError(`${field} must be an object`);
  }
  return value;
};

const requireAllowedKeys = (value: JsonObject, allowed: Set<string>, field: string): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new FollowUpQueueValidationError(`${field} contains unsupported field ${key}`);
    }
  }
};

interface StringValidationOptions {
  nonEmpty?: boolean;
  controlFree?: boolean;
}

const requireUtf8String = (
  value: JsonValue | undefined,
  field: string,
  maximumBytes: number,
  options: StringValidationOptions = {},
): string => {
  if (!isString(value)) {
    throw new FollowUpQueueValidationError(`${field} must be a string`);
  }
  if (options.nonEmpty === true && value.length === 0) {
    throw new FollowUpQueueValidationError(`${field} must not be empty`);
  }
  if (Buffer.byteLength(value, 'utf8') > maximumBytes) {
    throw new FollowUpQueueValidationError(`${field} exceeds its UTF-8 byte limit`);
  }
  if (options.controlFree === true && hasControlCharacter(value)) {
    throw new FollowUpQueueValidationError(`${field} contains control characters`);
  }
  return value;
};

const normalizeNonNegativeInteger = (
  value: JsonValue | undefined,
  field: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number => {
  if (!isSafeInteger(value) || value < 0 || value > maximum) {
    throw new FollowUpQueueValidationError(`${field} must be a non-negative safe integer`);
  }
  return value;
};

const normalizePositiveInteger = (value: JsonValue | undefined, field: string): number => {
  if (!isSafeInteger(value) || value < 1) {
    throw new FollowUpQueueValidationError(`${field} must be a positive safe integer`);
  }
  return value;
};

const normalizeSessionId = (value: JsonValue | undefined, field = 'sessionId'): string => {
  if (
    !isString(value)
    || value.length === 0
    || value.length > MAX_SESSION_ID_LENGTH
    || Buffer.byteLength(value, 'utf8') > MAX_SESSION_ID_BYTES
    || hasControlCharacter(value)
    || value === '.'
    || value === '..'
    || value.includes('/')
    || value.includes('\\')
  ) {
    throw new FollowUpQueueValidationError(`${field} is invalid`);
  }
  return value;
};

const normalizeIdentifier = (value: JsonValue | undefined, field: string): string => requireUtf8String(
  value,
  field,
  MAX_IDENTIFIER_BYTES,
  { nonEmpty: true, controlFree: true },
);

const normalizeClientMutationId = (value: JsonValue | undefined): string => normalizeIdentifier(value, 'clientMutationId');

const normalizeStatus = (value: JsonValue | undefined, field: string): FollowUpQueueStatus => {
  if (value !== 'staged' && value !== 'queued') {
    throw new FollowUpQueueValidationError(`${field} is invalid`);
  }
  return value;
};

const normalizeAttachment = (value: JsonValue | undefined, field: string): FollowUpQueueAttachment => {
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

  const normalized: FollowUpQueueAttachment = {
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

const normalizeAttachments = (value: JsonValue | undefined, field: string): FollowUpQueueAttachment[] => {
  if (!Array.isArray(value)) {
    throw new FollowUpQueueValidationError(`${field} must be an array`);
  }
  if (value.length > MAX_ATTACHMENTS_PER_ITEM) {
    throw new FollowUpQueueValidationError(`${field} exceeds its item limit`);
  }
  const attachments = value.map((attachment, index) => normalizeAttachment(attachment, `${field}[${index}]`));
  const seenIds = new Set<string>();
  for (const attachment of attachments) {
    if (seenIds.has(attachment.id)) {
      throw new FollowUpQueueValidationError(`${field} contains duplicate attachment ids`);
    }
    seenIds.add(attachment.id);
  }
  return attachments;
};

const normalizeMetadataValue = (value: JsonValue | undefined, field: string, depth = 0): JsonValue => {
  if (depth > MAX_METADATA_DEPTH) {
    throw new FollowUpQueueValidationError(`${field} exceeds its nesting limit`);
  }
  if (value === null) return value;
  if (isBoolean(value) || isString(value)) return value;
  if (isFiniteNumber(value)) return value;
  if (Object(value) !== value && Object.prototype.toString.call(value) === '[object Number]') {
    throw new FollowUpQueueValidationError(`${field} must be finite`);
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_METADATA_CONTAINER_ENTRIES) {
      throw new FollowUpQueueValidationError(`${field} exceeds its entry limit`);
    }
    return value.map((entry, index) => normalizeMetadataValue(entry, `${field}[${index}]`, depth + 1));
  }
  const record = requireRecord(value, field);
  const keys = Object.keys(record);
  if (keys.length > MAX_METADATA_CONTAINER_ENTRIES) {
    throw new FollowUpQueueValidationError(`${field} exceeds its entry limit`);
  }
  const normalized: JsonObject = {};
  for (const key of keys) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new FollowUpQueueValidationError(`${field} contains an unsafe key`);
    }
    normalized[key] = normalizeMetadataValue(record[key], `${field}.${key}`, depth + 1);
  }
  return normalized;
};

const normalizeContextMetadata = (value: JsonValue | undefined, field: string): FollowUpQueueContextMetadata => {
  const metadata = requireRecord(value, field);
  requireAllowedKeys(metadata, new Set(['openchamberContext']), field);
  if (!hasOwn(metadata, 'openchamberContext')) {
    throw new FollowUpQueueValidationError(`${field}.openchamberContext is required`);
  }
  const context = normalizeMetadataValue(metadata.openchamberContext, `${field}.openchamberContext`);
  if (!isRecord(context)) {
    throw new FollowUpQueueValidationError(`${field}.openchamberContext is invalid`);
  }
  requireUtf8String(context.kind, `${field}.openchamberContext.kind`, MAX_IDENTIFIER_BYTES, {
    nonEmpty: true,
    controlFree: true,
  });
  const normalized: FollowUpQueueContextMetadata = { openchamberContext: context };
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_METADATA_BYTES) {
    throw new FollowUpQueueValidationError(`${field} exceeds its byte limit`);
  }
  return normalized;
};

const normalizeAdditionalPart = (value: JsonValue | undefined, field: string): FollowUpQueueAdditionalPart => {
  const part = requireRecord(value, field);
  requireAllowedKeys(part, new Set(['text', 'attachments', 'synthetic', 'metadata']), field);
  const normalized: FollowUpQueueAdditionalPart = {
    text: requireUtf8String(part.text, `${field}.text`, MAX_CONTENT_BYTES),
  };
  if (hasOwn(part, 'attachments')) {
    normalized.attachments = normalizeAttachments(part.attachments, `${field}.attachments`);
  }
  if (hasOwn(part, 'synthetic')) {
    if (part.synthetic !== true && part.synthetic !== false) {
      throw new FollowUpQueueValidationError(`${field}.synthetic must be a boolean`);
    }
    normalized.synthetic = part.synthetic;
  }
  if (hasOwn(part, 'metadata')) {
    normalized.metadata = normalizeContextMetadata(part.metadata, `${field}.metadata`);
  }
  return normalized;
};

const normalizeAdditionalParts = (value: JsonValue | undefined, field: string): FollowUpQueueAdditionalPart[] => {
  if (!Array.isArray(value)) {
    throw new FollowUpQueueValidationError(`${field} must be an array`);
  }
  if (value.length > MAX_ADDITIONAL_PARTS_PER_ITEM) {
    throw new FollowUpQueueValidationError(`${field} exceeds its item limit`);
  }
  return value.map((part, index) => normalizeAdditionalPart(part, `${field}[${index}]`));
};

const normalizeSendConfig = (value: JsonValue | undefined, field: string): FollowUpQueueSendConfig => {
  const sendConfig = requireRecord(value, field);
  requireAllowedKeys(sendConfig, new Set(['providerID', 'modelID', 'agent', 'variant', 'executionFramework', 'subagentModel']), field);
  const normalized: FollowUpQueueSendConfig = {
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
  if (hasOwn(sendConfig, 'subagentModel')) {
    if (sendConfig.subagentModel === null) normalized.subagentModel = null;
    else {
      const choice = agentModelSchema.safeParse(sendConfig.subagentModel);
      if (!choice.success) throw new FollowUpQueueValidationError(`${field}.subagentModel is invalid`);
      normalized.subagentModel = choice.data;
    }
  }
  if (hasOwn(sendConfig, 'variant')) {
    normalized.variant = requireUtf8String(
      sendConfig.variant,
      `${field}.variant`,
      MAX_SEND_CONFIG_STRING_BYTES,
      { controlFree: true },
    );
  }
  if (hasOwn(sendConfig, 'executionFramework')) {
    if (sendConfig.executionFramework !== 'opencode' && sendConfig.executionFramework !== 'claude-code') {
      throw new FollowUpQueueValidationError(`${field}.executionFramework is invalid`);
    }
    normalized.executionFramework = sendConfig.executionFramework;
  }
  return normalized;
};

const normalizeClaim = (value: JsonValue | undefined, field: string): FollowUpQueueClaim => {
  const claim = requireRecord(value, field);
  requireAllowedKeys(claim, new Set(['id', 'expiresAt']), field);
  return {
    id: normalizeIdentifier(claim.id, `${field}.id`),
    expiresAt: normalizeNonNegativeInteger(claim.expiresAt, `${field}.expiresAt`),
  };
};

const normalizeItem = (
  value: JsonValue | undefined,
  field: string,
  options: { allowClaim?: boolean } = {},
): FollowUpQueueItem => {
  const item = requireRecord(value, field);
  requireAllowedKeys(
    item,
    new Set([
      'id',
      'messageId',
      'content',
      'attachments',
      'additionalParts',
      'agentMentionName',
      'createdAt',
      'status',
      'sendConfig',
      'claim',
      'goal',
    ]),
    field,
  );
  if (options.allowClaim === false && hasOwn(item, 'claim')) {
    throw new FollowUpQueueValidationError(`${field}.claim is host-owned`);
  }

  const attachments = hasOwn(item, 'attachments')
    ? normalizeAttachments(item.attachments, `${field}.attachments`)
    : undefined;
  const additionalParts = hasOwn(item, 'additionalParts')
    ? normalizeAdditionalParts(item.additionalParts, `${field}.additionalParts`)
    : undefined;
  const itemAttachments = [
    ...(attachments ?? []),
    ...(additionalParts ?? []).flatMap((part) => part.attachments ?? []),
  ];
  if (
    itemAttachments.length > MAX_ATTACHMENTS_PER_ITEM
    || new Set(itemAttachments.map((attachment) => attachment.id)).size !== itemAttachments.length
  ) {
    throw new FollowUpQueueValidationError(`${field} exceeds its total attachment count limit`);
  }
  const itemMetadataBytes = (additionalParts ?? []).reduce(
    (total, part) => total + (part.metadata ? Buffer.byteLength(JSON.stringify(part.metadata), 'utf8') : 0),
    0,
  );
  if (itemMetadataBytes > MAX_METADATA_BYTES) {
    throw new FollowUpQueueValidationError(`${field} exceeds its metadata byte limit`);
  }
  const content = requireUtf8String(item.content, `${field}.content`, MAX_CONTENT_BYTES);
  const itemContentBytes = Buffer.byteLength(content, 'utf8')
    + (additionalParts ?? []).reduce(
      (total, part) => total + Buffer.byteLength(part.text, 'utf8'),
      0,
    );
  if (itemContentBytes > MAX_CONTENT_BYTES) {
    throw new FollowUpQueueValidationError(`${field} exceeds its total content limit`);
  }

  const normalized: FollowUpQueueItem = {
    id: normalizeIdentifier(item.id, `${field}.id`),
    messageId: item.messageId === null ? null : normalizeIdentifier(item.messageId, `${field}.messageId`),
    content,
    createdAt: normalizeNonNegativeInteger(item.createdAt, `${field}.createdAt`),
    status: normalizeStatus(item.status, `${field}.status`),
  };
  if (attachments !== undefined) normalized.attachments = attachments;
  if (additionalParts !== undefined) normalized.additionalParts = additionalParts;
  if (hasOwn(item, 'agentMentionName')) {
    normalized.agentMentionName = requireUtf8String(
      item.agentMentionName,
      `${field}.agentMentionName`,
      MAX_AGENT_MENTION_NAME_BYTES,
      { nonEmpty: true, controlFree: true },
    );
  }
  if (hasOwn(item, 'sendConfig')) {
    normalized.sendConfig = normalizeSendConfig(item.sendConfig, `${field}.sendConfig`);
  }
  if (hasOwn(item, 'claim')) {
    normalized.claim = normalizeClaim(item.claim, `${field}.claim`);
  }
  if (hasOwn(item, 'goal')) {
    const goal = requireRecord(item.goal, `${field}.goal`);
    requireAllowedKeys(goal, new Set(['objective', 'tokenBudget']), `${field}.goal`);
    const tokenBudget = goal.tokenBudget === null ? null : normalizeNonNegativeInteger(goal.tokenBudget, `${field}.goal.tokenBudget`);
    if (tokenBudget === 0) throw new FollowUpQueueValidationError(`${field}.goal.tokenBudget must be positive`);
    normalized.goal = { tokenBudget };
    if (hasOwn(goal, 'objective')) {
      normalized.goal.objective = requireUtf8String(goal.objective, `${field}.goal.objective`, MAX_CONTENT_BYTES, { nonEmpty: true });
    }
  }

  return normalized;
};

const getAttachmentStringBytes = (attachment: FollowUpQueueAttachment): number => {
  let total = 0;
  for (const value of Object.values(attachment)) {
    if (isString(value)) total += Buffer.byteLength(JSON.stringify(value), 'utf8') - 2;
  }
  return total;
};

const assertItemsWithinLimits = (items: FollowUpQueueItem[], field = 'items'): void => {
  if (items.length > MAX_ITEMS) {
    throw new FollowUpQueueValidationError(`${field} exceeds its item limit`);
  }
  const seenIds = new Set<string>();
  const seenMessageIds = new Set<string>();
  let totalContentBytes = 0;
  let totalAttachments = 0;
  let totalAttachmentStringBytes = 0;
  let totalAdditionalParts = 0;
  let totalMetadataBytes = 0;
  for (const item of items) {
    if (seenIds.has(item.id)) {
      throw new FollowUpQueueValidationError(`${field} contains duplicate item ids`);
    }
    if (item.messageId !== null && seenMessageIds.has(item.messageId)) {
      throw new FollowUpQueueValidationError(`${field} contains duplicate message ids`);
    }
    seenIds.add(item.id);
    if (item.messageId !== null) seenMessageIds.add(item.messageId);
    totalContentBytes += Buffer.byteLength(JSON.stringify(item.content), 'utf8') - 2;
    for (const part of item.additionalParts ?? []) {
      totalAdditionalParts += 1;
      totalContentBytes += Buffer.byteLength(JSON.stringify(part.text), 'utf8') - 2;
      if (part.metadata) totalMetadataBytes += Buffer.byteLength(JSON.stringify(part.metadata), 'utf8');
      for (const attachment of part.attachments ?? []) {
        totalAttachments += 1;
        totalAttachmentStringBytes += getAttachmentStringBytes(attachment);
      }
    }
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
  if (totalAdditionalParts > MAX_ADDITIONAL_PARTS_PER_QUEUE) {
    throw new FollowUpQueueValidationError(`${field} exceeds its total additional part count limit`);
  }
  if (totalMetadataBytes > MAX_TOTAL_METADATA_BYTES) {
    throw new FollowUpQueueValidationError(`${field} exceeds its total metadata byte limit`);
  }
};

const normalizeItems = (value: JsonValue | undefined, field = 'items'): FollowUpQueueItem[] => {
  if (!Array.isArray(value)) {
    throw new FollowUpQueueValidationError(`${field} must be an array`);
  }
  const items = value.map((item, index) => normalizeItem(item, `${field}[${index}]`));
  assertItemsWithinLimits(items, field);
  return items;
};

const normalizeOperation = (value: JsonValue | undefined): FollowUpQueueOperation => {
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
    if (operation.beforeId !== null && !isString(operation.beforeId)) {
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

const normalizeMutationRequest = (value: JsonValue | undefined): NormalizedMutationRequest => {
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

const normalizeScope = (value: JsonValue | undefined, field = 'scope'): FollowUpQueueScope => {
  const scope = requireRecord(value, field);
  requireAllowedKeys(scope, new Set(['kind', 'sessionId']), field);
  if (scope.kind !== 'session') {
    throw new FollowUpQueueValidationError(`${field}.kind is unsupported`);
  }
  return { kind: 'session', sessionId: normalizeSessionId(scope.sessionId, `${field}.sessionId`) };
};

const normalizeStoredMutations = (value: JsonValue | undefined, revision: number): FollowUpQueueMutationRecord[] => {
  if (!Array.isArray(value) || value.length > MAX_PERSISTED_MUTATION_DEDUPE) {
    throw new FollowUpQueueValidationError('recentMutations is invalid');
  }
  const records: FollowUpQueueMutationRecord[] = [];
  const seenIds = new Set<string>();
  let previousMutationRevision = 0;
  for (let index = 0; index < value.length; index += 1) {
    const field = `recentMutations[${index}]`;
    const record = requireRecord(value[index], field);
    requireAllowedKeys(record, new Set(['clientMutationId', 'fingerprint', 'mutationRevision']), field);
    const clientMutationId = normalizeClientMutationId(record.clientMutationId);
    if (seenIds.has(clientMutationId)) {
      throw new FollowUpQueueValidationError('recentMutations contains duplicate clientMutationId values');
    }
    if (!isString(record.fingerprint) || !/^[\da-f]{64}$/.test(record.fingerprint)) {
      throw new FollowUpQueueValidationError(`${field}.fingerprint is invalid`);
    }

    let mutationRevision: number | null = null;
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

const normalizeStorageEnvelope = (
  value: JsonValue | undefined,
  expectedScope: FollowUpQueueScope,
): NormalizedStorageEnvelope => {
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

const cloneAttachment = (attachment: FollowUpQueueAttachment): FollowUpQueueAttachment => ({ ...attachment });
const cloneMetadata = (metadata: FollowUpQueueContextMetadata): FollowUpQueueContextMetadata => structuredClone(metadata);

const cloneItem = (item: FollowUpQueueItem): FollowUpQueueItem => {
  const cloned: FollowUpQueueItem = {
    id: item.id,
    messageId: item.messageId,
    content: item.content,
    createdAt: item.createdAt,
    status: item.status,
  };
  if (item.attachments !== undefined) {
    cloned.attachments = item.attachments.map(cloneAttachment);
  }
  if (item.additionalParts !== undefined) {
    cloned.additionalParts = item.additionalParts.map((part) => {
      const clonedPart: FollowUpQueueAdditionalPart = { text: part.text };
      if (part.attachments !== undefined) clonedPart.attachments = part.attachments.map(cloneAttachment);
      if (part.synthetic !== undefined) clonedPart.synthetic = part.synthetic;
      if (part.metadata !== undefined) clonedPart.metadata = cloneMetadata(part.metadata);
      return clonedPart;
    });
  }
  if (item.agentMentionName !== undefined) cloned.agentMentionName = item.agentMentionName;
  if (item.sendConfig !== undefined) cloned.sendConfig = structuredClone(item.sendConfig);
  if (item.claim !== undefined) cloned.claim = { ...item.claim };
  if (item.goal !== undefined) cloned.goal = { ...item.goal };
  return cloned;
};

const cloneItems = (items: FollowUpQueueItem[]): FollowUpQueueItem[] => items.map(cloneItem);
const cloneScope = (scope: FollowUpQueueScope): FollowUpQueueScope => ({ kind: 'session', sessionId: scope.sessionId });

const createStorageEnvelope = (
  scope: FollowUpQueueScope,
  revision: number,
  items: FollowUpQueueItem[],
  recentMutations: FollowUpQueueMutationRecord[],
  terminal = false,
): FollowUpQueueStoredEnvelope => {
  const envelope: FollowUpQueueStoredEnvelope = {
    storageVersion: FOLLOW_UP_QUEUE_STORAGE_VERSION,
    scope: cloneScope(scope),
    revision,
    items: cloneItems(items),
    recentMutations: recentMutations.map((record) => ({ ...record })),
  };
  if (terminal) envelope.terminal = true;
  return envelope;
};

const createSnapshot = (
  scopeToken: string,
  envelope: Pick<NormalizedStorageEnvelope, 'revision' | 'items'> | null,
): FollowUpQueueSnapshot => ({
  scopeToken,
  revision: envelope?.revision ?? 0,
  items: cloneItems(envelope?.items ?? []),
});

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const getScopeToken = (scope: FollowUpQueueScope): string => sha256(JSON.stringify(scope));
const fingerprintOperation = (operation: FollowUpQueueOperation | { type: 'terminalize' }): string => (
  sha256(JSON.stringify(operation))
);

const requireDependency = <T>(value: T | undefined, name: string): T => {
  if (!value) throw new FollowUpQueueValidationError(`${name} is required`);
  return value;
};

const itemsEqual = (first: FollowUpQueueItem, second: FollowUpQueueItem): boolean => (
  JSON.stringify(first) === JSON.stringify(second)
);

interface FollowUpQueueOperationResult {
  items: FollowUpQueueItem[];
  changed: boolean;
}

const applyOperation = (
  items: FollowUpQueueItem[],
  operation: FollowUpQueueOperation,
  now: () => number,
  createMessageId: (timestamp: number) => string,
): FollowUpQueueOperationResult => {
  if (operation.type === 'add') {
    const identityMatches = items.filter(
      (item) => item.id === operation.item.id || (
        item.messageId !== null
        && operation.item.messageId !== null
        && item.messageId === operation.item.messageId
      ),
    );
    if (identityMatches.length > 0) {
      const firstMatch = identityMatches[0];
      if (identityMatches.length === 1 && firstMatch && itemsEqual(firstMatch, operation.item)) {
        return { items, changed: false };
      }
      throw new FollowUpQueueItemConflictError();
    }
    const nextItems = [...items, operation.item];
    assertItemsWithinLimits(nextItems);
    return { items: nextItems, changed: true };
  }

  const itemIndex = items.findIndex((item) => item.id === operation.itemId);
  if (itemIndex === -1) return { items, changed: false };
  const currentItem = items[itemIndex];
  if (!currentItem) return { items, changed: false };

  if (operation.type === 'remove') {
    if (currentItem.claim?.id.startsWith('host-import-')) {
      return { items, changed: false };
    }
    return { items: items.filter((_, index) => index !== itemIndex), changed: true };
  }

  if (operation.type === 'set-status') {
    if (currentItem.claim?.id.startsWith('host-import-')) {
      return { items, changed: false };
    }
    if (currentItem.status === operation.status) return { items, changed: false };
    const nextItems = items.slice();
    nextItems[itemIndex] = { ...currentItem, status: operation.status };
    return { items: nextItems, changed: true };
  }

  if (operation.type === 'move') {
    if (operation.beforeId === operation.itemId) return { items, changed: false };
    const nextItems = items.slice();
    const [moved] = nextItems.splice(itemIndex, 1);
    if (!moved) return { items, changed: false };
    const targetIndex = operation.beforeId === null
      ? nextItems.length
      : nextItems.findIndex((item) => item.id === operation.beforeId);
    if (targetIndex === -1) return { items, changed: false };
    nextItems.splice(targetIndex, 0, moved);
    const changed = nextItems.some((item, index) => item !== items[index]);
    return changed ? { items: nextItems, changed: true } : { items, changed: false };
  }

  if (operation.type === 'claim') {
    if (operation.mode === 'auto' && currentItem.status !== 'queued') return { items, changed: false };
    const timestamp = now();
    if (!isSafeInteger(timestamp) || timestamp < 0 || timestamp > Number.MAX_SAFE_INTEGER - CLAIM_TTL_MS) {
      throw new FollowUpQueueWriteError();
    }
    if (currentItem.claim && currentItem.claim.id !== operation.claimId
      && (currentItem.claim.id.startsWith('host-import-') || currentItem.claim.expiresAt > timestamp)) {
      return { items, changed: false };
    }
    const claim: FollowUpQueueClaim = { id: operation.claimId, expiresAt: timestamp + CLAIM_TTL_MS };
    if (currentItem.claim?.id === claim.id && currentItem.claim.expiresAt === claim.expiresAt) {
      return { items, changed: false };
    }
    const messageId = currentItem.messageId === null
      ? normalizeIdentifier(createMessageId(timestamp), 'generated messageId')
      : currentItem.messageId;
    const nextItems = items.slice();
    nextItems[itemIndex] = {
      ...currentItem,
      messageId,
      claim,
    };
    assertItemsWithinLimits(nextItems);
    return { items: nextItems, changed: true };
  }

  if (operation.type === 'complete') {
    if (currentItem.claim?.id !== operation.claimId) return { items, changed: false };
    return { items: items.filter((_, index) => index !== itemIndex), changed: true };
  }

  if (operation.type === 'release') {
    if (currentItem.claim?.id !== operation.claimId) return { items, changed: false };
    const { claim: _claim, ...released } = currentItem;
    void _claim;
    const nextItems = items.slice();
    nextItems[itemIndex] = { ...released, status: operation.status };
    return { items: nextItems, changed: true };
  }

  return { items, changed: false };
};

export const createFollowUpQueueCore = (dependencies: FollowUpQueueCoreOptions) => {
  const options: Partial<FollowUpQueueCoreOptions> = isCoreOptions(dependencies) ? dependencies : {};
  const fsPromises = requireDependency(options.fsPromises, 'fsPromises');
  const path = requireDependency(options.path, 'path');
  const rootDirectory = options.rootDirectory;
  const dedupeLimit = options.dedupeLimit ?? DEFAULT_MUTATION_DEDUPE_LIMIT;
  const createTempId = options.createTempId ?? randomUUID;
  const createLockId = options.createLockId ?? randomUUID;
  const now = options.now ?? Date.now;
  const createMessageId = options.createMessageId ?? createOpenCodeMessageId;
  const waitForLock = options.waitForLock ?? ((delayMs: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  }));

  const requiredFsMethods: readonly (keyof FollowUpQueueFsPromises)[] = [
    'stat', 'readFile', 'writeFile', 'mkdir', 'rename', 'unlink', 'rmdir',
  ];
  for (const method of requiredFsMethods) {
    if (!isCallable(fsPromises[method])) {
      throw new FollowUpQueueValidationError(`fsPromises.${method} is required`);
    }
  }
  if (
    !isCallable(path.isAbsolute)
    || !isCallable(path.join)
    || !isCallable(path.dirname)
  ) {
    throw new FollowUpQueueValidationError('path.isAbsolute, path.join, and path.dirname are required');
  }
  if (
    !isString(rootDirectory)
    || rootDirectory.length === 0
    || rootDirectory.includes('\u0000')
    || !path.isAbsolute(rootDirectory)
  ) {
    throw new FollowUpQueueValidationError('rootDirectory must be an absolute path');
  }
  if (
    !isSafeInteger(dedupeLimit)
    || dedupeLimit < 1
    || dedupeLimit > MAX_PERSISTED_MUTATION_DEDUPE
  ) {
    throw new FollowUpQueueValidationError('dedupeLimit is invalid');
  }
  if (
    !isCallable(createTempId)
    || !isCallable(createLockId)
    || !isCallable(now)
    || !isCallable(waitForLock)
  ) {
    throw new FollowUpQueueValidationError('createTempId, createLockId, now, and waitForLock must be functions');
  }

  const scopeQueues = new Map<string, Promise<void>>();
  let temporarySequence = 0;
  let lockSequence = 0;
  let rootDirectoryPromise: Promise<void> | null = null;

  const enqueue = <T>(scopeToken: string, task: () => Promise<T>): Promise<T> => {
    const previous = scopeQueues.get(scopeToken) ?? Promise.resolve();
    const result = previous.then(task, task);
    const tail = result.then(() => undefined, () => undefined);
    scopeQueues.set(scopeToken, tail);
    void tail.then(() => {
      if (scopeQueues.get(scopeToken) === tail) scopeQueues.delete(scopeToken);
    });
    return result;
  };

  const filePathForToken = (scopeToken: string): string => path.join(rootDirectory, `${scopeToken}.json`);
  const terminalFencePathForToken = (scopeToken: string): string => path.join(rootDirectory, `.terminal-${scopeToken}.json`);

  const ensureRootDirectory = (): Promise<void> => {
    if (rootDirectoryPromise) return rootDirectoryPromise;
    rootDirectoryPromise = (async () => {
      try {
        const created = await fsPromises.mkdir(rootDirectory, { recursive: true, mode: 0o700 });
        if (
          created
          && process.platform !== 'win32'
          && isCallable(fsPromises.open)
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

  const isDirectoryCollision = async (code: string | null, targetDirectory: string): Promise<boolean> => {
    if (code === 'EEXIST' || code === 'ENOTEMPTY') return true;
    if (code !== 'EACCES' && code !== 'EPERM') return false;
    try {
      const stats = await fsPromises.stat(targetDirectory);
      return !isCallable(stats.isDirectory) || stats.isDirectory();
    } catch {
      return false;
    }
  };

  const isPidAlive = (pid: number): boolean => {
    if (!isSafeInteger(pid) || pid < 1) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return isErrorCode(error, 'EPERM');
    }
  };

  const nextLockSuffix = (): string => {
    lockSequence += 1;
    const randomPart = String(createLockId());
    if (randomPart.length > 128 || !/^[A-Za-z0-9_-]+$/.test(randomPart)) {
      throw new FollowUpQueueWriteError();
    }
    return `${process.pid}-${lockSequence}-${randomPart}`;
  };

  const removeOwnedLockDirectory = async (lockDirectory: string, ownerFile: string): Promise<void> => {
    await fsPromises.unlink(ownerFile).catch(() => undefined);
    await fsPromises.rmdir(lockDirectory).catch(() => undefined);
  };

  const tryClearStaleLock = async (lockDirectory: string, ownerFile: string): Promise<boolean> => {
    let owner: { pid: number; token: string } | null = null;
    let ownerRaw: string | null = null;
    try {
      ownerRaw = await fsPromises.readFile(ownerFile, 'utf8');
      let parsed: JsonValue;
      try {
        parsed = JSON.parse(ownerRaw);
      } catch {
        throw new FollowUpQueueWriteError();
      }
      if (
        isRecord(parsed)
        && isSafeInteger(parsed.pid)
        && parsed.pid > 0
        && isString(parsed.token)
        && parsed.token.length <= 192
        && /^[A-Za-z0-9_-]+$/.test(parsed.token)
      ) {
        owner = { pid: parsed.pid, token: parsed.token };
      }
      if (!owner) throw new FollowUpQueueWriteError();
    } catch (error) {
      if (error instanceof FollowUpQueueWriteError) throw error;
      if (!isErrorCode(error, 'ENOENT')) throw new FollowUpQueueWriteError();
    }
    if (owner && isPidAlive(owner.pid)) return false;

    let lockStats: Awaited<ReturnType<FollowUpQueueFsPromises['stat']>> | null = null;
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
      if (isErrorCode(error, 'ENOENT') || await isDirectoryCollision(isErrorWithCode(error) ? error.code : null, staleDirectory)) return true;
      throw new FollowUpQueueWriteError();
    }
    return true;
  };

  const acquireScopeLock = async (scopeToken: string): Promise<() => Promise<void>> => {
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
          if (await isDirectoryCollision(isErrorWithCode(error) ? error.code : null, lockDirectory)) {
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
          let releaseRetryMs = 5;
          while (true) {
            let currentToken: JsonValue | null = null;
            try {
              const parsed: JsonValue = JSON.parse(await fsPromises.readFile(ownerFile, 'utf8'));
              currentToken = isRecord(parsed) ? (parsed.token ?? null) : null;
            } catch (error) {
              if (isErrorCode(error, 'ENOENT')) throw new FollowUpQueueWriteError();
              await waitForLock(releaseRetryMs);
              releaseRetryMs = Math.min(releaseRetryMs * 2, MAX_LOCK_RETRY_MS);
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
              await waitForLock(releaseRetryMs);
              releaseRetryMs = Math.min(releaseRetryMs * 2, MAX_LOCK_RETRY_MS);
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

  const withScopeLock = async <T>(scopeToken: string, task: () => Promise<T>): Promise<T> => {
    const release = await acquireScopeLock(scopeToken);
    try {
      return await task();
    } finally {
      await release();
    }
  };

  const readEnvelope = async (filePath: string, scope: FollowUpQueueScope): Promise<NormalizedStorageEnvelope | null> => {
    let raw: string;
    try {
      if (isCallable(fsPromises.stat)) {
        const stats = await fsPromises.stat(filePath);
        if (!isSafeInteger(stats.size) || stats.size > MAX_FOLLOW_UP_QUEUE_FILE_BYTES) {
          throw new FollowUpQueueCorruptError();
        }
      }
      raw = await fsPromises.readFile(filePath, 'utf8');
    } catch (error) {
      if (isMissingFileError(error)) return null;
      if (error instanceof FollowUpQueueCorruptError) throw error;
      throw new FollowUpQueueReadError();
    }
    if (!isString(raw) || Buffer.byteLength(raw, 'utf8') > MAX_FOLLOW_UP_QUEUE_FILE_BYTES) {
      throw new FollowUpQueueCorruptError();
    }

    let parsed: JsonValue;
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

  const readCorruptRevision = async (filePath: string): Promise<number | null> => {
    try {
      const stats = await fsPromises.stat(filePath);
      if (!isSafeInteger(stats.size) || stats.size > MAX_FOLLOW_UP_QUEUE_FILE_BYTES) return null;
      const raw = await fsPromises.readFile(filePath, 'utf8');
      if (!isString(raw) || Buffer.byteLength(raw, 'utf8') > MAX_FOLLOW_UP_QUEUE_FILE_BYTES) return null;
      const parsed: JsonValue = JSON.parse(raw);
      if (
        !isRecord(parsed)
        || !isSafeInteger(parsed.revision)
        || parsed.revision < 0
        || parsed.revision >= Number.MAX_SAFE_INTEGER
      ) return null;
      return parsed.revision;
    } catch {
      return null;
    }
  };

  const nextTemporaryPath = (filePath: string): string => {
    temporarySequence += 1;
    const randomPart = String(createTempId());
    if (randomPart.length > 128 || !/^[A-Za-z0-9_-]+$/.test(randomPart)) {
      throw new FollowUpQueueValidationError('createTempId returned an invalid value');
    }
    return `${filePath}.tmp-${process.pid}-${temporarySequence}-${randomPart}`;
  };

  const writeEnvelope = async (filePath: string, envelope: FollowUpQueueStoredEnvelope): Promise<void> => {
    const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_FOLLOW_UP_QUEUE_FILE_BYTES) {
      throw new FollowUpQueueWriteError();
    }

    let temporaryPath: string | undefined;
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
      if (process.platform !== 'win32' && isCallable(fsPromises.open)) {
        const directory = await fsPromises.open(rootDirectory, 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } catch {
      if (temporaryPath && !renamed) {
        await fsPromises.unlink(temporaryPath).catch(() => undefined);
      }
      throw new FollowUpQueueWriteError();
    }
  };

  const hasTerminalFence = async (scopeToken: string): Promise<boolean> => {
    try {
      await fsPromises.stat(terminalFencePathForToken(scopeToken));
      return true;
    } catch (error) {
      if (isErrorCode(error, 'ENOENT')) return false;
      throw new FollowUpQueueReadError();
    }
  };

  const ensureTerminalFence = async (scope: FollowUpQueueScope, scopeToken: string): Promise<void> => {
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
      if (process.platform !== 'win32' && isCallable(fsPromises.open)) {
        const directory = await fsPromises.open(rootDirectory, 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } catch {
      throw new FollowUpQueueWriteError();
    }
  };

  const appendMutation = (
    recentMutations: FollowUpQueueMutationRecord[],
    clientMutationId: string,
    fingerprint: string,
    mutationRevision: number | null,
  ): FollowUpQueueMutationRecord[] => ([
    ...recentMutations,
    { clientMutationId, fingerprint, mutationRevision },
  ].slice(-dedupeLimit));

  const load = async (inputSessionId: JsonValue | undefined): Promise<FollowUpQueueSnapshot> => {
    const scope: FollowUpQueueScope = { kind: 'session', sessionId: normalizeSessionId(inputSessionId) };
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

  const applyMutation = async (input: JsonValue | undefined): Promise<FollowUpQueueMutationResult> => {
    const mutation = normalizeMutationRequest(input);
    const scope: FollowUpQueueScope = { kind: 'session', sessionId: mutation.sessionId };
    const scopeToken = getScopeToken(scope);
    const fingerprint = fingerprintOperation(mutation.operation);
    const filePath = filePathForToken(scopeToken);

    return enqueue(scopeToken, () => withScopeLock(scopeToken, async () => {
      const stored = await readEnvelope(filePath, scope);
      if (await hasTerminalFence(scopeToken) && !stored?.terminal) {
        throw new FollowUpQueueReadError();
      }
      const envelope: NormalizedStorageEnvelope = stored ?? {
        storageVersion: FOLLOW_UP_QUEUE_STORAGE_VERSION,
        scope: cloneScope(scope),
        revision: 0,
        items: [],
        recentMutations: [],
        terminal: false,
      };
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
      let mutationRevision: number | null = null;
      if (!envelope.terminal) {
        const result = applyOperation(envelope.items, mutation.operation, now, createMessageId);
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

  const terminalizeSession = async (
    inputSessionId: JsonValue | undefined,
    inputClientMutationId: JsonValue | undefined,
  ): Promise<FollowUpQueueMutationResult> => {
    const scope: FollowUpQueueScope = { kind: 'session', sessionId: normalizeSessionId(inputSessionId) };
    const clientMutationId = normalizeClientMutationId(inputClientMutationId);
    const operation = { type: 'terminalize' as const };
    const fingerprint = fingerprintOperation(operation);
    const scopeToken = getScopeToken(scope);
    const filePath = filePathForToken(scopeToken);

    return enqueue(scopeToken, () => withScopeLock(scopeToken, async () => {
      await ensureTerminalFence(scope, scopeToken);
      let stored: NormalizedStorageEnvelope | null;
      try {
        stored = await readEnvelope(filePath, scope);
      } catch (error) {
        if (!(error instanceof FollowUpQueueCorruptError)) throw error;
        const corruptRevision = await readCorruptRevision(filePath);
        stored = corruptRevision === null
          ? null
          : {
            storageVersion: FOLLOW_UP_QUEUE_STORAGE_VERSION,
            scope: cloneScope(scope),
            revision: corruptRevision,
            items: [],
            recentMutations: [],
            terminal: false,
          };
      }
      const envelope: NormalizedStorageEnvelope = stored ?? {
        storageVersion: FOLLOW_UP_QUEUE_STORAGE_VERSION,
        scope: cloneScope(scope),
        revision: 0,
        items: [],
        recentMutations: [],
        terminal: false,
      };
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
      let mutationRevision: number | null = null;
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

  const listStoredSessions = async (): Promise<FollowUpQueueStoredSessionsResult> => {
    if (!isCallable(fsPromises.readdir)) {
      throw new FollowUpQueueReadError();
    }
    let names: string[];
    try {
      names = await fsPromises.readdir(rootDirectory);
    } catch (error) {
      if (isErrorCode(error, 'ENOENT')) return { sessions: [], unreadable: 0 };
      throw new FollowUpQueueReadError();
    }

    const sessions: FollowUpQueueStoredSessionEntry[] = [];
    const sessionsByToken = new Map<string, FollowUpQueueStoredSessionEntry>();
    let unreadable = 0;
    for (const name of names.sort()) {
      const match = /^([\da-f]{64})\.json$/.exec(name);
      const token = match?.[1];
      if (!token) continue;
      try {
        const filePath = path.join(rootDirectory, name);
        const stats = await fsPromises.stat(filePath);
        if (!isSafeInteger(stats.size) || stats.size > MAX_FOLLOW_UP_QUEUE_FILE_BYTES) {
          unreadable += 1;
          continue;
        }
        const raw = await fsPromises.readFile(filePath, 'utf8');
        if (!isString(raw) || Buffer.byteLength(raw, 'utf8') > MAX_FOLLOW_UP_QUEUE_FILE_BYTES) {
          unreadable += 1;
          continue;
        }
        const parsed: JsonValue = JSON.parse(raw);
        const scope = normalizeScope(requireRecord(parsed, 'follow-up queue file').scope, 'stored scope');
        if (getScopeToken(scope) !== token) {
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
        const entry: FollowUpQueueStoredSessionEntry = {
          sessionId: scope.sessionId,
          terminal,
          corrupt,
          terminalPending: false,
        };
        sessions.push(entry);
        sessionsByToken.set(token, entry);
      } catch {
        unreadable += 1;
      }
    }

    for (const name of names.sort()) {
      const match = /^\.terminal-([\da-f]{64})\.json$/.exec(name);
      const token = match?.[1];
      if (!token) continue;
      try {
        const raw = await fsPromises.readFile(path.join(rootDirectory, name), 'utf8');
        const parsed = requireRecord(JSON.parse(raw), 'follow-up queue terminal fence');
        requireAllowedKeys(parsed, new Set(['storageVersion', 'scope']), 'follow-up queue terminal fence');
        if (parsed.storageVersion !== FOLLOW_UP_QUEUE_STORAGE_VERSION) throw new Error('invalid fence version');
        const scope = normalizeScope(parsed.scope, 'terminal fence scope');
        if (getScopeToken(scope) !== token) throw new Error('invalid fence scope');
        const existing = sessionsByToken.get(token);
        if (existing) {
          existing.terminalPending = !existing.terminal;
        } else {
          const entry: FollowUpQueueStoredSessionEntry = {
            sessionId: scope.sessionId,
            terminal: false,
            corrupt: true,
            terminalPending: true,
          };
          sessions.push(entry);
          sessionsByToken.set(token, entry);
        }
      } catch {
        unreadable += 1;
      }
    }
    return { sessions, unreadable };
  };

  return { load, applyMutation, terminalizeSession, listStoredSessions };
};

export type FollowUpQueueCore = ReturnType<typeof createFollowUpQueueCore>;
