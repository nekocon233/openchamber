import type {
  FollowUpQueueAttachment,
  FollowUpQueueItem,
  FollowUpQueueMutationResult,
  FollowUpQueueOperation,
  FollowUpQueueSendConfig,
  FollowUpQueueSnapshot,
  FollowUpQueueStatus,
} from '@/lib/api/types';

const SCOPE_TOKEN_PATTERN = /^[\da-f]{64}$/;
const MAX_ITEMS = 256;
const MAX_ATTACHMENTS_PER_ITEM = 32;
const MAX_ATTACHMENTS_PER_QUEUE = 512;
const MAX_CONTENT_BYTES = 1024 * 1024;
const MAX_TOTAL_CONTENT_BYTES = 4 * 1024 * 1024;
const MAX_ATTACHMENT_DATA_URL_BYTES = 56 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_STRING_BYTES = 56 * 1024 * 1024;
const MAX_ATTACHMENT_SIZE = 2 * 1024 * 1024 * 1024;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_MIME_TYPE_BYTES = 256;
const MAX_FILENAME_BYTES = 4096;
const MAX_ATTACHMENT_PATH_BYTES = 16 * 1024;
const MAX_SEND_CONFIG_STRING_BYTES = 1024;

export const FOLLOW_UP_QUEUE_CLAIM_TTL_MS = 120_000;

export class FollowUpQueueRequestError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly permanent: boolean;

  constructor(message: string, options: { status: number; code?: string | null; permanent?: boolean }) {
    super(message);
    this.name = 'FollowUpQueueRequestError';
    this.status = options.status;
    this.code = options.code ?? null;
    this.permanent = options.permanent ?? false;
  }
}

export class FollowUpQueueUnsupportedError extends FollowUpQueueRequestError {
  constructor() {
    super('Host-authoritative follow-up queues are not supported by this OpenChamber instance', {
      status: 501,
      code: 'FOLLOW_UP_QUEUE_UNSUPPORTED',
      permanent: true,
    });
    this.name = 'FollowUpQueueUnsupportedError';
  }
}

export class FollowUpQueueConflictError extends FollowUpQueueRequestError {
  readonly latestSnapshot: FollowUpQueueSnapshot;

  constructor(latestSnapshot: FollowUpQueueSnapshot) {
    super('Follow-up queue revision conflict', {
      status: 409,
      code: 'FOLLOW_UP_QUEUE_CONFLICT',
      permanent: false,
    });
    this.name = 'FollowUpQueueConflictError';
    this.latestSnapshot = latestSnapshot;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const assertKeys = (value: Record<string, unknown>, allowed: readonly string[], field: string): void => {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new Error(`Invalid follow-up queue ${field}`);
  }
};

const utf8Length = (value: string): number => new TextEncoder().encode(value).byteLength;
const hasControlCharacter = (value: string): boolean => Array.from(value).some((character) => {
  const code = character.charCodeAt(0);
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
});

const parseString = (
  value: unknown,
  field: string,
  maximumBytes: number,
  options: { nonEmpty?: boolean; controlFree?: boolean } = {},
): string => {
  if (
    typeof value !== 'string'
    || (options.nonEmpty === true && value.length === 0)
    || utf8Length(value) > maximumBytes
    || (options.controlFree === true && hasControlCharacter(value))
  ) {
    throw new Error(`Invalid follow-up queue ${field}`);
  }
  return value;
};

const parseIdentifier = (value: unknown, field: string): string => (
  parseString(value, field, MAX_IDENTIFIER_BYTES, { nonEmpty: true, controlFree: true })
);

const parseInteger = (value: unknown, field: string, maximum = Number.MAX_SAFE_INTEGER): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) {
    throw new Error(`Invalid follow-up queue ${field}`);
  }
  return Number(value);
};

const parseStatus = (value: unknown, field: string): FollowUpQueueStatus => {
  if (value !== 'staged' && value !== 'queued') throw new Error(`Invalid follow-up queue ${field}`);
  return value;
};

const parseAttachment = (value: unknown, field: string): FollowUpQueueAttachment => {
  if (!isRecord(value)) throw new Error(`Invalid follow-up queue ${field}`);
  assertKeys(value, [
    'id',
    'dataUrl',
    'mimeType',
    'filename',
    'size',
    'source',
    'serverPath',
    'vscodePath',
    'vscodeSource',
  ], field);
  if (value.source !== 'local' && value.source !== 'server' && value.source !== 'vscode') {
    throw new Error(`Invalid follow-up queue ${field}.source`);
  }
  if (value.vscodeSource !== undefined && value.vscodeSource !== 'file' && value.vscodeSource !== 'selection') {
    throw new Error(`Invalid follow-up queue ${field}.vscodeSource`);
  }

  return {
    id: parseIdentifier(value.id, `${field}.id`),
    dataUrl: parseString(value.dataUrl, `${field}.dataUrl`, MAX_ATTACHMENT_DATA_URL_BYTES),
    mimeType: parseString(value.mimeType, `${field}.mimeType`, MAX_MIME_TYPE_BYTES, { nonEmpty: true, controlFree: true }),
    filename: parseString(value.filename, `${field}.filename`, MAX_FILENAME_BYTES, { controlFree: true }),
    size: parseInteger(value.size, `${field}.size`, MAX_ATTACHMENT_SIZE),
    source: value.source,
    ...(value.serverPath !== undefined ? {
      serverPath: parseString(value.serverPath, `${field}.serverPath`, MAX_ATTACHMENT_PATH_BYTES, { controlFree: true }),
    } : {}),
    ...(value.vscodePath !== undefined ? {
      vscodePath: parseString(value.vscodePath, `${field}.vscodePath`, MAX_ATTACHMENT_PATH_BYTES, { controlFree: true }),
    } : {}),
    ...(value.vscodeSource !== undefined ? { vscodeSource: value.vscodeSource } : {}),
  };
};

const parseSendConfig = (value: unknown, field: string): FollowUpQueueSendConfig => {
  if (!isRecord(value)) throw new Error(`Invalid follow-up queue ${field}`);
  assertKeys(value, ['providerID', 'modelID', 'agent', 'variant'], field);
  return {
    providerID: parseString(value.providerID, `${field}.providerID`, MAX_SEND_CONFIG_STRING_BYTES, { nonEmpty: true, controlFree: true }),
    modelID: parseString(value.modelID, `${field}.modelID`, MAX_SEND_CONFIG_STRING_BYTES, { nonEmpty: true, controlFree: true }),
    ...(value.agent !== undefined ? {
      agent: parseString(value.agent, `${field}.agent`, MAX_SEND_CONFIG_STRING_BYTES, { controlFree: true }),
    } : {}),
    ...(value.variant !== undefined ? {
      variant: parseString(value.variant, `${field}.variant`, MAX_SEND_CONFIG_STRING_BYTES, { controlFree: true }),
    } : {}),
  };
};

export const parseFollowUpQueueItem = (
  value: unknown,
  options: { allowClaim?: boolean; field?: string } = {},
): FollowUpQueueItem => {
  const field = options.field ?? 'item';
  if (!isRecord(value)) throw new Error(`Invalid follow-up queue ${field}`);
  assertKeys(value, ['id', 'messageId', 'content', 'attachments', 'createdAt', 'status', 'sendConfig', 'claim'], field);
  if (options.allowClaim === false && value.claim !== undefined) {
    throw new Error(`Invalid follow-up queue ${field}.claim`);
  }
  if (value.attachments !== undefined && !Array.isArray(value.attachments)) {
    throw new Error(`Invalid follow-up queue ${field}.attachments`);
  }
  if (Array.isArray(value.attachments) && value.attachments.length > MAX_ATTACHMENTS_PER_ITEM) {
    throw new Error(`Invalid follow-up queue ${field}.attachments`);
  }
  const attachments = value.attachments === undefined
    ? undefined
    : value.attachments.map((attachment, index) => parseAttachment(attachment, `${field}.attachments[${index}]`));
  if (attachments && new Set(attachments.map((attachment) => attachment.id)).size !== attachments.length) {
    throw new Error(`Invalid follow-up queue ${field}.attachments`);
  }
  let claim: FollowUpQueueItem['claim'];
  if (value.claim !== undefined) {
    if (!isRecord(value.claim)) throw new Error(`Invalid follow-up queue ${field}.claim`);
    assertKeys(value.claim, ['id', 'expiresAt'], `${field}.claim`);
    claim = {
      id: parseIdentifier(value.claim.id, `${field}.claim.id`),
      expiresAt: parseInteger(value.claim.expiresAt, `${field}.claim.expiresAt`),
    };
  }

  return {
    id: parseIdentifier(value.id, `${field}.id`),
    messageId: parseIdentifier(value.messageId, `${field}.messageId`),
    content: parseString(value.content, `${field}.content`, MAX_CONTENT_BYTES),
    ...(attachments ? { attachments } : {}),
    createdAt: parseInteger(value.createdAt, `${field}.createdAt`),
    status: parseStatus(value.status, `${field}.status`),
    ...(value.sendConfig !== undefined ? { sendConfig: parseSendConfig(value.sendConfig, `${field}.sendConfig`) } : {}),
    ...(claim ? { claim } : {}),
  };
};

const parseItems = (value: unknown): FollowUpQueueItem[] => {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) throw new Error('Invalid follow-up queue items');
  const items = value.map((item, index) => parseFollowUpQueueItem(item, { field: `items[${index}]` }));
  const itemIds = new Set<string>();
  const messageIds = new Set<string>();
  let contentBytes = 0;
  let attachmentCount = 0;
  let attachmentStringBytes = 0;
  for (const item of items) {
    if (itemIds.has(item.id) || messageIds.has(item.messageId)) throw new Error('Invalid follow-up queue item identity');
    itemIds.add(item.id);
    messageIds.add(item.messageId);
    contentBytes += utf8Length(item.content);
    for (const attachment of item.attachments ?? []) {
      attachmentCount += 1;
      for (const entry of Object.values(attachment)) {
        if (typeof entry === 'string') attachmentStringBytes += utf8Length(entry);
      }
    }
  }
  if (
    contentBytes > MAX_TOTAL_CONTENT_BYTES
    || attachmentCount > MAX_ATTACHMENTS_PER_QUEUE
    || attachmentStringBytes > MAX_TOTAL_ATTACHMENT_STRING_BYTES
  ) {
    throw new Error('Invalid follow-up queue aggregate limits');
  }
  return items;
};

export const parseFollowUpQueueSnapshot = (value: unknown): FollowUpQueueSnapshot => {
  if (!isRecord(value)) throw new Error('Invalid follow-up queue snapshot');
  assertKeys(value, ['scopeToken', 'revision', 'items'], 'snapshot');
  if (typeof value.scopeToken !== 'string' || !SCOPE_TOKEN_PATTERN.test(value.scopeToken)) {
    throw new Error('Invalid follow-up queue scope token');
  }
  return {
    scopeToken: value.scopeToken,
    revision: parseInteger(value.revision, 'snapshot.revision'),
    items: parseItems(value.items),
  };
};

export const parseFollowUpQueueOperation = (value: unknown): FollowUpQueueOperation => {
  if (!isRecord(value)) throw new Error('Invalid follow-up queue operation');
  if (value.type === 'add') {
    assertKeys(value, ['type', 'item'], 'operation');
    const item = parseFollowUpQueueItem(value.item, { allowClaim: false, field: 'operation.item' });
    return { type: 'add', item };
  }
  if (value.type === 'remove') {
    assertKeys(value, ['type', 'itemId'], 'operation');
    return { type: 'remove', itemId: parseIdentifier(value.itemId, 'operation.itemId') };
  }
  if (value.type === 'set-status') {
    assertKeys(value, ['type', 'itemId', 'status'], 'operation');
    return {
      type: 'set-status',
      itemId: parseIdentifier(value.itemId, 'operation.itemId'),
      status: parseStatus(value.status, 'operation.status'),
    };
  }
  if (value.type === 'move') {
    assertKeys(value, ['type', 'itemId', 'beforeId'], 'operation');
    return {
      type: 'move',
      itemId: parseIdentifier(value.itemId, 'operation.itemId'),
      beforeId: value.beforeId === null ? null : parseIdentifier(value.beforeId, 'operation.beforeId'),
    };
  }
  if (value.type === 'claim') {
    assertKeys(value, ['type', 'itemId', 'claimId', 'mode'], 'operation');
    if (value.mode !== 'manual' && value.mode !== 'auto') throw new Error('Invalid follow-up queue operation.mode');
    return {
      type: 'claim',
      itemId: parseIdentifier(value.itemId, 'operation.itemId'),
      claimId: parseIdentifier(value.claimId, 'operation.claimId'),
      mode: value.mode,
    };
  }
  if (value.type === 'complete') {
    assertKeys(value, ['type', 'itemId', 'claimId'], 'operation');
    return {
      type: 'complete',
      itemId: parseIdentifier(value.itemId, 'operation.itemId'),
      claimId: parseIdentifier(value.claimId, 'operation.claimId'),
    };
  }
  if (value.type === 'release') {
    assertKeys(value, ['type', 'itemId', 'claimId', 'status'], 'operation');
    return {
      type: 'release',
      itemId: parseIdentifier(value.itemId, 'operation.itemId'),
      claimId: parseIdentifier(value.claimId, 'operation.claimId'),
      status: parseStatus(value.status, 'operation.status'),
    };
  }
  throw new Error('Invalid follow-up queue operation.type');
};

export const parseFollowUpQueueMutationResult = (value: unknown): FollowUpQueueMutationResult => {
  if (!isRecord(value)) throw new Error('Invalid follow-up queue mutation result');
  assertKeys(value, ['snapshot', 'applied', 'deduplicated', 'mutationRevision'], 'mutation result');
  if (
    typeof value.applied !== 'boolean'
    || typeof value.deduplicated !== 'boolean'
    || (value.mutationRevision !== null && !Number.isSafeInteger(value.mutationRevision))
    || (typeof value.mutationRevision === 'number' && value.mutationRevision < 0)
  ) {
    throw new Error('Invalid follow-up queue mutation result');
  }
  return {
    snapshot: parseFollowUpQueueSnapshot(value.snapshot),
    applied: value.applied,
    deduplicated: value.deduplicated,
    mutationRevision: value.mutationRevision === null ? null : Number(value.mutationRevision),
  };
};

const attachmentsEqual = (left: FollowUpQueueAttachment[] | undefined, right: FollowUpQueueAttachment[] | undefined): boolean => {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((attachment, index) => {
    const other = right[index];
    return attachment.id === other.id
      && attachment.dataUrl === other.dataUrl
      && attachment.mimeType === other.mimeType
      && attachment.filename === other.filename
      && attachment.size === other.size
      && attachment.source === other.source
      && attachment.serverPath === other.serverPath
      && attachment.vscodePath === other.vscodePath
      && attachment.vscodeSource === other.vscodeSource;
  });
};

export const followUpQueueItemsEqual = (left: FollowUpQueueItem, right: FollowUpQueueItem): boolean => (
  left.id === right.id
  && left.messageId === right.messageId
  && left.content === right.content
  && left.createdAt === right.createdAt
  && left.status === right.status
  && left.sendConfig?.providerID === right.sendConfig?.providerID
  && left.sendConfig?.modelID === right.sendConfig?.modelID
  && left.sendConfig?.agent === right.sendConfig?.agent
  && left.sendConfig?.variant === right.sendConfig?.variant
  && left.claim?.id === right.claim?.id
  && left.claim?.expiresAt === right.claim?.expiresAt
  && attachmentsEqual(left.attachments, right.attachments)
);

type FollowUpQueueApplyOptions = {
  now?: number;
  claimExpiresAt?: number;
};

type FollowUpQueueApplyResult = {
  snapshot: FollowUpQueueSnapshot;
  applied: boolean;
};

export const applyFollowUpQueueOperation = (
  snapshot: FollowUpQueueSnapshot,
  operation: FollowUpQueueOperation,
  options: FollowUpQueueApplyOptions = {},
): FollowUpQueueApplyResult => {
  const itemIndex = operation.type === 'add'
    ? -1
    : snapshot.items.findIndex((item) => item.id === operation.itemId);

  if (operation.type === 'add') {
    const matches = snapshot.items.filter(
      (item) => item.id === operation.item.id || item.messageId === operation.item.messageId,
    );
    if (matches.length > 0) {
      if (matches.length === 1 && followUpQueueItemsEqual(matches[0], operation.item)) {
        return { snapshot, applied: false };
      }
      throw new Error('Follow-up queue item identity conflict');
    }
    return {
      snapshot: parseFollowUpQueueSnapshot({
        ...snapshot,
        items: [...snapshot.items, operation.item],
      }),
      applied: true,
    };
  }
  if (itemIndex < 0) return { snapshot, applied: false };

  if (operation.type === 'remove') {
    return {
      snapshot: { ...snapshot, items: snapshot.items.filter((_, index) => index !== itemIndex) },
      applied: true,
    };
  }
  if (operation.type === 'set-status') {
    if (snapshot.items[itemIndex].status === operation.status) return { snapshot, applied: false };
    const items = snapshot.items.slice();
    items[itemIndex] = { ...items[itemIndex], status: operation.status };
    return { snapshot: { ...snapshot, items }, applied: true };
  }
  if (operation.type === 'move') {
    if (operation.itemId === operation.beforeId) return { snapshot, applied: false };
    const items = snapshot.items.slice();
    const [moved] = items.splice(itemIndex, 1);
    const targetIndex = operation.beforeId === null
      ? items.length
      : items.findIndex((item) => item.id === operation.beforeId);
    if (targetIndex < 0) return { snapshot, applied: false };
    items.splice(targetIndex, 0, moved);
    if (items.every((item, index) => item === snapshot.items[index])) return { snapshot, applied: false };
    return { snapshot: { ...snapshot, items }, applied: true };
  }
  if (operation.type === 'claim') {
    const item = snapshot.items[itemIndex];
    if (operation.mode === 'auto' && item.status !== 'queued') return { snapshot, applied: false };
    const now = options.now;
    const expiresAt = options.claimExpiresAt;
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(expiresAt) || Number(expiresAt) < Number(now)) {
      throw new Error('Claim projection requires a valid clock and expiry');
    }
    if (item.claim && item.claim.expiresAt > Number(now) && item.claim.id !== operation.claimId) {
      return { snapshot, applied: false };
    }
    if (item.claim?.id === operation.claimId && item.claim.expiresAt === expiresAt) {
      return { snapshot, applied: false };
    }
    const items = snapshot.items.slice();
    items[itemIndex] = { ...item, claim: { id: operation.claimId, expiresAt: Number(expiresAt) } };
    return { snapshot: { ...snapshot, items }, applied: true };
  }
  if (operation.type === 'complete') {
    if (snapshot.items[itemIndex].claim?.id !== operation.claimId) return { snapshot, applied: false };
    return {
      snapshot: { ...snapshot, items: snapshot.items.filter((_, index) => index !== itemIndex) },
      applied: true,
    };
  }

  const item = snapshot.items[itemIndex];
  if (item.claim?.id !== operation.claimId) return { snapshot, applied: false };
  const { claim: _claim, ...released } = item;
  void _claim;
  const items = snapshot.items.slice();
  items[itemIndex] = { ...released, status: operation.status };
  return { snapshot: { ...snapshot, items }, applied: true };
};
