import type { JsonObject, JsonValue } from '../shared/json-values.js';
import { SidebarStateValidationError } from './errors.js';

export interface SidebarProjectIconImage {
  mime: string;
  updatedAt: number;
  source: 'custom' | 'auto';
}

export interface SidebarProject {
  id: string;
  path: string;
  label?: string;
  icon?: string | null;
  iconImage?: SidebarProjectIconImage | null;
  iconBackground?: string | null;
  color?: string | null;
  defaultModel?: string;
  defaultVariant?: string;
  defaultAgentCombinationId?: string;
  addedAt?: number;
}

export interface SidebarProjectPatch {
  path?: string;
  label?: string | null;
  icon?: string | null;
  iconImage?: SidebarProjectIconImage | null;
  iconBackground?: string | null;
  color?: string | null;
  defaultModel?: string | null;
  defaultVariant?: string | null;
  defaultAgentCombinationId?: string | null;
  addedAt?: number | null;
}

export interface SidebarFolderDefinition {
  id: string;
  name: string;
  createdAt: number;
  parentId: string | null;
}

export interface SidebarFolder extends SidebarFolderDefinition {
  sessionIds: string[];
}

export interface SidebarSnapshot {
  schemaVersion: 1;
  revision: number;
  projects: SidebarProject[];
  pinnedSessionIds: string[];
  worktreeOrderByProject: Record<string, string[]>;
  sessionFoldersByScope: Record<string, SidebarFolder[]>;
}

export interface SidebarMutationRecord {
  clientMutationId: string;
  fingerprint: string;
  revision: number;
}

export interface SidebarStorageEnvelope {
  storageVersion: 1;
  snapshot: SidebarSnapshot;
  recentMutations: SidebarMutationRecord[];
}

export type SidebarOperation =
  | { type: 'project.add'; project: SidebarProject; index?: number }
  | { type: 'project.remove'; projectId: string }
  | { type: 'project.update'; projectId: string; patch: SidebarProjectPatch }
  | { type: 'project.move'; projectId: string; toIndex: number }
  | { type: 'session.pin'; sessionId: string }
  | { type: 'session.unpin'; sessionId: string }
  | { type: 'worktree.move'; projectId: string; path: string; toIndex: number; orderedPaths: string[] }
  | { type: 'worktree.clearOrder'; projectId: string }
  | { type: 'folder.create'; scopeKey: string; folder: SidebarFolderDefinition }
  | { type: 'folder.rename'; scopeKey: string; folderId: string; name: string }
  | { type: 'folder.delete'; scopeKey: string; folderId: string }
  | { type: 'folder.assign'; scopeKey: string; folderId: string; sessionIds: string[] }
  | { type: 'folder.unassign'; scopeKey: string; sessionIds: string[] }
  | { type: 'folder.cleanup'; scopeKey: string; existingSessionIds: string[]; pruneEmpty: boolean };

export interface SidebarMutationRequest {
  baseRevision: number;
  clientMutationId: string;
  operation: SidebarOperation;
}

interface NormalizeIdentifierOptions {
  rejectReserved?: boolean;
  canonical?: boolean;
}

const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
};

interface NormalizePathOptions {
  field?: string;
  canonical?: boolean;
}

interface NormalizeTextOptions {
  nullable?: boolean;
  canonical?: boolean;
}

interface NormalizeFolderOptions {
  field?: string;
  canonical?: boolean;
}

interface NormalizeProjectOptions {
  field?: string;
  canonical?: boolean;
  legacy?: boolean;
}

const SIDEBAR_STATE_SCHEMA_VERSION = 1 as const;
const SIDEBAR_STATE_STORAGE_VERSION = 1 as const;
export const MAX_PERSISTED_MUTATION_DEDUPE = 4096;

const MAX_PROJECTS = 2048;
const MAX_PROJECT_ID_LENGTH = 16_384;
const MAX_SESSION_ID_LENGTH = 512;
const MAX_CLIENT_MUTATION_ID_LENGTH = 256;
const MAX_PATH_LENGTH = 8192;
const MAX_PINNED_SESSIONS = 10_000;
const MAX_WORKTREE_PATHS_PER_PROJECT = 4096;
const MAX_FOLDER_SCOPES = 8192;
const MAX_FOLDERS_PER_SCOPE = 2048;
const MAX_FOLDER_ID_LENGTH = 256;
const MAX_FOLDER_NAME_LENGTH = 256;
const MAX_FOLDER_SESSION_IDS = 10_000;
const MAX_LABEL_LENGTH = 256;
const MAX_ICON_LENGTH = 128;
const MAX_COLOR_LENGTH = 64;
const MAX_MODEL_LENGTH = 512;
const MAX_MIME_LENGTH = 128;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const RESERVED_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ARCHIVED_SCOPE_PREFIX = '__archived__:';
const PROJECT_KEYS = new Set([
  'id',
  'path',
  'label',
  'icon',
  'iconImage',
  'iconBackground',
  'color',
  'defaultModel',
  'defaultVariant',
  'defaultAgentCombinationId',
  'addedAt',
]);
const LEGACY_PROJECT_KEYS = new Set([...PROJECT_KEYS, 'lastOpenedAt', 'sidebarCollapsed']);
const PROJECT_PATCH_KEYS = new Set([
  'path',
  'label',
  'icon',
  'iconImage',
  'iconBackground',
  'color',
  'defaultModel',
  'defaultVariant',
  'defaultAgentCombinationId',
  'addedAt',
]);

const hasOwn = (value: JsonObject, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const isString = (value: unknown): value is string => typeof value === 'string';
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isSafeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);

const isRecord = (value: unknown): value is JsonObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const requireRecord = (value: JsonValue | undefined, field: string): JsonObject => {
  if (!isRecord(value)) {
    throw new SidebarStateValidationError(`${field} must be an object`);
  }
  return value;
};

const requireAllowedKeys = (value: JsonObject, allowed: Set<string>, field: string): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new SidebarStateValidationError(`${field} contains unsupported field ${key}`);
    }
  }
};

const requireArray = (value: JsonValue | undefined, field: string, maximum: number): JsonValue[] => {
  if (!Array.isArray(value)) {
    throw new SidebarStateValidationError(`${field} must be an array`);
  }
  if (value.length > maximum) {
    throw new SidebarStateValidationError(`${field} exceeds its item limit`);
  }
  return value;
};

const normalizeIdentifier = (
  value: JsonValue | undefined,
  field: string,
  maximum: number,
  options: NormalizeIdentifierOptions = {},
): string => {
  if (!isString(value)) {
    throw new SidebarStateValidationError(`${field} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || !IDENTIFIER_PATTERN.test(normalized)) {
    throw new SidebarStateValidationError(`${field} is invalid`);
  }
  if (options.rejectReserved === true && RESERVED_OBJECT_KEYS.has(normalized)) {
    throw new SidebarStateValidationError(`${field} is reserved`);
  }
  if (options.canonical === true && normalized !== value) {
    throw new SidebarStateValidationError(`${field} is not normalized`);
  }
  return normalized;
};

const normalizeProjectId = (
  value: JsonValue | undefined,
  field = 'projectId',
  options: NormalizeIdentifierOptions = {},
): string => normalizeIdentifier(
  value,
  field,
  MAX_PROJECT_ID_LENGTH,
  { ...options, rejectReserved: true },
);

const normalizeSessionId = (
  value: JsonValue | undefined,
  field = 'sessionId',
  options: NormalizeIdentifierOptions = {},
): string => normalizeIdentifier(
  value,
  field,
  MAX_SESSION_ID_LENGTH,
  options,
);

const normalizeClientMutationId = (
  value: JsonValue | undefined,
  options: NormalizeIdentifierOptions = {},
): string => normalizeIdentifier(
  value,
  'clientMutationId',
  MAX_CLIENT_MUTATION_ID_LENGTH,
  options,
);

const normalizePathSegments = (segments: string[], minimumDepth: number, field: string): string[] => {
  const normalized = segments.slice(0, minimumDepth);
  for (let index = minimumDepth; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (normalized.length <= minimumDepth) {
        throw new SidebarStateValidationError(`${field} cannot traverse above its root`);
      }
      normalized.pop();
      continue;
    }
    normalized.push(segment);
  }
  return normalized;
};

export const normalizeSidebarPath = (
  value: JsonValue | undefined,
  options: NormalizePathOptions = {},
): string => {
  const field = options.field || 'path';
  if (!isString(value)) {
    throw new SidebarStateValidationError(`${field} must be a string`);
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_PATH_LENGTH || hasControlCharacter(trimmed)) {
    throw new SidebarStateValidationError(`${field} is invalid`);
  }

  const slashed = trimmed.replace(/\\/g, '/');
  let normalized: string;

  if (/^[A-Za-z]:\//.test(slashed)) {
    const drive = (slashed[0] ?? '').toUpperCase();
    const segments = normalizePathSegments(slashed.slice(3).split('/'), 0, field);
    normalized = segments.length > 0 ? `${drive}:/${segments.join('/')}` : `${drive}:/`;
  } else if (slashed.startsWith('//') && !slashed.startsWith('///')) {
    const components = slashed.slice(2).split('/').filter(Boolean);
    if (
      components.length < 2
      || components[0] === '.'
      || components[0] === '..'
      || components[1] === '.'
      || components[1] === '..'
    ) {
      throw new SidebarStateValidationError(`${field} must include a UNC server and share`);
    }
    const segments = normalizePathSegments(components, 2, field);
    normalized = `//${segments.join('/')}`;
  } else if (slashed.startsWith('/')) {
    const segments = normalizePathSegments(slashed.replace(/^\/+/, '').split('/'), 0, field);
    normalized = segments.length > 0 ? `/${segments.join('/')}` : '/';
  } else {
    throw new SidebarStateValidationError(`${field} must be an absolute path`);
  }

  if (normalized.length > MAX_PATH_LENGTH) {
    throw new SidebarStateValidationError(`${field} exceeds its length limit`);
  }
  if (options.canonical === true && normalized !== value) {
    throw new SidebarStateValidationError(`${field} is not normalized`);
  }
  return normalized;
};

const normalizeSidebarFolderScope = (
  value: JsonValue | undefined,
  options: NormalizePathOptions = {},
): string => {
  const field = options.field || 'scopeKey';
  if (!isString(value)) {
    throw new SidebarStateValidationError(`${field} must be a string`);
  }
  const archived = value.startsWith(ARCHIVED_SCOPE_PREFIX);
  const pathValue = archived ? value.slice(ARCHIVED_SCOPE_PREFIX.length) : value;
  const normalizedPath = normalizeSidebarPath(pathValue, { field, canonical: false });
  const normalized = archived ? `${ARCHIVED_SCOPE_PREFIX}${normalizedPath}` : normalizedPath;
  if (options.canonical === true && normalized !== value) {
    throw new SidebarStateValidationError(`${field} is not normalized`);
  }
  return normalized;
};

const normalizeTextRequired = (
  value: JsonValue | undefined,
  field: string,
  maximum: number,
  canonical = false,
): string => {
  if (!isString(value)) {
    throw new SidebarStateValidationError(`${field} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || hasControlCharacter(normalized)) {
    throw new SidebarStateValidationError(`${field} is invalid`);
  }
  if (canonical && normalized !== value) {
    throw new SidebarStateValidationError(`${field} is not normalized`);
  }
  return normalized;
};

const normalizeTextNullable = (
  value: JsonValue | undefined,
  field: string,
  maximum: number,
  canonical = false,
): string | null => {
  if (value === null) return null;
  if (!isString(value)) {
    throw new SidebarStateValidationError(`${field} must be a string or null`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || hasControlCharacter(normalized)) {
    throw new SidebarStateValidationError(`${field} is invalid`);
  }
  if (canonical && normalized !== value) {
    throw new SidebarStateValidationError(`${field} is not normalized`);
  }
  return normalized;
};

const tryNormalizeLegacyValue = <T>(normalize: () => T): T | undefined => {
  try {
    return normalize();
  } catch (error) {
    if (error instanceof SidebarStateValidationError) return undefined;
    throw error;
  }
};

const normalizeLegacyBoundedText = (
  value: JsonValue | undefined,
  field: string,
  maximum: number,
): string | undefined => {
  if (!isString(value)) return undefined;
  const trimmed = value.trim();
  if (!trimmed || hasControlCharacter(trimmed)) return undefined;
  let bounded = trimmed.slice(0, maximum);
  if (/[\ud800-\udbff]$/.test(bounded)) bounded = bounded.slice(0, -1);
  return tryNormalizeLegacyValue(() => normalizeTextRequired(bounded, field, maximum, false));
};

const normalizeIconBackground = (
  value: JsonValue | undefined,
  field: string,
  options: NormalizeTextOptions = {},
): string | null => {
  if (value === null) return null;
  const normalized = normalizeTextRequired(value, field, 7, options.canonical === true).toLowerCase();
  if (!/^#(?:[\da-f]{3}|[\da-f]{6})$/.test(normalized)) {
    throw new SidebarStateValidationError(`${field} must be a three- or six-digit hex color`);
  }
  if (options.canonical === true && normalized !== value) {
    throw new SidebarStateValidationError(`${field} is not normalized`);
  }
  return normalized;
};

const normalizeTimestampRequired = (
  value: JsonValue | undefined,
  field: string,
  canonical = false,
): number => {
  if (!isFiniteNumber(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new SidebarStateValidationError(`${field} must be a non-negative finite number`);
  }
  const normalized = Math.round(value);
  if (canonical && normalized !== value) {
    throw new SidebarStateValidationError(`${field} is not normalized`);
  }
  return normalized;
};

const normalizeTimestampNullable = (
  value: JsonValue | undefined,
  field: string,
  canonical = false,
): number | null => {
  if (value === null) return null;
  return normalizeTimestampRequired(value, field, canonical);
};

const normalizeFolderId = (
  value: JsonValue | undefined,
  field = 'folderId',
  options: NormalizeIdentifierOptions = {},
): string => normalizeIdentifier(
  value,
  field,
  MAX_FOLDER_ID_LENGTH,
  { ...options, rejectReserved: true },
);

const normalizeFolderSessionIds = (
  value: JsonValue | undefined,
  field: string,
  options: { canonical?: boolean } = {},
): string[] => {
  const input = requireArray(value, field, MAX_FOLDER_SESSION_IDS);
  const result: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < input.length; index += 1) {
    const sessionId = normalizeSessionId(input[index], `${field}[${index}]`, {
      canonical: options.canonical === true,
    });
    if (seen.has(sessionId)) {
      if (options.canonical === true) {
        throw new SidebarStateValidationError(`${field} contains duplicate session ids`);
      }
      continue;
    }
    seen.add(sessionId);
    result.push(sessionId);
  }
  return result;
};

const normalizeFolderDefinition = (
  value: JsonValue | undefined,
  options: NormalizeFolderOptions = {},
): SidebarFolderDefinition => {
  const field = options.field || 'folder';
  const folder = requireRecord(value, field);
  requireAllowedKeys(folder, new Set(['id', 'name', 'createdAt', 'parentId']), field);
  const canonical = options.canonical === true;
  const parentId = folder.parentId === null || folder.parentId === undefined
    ? null
    : normalizeFolderId(folder.parentId, `${field}.parentId`, { canonical });
  return {
    id: normalizeFolderId(folder.id, `${field}.id`, { canonical }),
    name: normalizeTextRequired(folder.name, `${field}.name`, MAX_FOLDER_NAME_LENGTH, canonical),
    createdAt: normalizeTimestampRequired(folder.createdAt, `${field}.createdAt`, canonical),
    parentId,
  };
};

const normalizeFolderWithSessions = (
  value: JsonValue | undefined,
  options: NormalizeFolderOptions = {},
): SidebarFolder => {
  const field = options.field || 'folder';
  const folder = requireRecord(value, field);
  requireAllowedKeys(folder, new Set(['id', 'name', 'createdAt', 'parentId', 'sessionIds']), field);
  const canonical = options.canonical === true;
  const parentId = folder.parentId === null || folder.parentId === undefined
    ? null
    : normalizeFolderId(folder.parentId, `${field}.parentId`, { canonical });
  return {
    id: normalizeFolderId(folder.id, `${field}.id`, { canonical }),
    name: normalizeTextRequired(folder.name, `${field}.name`, MAX_FOLDER_NAME_LENGTH, canonical),
    createdAt: normalizeTimestampRequired(folder.createdAt, `${field}.createdAt`, canonical),
    parentId,
    sessionIds: normalizeFolderSessionIds(folder.sessionIds, `${field}.sessionIds`, { canonical }),
  };
};

const validateFolderHierarchy = (folders: SidebarFolder[], field: string): void => {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  for (const folder of folders) {
    if (folder.parentId && !byId.has(folder.parentId)) {
      throw new SidebarStateValidationError(`${field} references an unknown parent folder`);
    }
    if (folder.parentId === folder.id) {
      throw new SidebarStateValidationError(`${field} contains a folder parent cycle`);
    }
  }

  const complete = new Set<string>();
  const visiting = new Set<string>();
  const visit = (folder: SidebarFolder | undefined): void => {
    if (!folder || complete.has(folder.id)) return;
    if (visiting.has(folder.id)) {
      throw new SidebarStateValidationError(`${field} contains a folder parent cycle`);
    }
    visiting.add(folder.id);
    if (folder.parentId) visit(byId.get(folder.parentId));
    visiting.delete(folder.id);
    complete.add(folder.id);
  };
  folders.forEach(visit);
};

const normalizeSessionFoldersByScope = (
  value: JsonValue | undefined,
  options: NormalizeFolderOptions = {},
): SidebarSnapshot['sessionFoldersByScope'] => {
  const field = options.field || 'sessionFoldersByScope';
  const input = requireRecord(value, field);
  const scopeEntries = Object.entries(input);
  if (scopeEntries.length > MAX_FOLDER_SCOPES) {
    throw new SidebarStateValidationError(`${field} exceeds its scope limit`);
  }

  const result: Record<string, SidebarFolder[]> = {};
  const seenScopes = new Set<string>();
  const seenFolderIds = new Set<string>();
  for (const [rawScopeKey, rawFolders] of scopeEntries) {
    const scopeKey = normalizeSidebarFolderScope(rawScopeKey, {
      field: `${field} scope`,
      canonical: options.canonical === true,
    });
    if (seenScopes.has(scopeKey)) {
      throw new SidebarStateValidationError(`${field} contains duplicate normalized scopes`);
    }
    seenScopes.add(scopeKey);
    const inputFolders = requireArray(rawFolders, `${field}.${scopeKey}`, MAX_FOLDERS_PER_SCOPE);
    if (inputFolders.length === 0) {
      if (options.canonical === true) {
        throw new SidebarStateValidationError(`${field} must omit empty scopes`);
      }
      continue;
    }

    const folders = inputFolders.map((folder, index) => normalizeFolderWithSessions(folder, {
      field: `${field}.${scopeKey}[${index}]`,
      canonical: options.canonical === true,
    }));
    const assignedSessionIds = new Set<string>();
    for (const folder of folders) {
      if (seenFolderIds.has(folder.id)) {
        throw new SidebarStateValidationError(`${field} contains duplicate folder ids`);
      }
      seenFolderIds.add(folder.id);
      for (const sessionId of folder.sessionIds) {
        if (assignedSessionIds.has(sessionId)) {
          throw new SidebarStateValidationError(`${field} assigns a session more than once in one scope`);
        }
        assignedSessionIds.add(sessionId);
      }
    }
    validateFolderHierarchy(folders, `${field}.${scopeKey}`);
    result[scopeKey] = folders;
  }
  return result;
};

const normalizeLegacyFolderSessionIds = (value: JsonValue | undefined, field: string): string[] => {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length && result.length < MAX_FOLDER_SESSION_IDS; index += 1) {
    const sessionId = tryNormalizeLegacyValue(() => normalizeSessionId(value[index], `${field}[${index}]`));
    if (sessionId === undefined || seen.has(sessionId)) continue;
    seen.add(sessionId);
    result.push(sessionId);
  }
  return result;
};

const normalizeLegacyFolder = (value: JsonValue | undefined, field: string): SidebarFolder | null => {
  if (!isRecord(value)) return null;
  const id = tryNormalizeLegacyValue(() => normalizeFolderId(value.id, `${field}.id`));
  const name = normalizeLegacyBoundedText(value.name, `${field}.name`, MAX_FOLDER_NAME_LENGTH);
  if (id === undefined || name === undefined) return null;

  let parentId: string | null = null;
  if (value.parentId !== null && value.parentId !== undefined) {
    const parsedParentId = tryNormalizeLegacyValue(() => normalizeFolderId(value.parentId, `${field}.parentId`));
    if (parsedParentId === undefined) return null;
    parentId = parsedParentId;
  }
  const createdAt = tryNormalizeLegacyValue(() => normalizeTimestampRequired(value.createdAt, `${field}.createdAt`));
  return {
    id,
    name,
    sessionIds: normalizeLegacyFolderSessionIds(value.sessionIds, `${field}.sessionIds`),
    createdAt: createdAt ?? 0,
    parentId,
  };
};

const retainValidFolderHierarchy = (folders: SidebarFolder[]): SidebarFolder[] => {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const validity = new Map<string, boolean>();
  for (const folder of folders) {
    if (validity.has(folder.id)) continue;
    const trail: SidebarFolder[] = [];
    const visiting = new Set<string>();
    let current = folder;
    let valid = false;
    while (true) {
      const known = validity.get(current.id);
      if (known !== undefined) {
        valid = known;
        break;
      }
      if (visiting.has(current.id)) {
        valid = false;
        break;
      }
      visiting.add(current.id);
      trail.push(current);
      if (!current.parentId) {
        valid = true;
        break;
      }
      const parent = byId.get(current.parentId);
      if (!parent) {
        valid = false;
        break;
      }
      current = parent;
    }
    for (const entry of trail) {
      validity.set(entry.id, valid);
    }
  }
  return folders.filter((folder) => validity.get(folder.id) === true);
};

export const normalizeLegacySessionFolders = (value: JsonValue | undefined): Record<string, SidebarFolder[]> => {
  const field = 'legacySessionFoldersByScope';
  const input = requireRecord(value, field);
  const foldersByScope = new Map<string, JsonValue[]>();

  for (const [rawScopeKey, rawFolders] of Object.entries(input)) {
    if (!Array.isArray(rawFolders)) continue;
    const scopeKey = tryNormalizeLegacyValue(() => normalizeSidebarFolderScope(rawScopeKey, {
      field: `${field} scope`,
    }));
    if (scopeKey === undefined) continue;
    const entries = foldersByScope.get(scopeKey) ?? [];
    for (const folder of rawFolders) entries.push(folder);
    foldersByScope.set(scopeKey, entries);
  }

  const result: JsonObject = {};
  let resultScopeCount = 0;
  const seenFolderIds = new Set<string>();
  for (const [scopeKey, rawFolders] of foldersByScope) {
    if (resultScopeCount >= MAX_FOLDER_SCOPES) break;
    const localFolderIds = new Set<string>();
    const candidates: SidebarFolder[] = [];
    for (let index = 0; index < rawFolders.length; index += 1) {
      const folder = normalizeLegacyFolder(rawFolders[index], `${field}.${scopeKey}[${index}]`);
      if (!folder || seenFolderIds.has(folder.id) || localFolderIds.has(folder.id)) continue;
      localFolderIds.add(folder.id);
      candidates.push(folder);
    }

    let folders = retainValidFolderHierarchy(candidates);
    if (folders.length > MAX_FOLDERS_PER_SCOPE) {
      folders = retainValidFolderHierarchy(folders.slice(0, MAX_FOLDERS_PER_SCOPE));
    }
    if (folders.length === 0) continue;

    const assignedSessionIds = new Set<string>();
    folders = folders.map((folder) => ({
      ...folder,
      sessionIds: folder.sessionIds.filter((sessionId) => {
        if (assignedSessionIds.has(sessionId)) return false;
        assignedSessionIds.add(sessionId);
        return true;
      }),
    }));
    result[scopeKey] = folders.map((folder): JsonObject => ({
      id: folder.id,
      name: folder.name,
      createdAt: folder.createdAt,
      parentId: folder.parentId,
      sessionIds: folder.sessionIds,
    }));
    resultScopeCount += 1;
    folders.forEach((folder) => seenFolderIds.add(folder.id));
  }

  return normalizeSessionFoldersByScope(result, { field });
};

const normalizeDefaultModelRequired = (value: JsonValue | undefined, field: string, canonical = false): string => {
  const normalized = normalizeTextRequired(value, field, MAX_MODEL_LENGTH, canonical);
  const separator = normalized.indexOf('/');
  if (separator <= 0 || separator === normalized.length - 1) {
    throw new SidebarStateValidationError(`${field} must contain provider/model`);
  }
  return normalized;
};

const normalizeDefaultModelNullable = (value: JsonValue | undefined, field: string, canonical = false): string | null => {
  if (value === null) return null;
  const normalized = normalizeTextNullable(value, field, MAX_MODEL_LENGTH, canonical);
  if (normalized === null) return null;
  const separator = normalized.indexOf('/');
  if (separator <= 0 || separator === normalized.length - 1) {
    throw new SidebarStateValidationError(`${field} must contain provider/model`);
  }
  return normalized;
};

const normalizeDefaultAgentCombinationIdRequired = (value: JsonValue | undefined, field: string, canonical = false): string => {
  const normalized = normalizeTextRequired(value, field, 36, canonical);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new SidebarStateValidationError(`${field} must be a UUID`);
  }
  return normalized;
};

const normalizeDefaultAgentCombinationIdNullable = (value: JsonValue | undefined, field: string, canonical = false): string | null => {
  if (value === null) return null;
  const normalized = normalizeTextNullable(value, field, 36, canonical);
  if (normalized === null) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new SidebarStateValidationError(`${field} must be a UUID`);
  }
  return normalized;
};

const normalizeIconImage = (
  value: JsonValue | undefined,
  field: string,
  canonical = false,
): SidebarProjectIconImage | null => {
  if (value === null) return null;
  const image = requireRecord(value, field);
  requireAllowedKeys(image, new Set(['mime', 'updatedAt', 'source']), field);
  const source = image.source;
  if (source !== 'custom' && source !== 'auto') {
    throw new SidebarStateValidationError(`${field}.source is invalid`);
  }
  return {
    mime: normalizeTextRequired(image.mime, `${field}.mime`, MAX_MIME_LENGTH, canonical),
    updatedAt: normalizeTimestampRequired(image.updatedAt, `${field}.updatedAt`, canonical),
    source,
  };
};

const normalizeProject = (
  value: JsonValue | undefined,
  options: NormalizeProjectOptions = {},
): SidebarProject => {
  const field = options.field || 'project';
  const project = requireRecord(value, field);
  requireAllowedKeys(project, options.legacy === true ? LEGACY_PROJECT_KEYS : PROJECT_KEYS, field);
  const canonical = options.canonical === true;
  const normalized: SidebarProject = {
    id: normalizeProjectId(project.id, `${field}.id`, { canonical }),
    path: normalizeSidebarPath(project.path, { field: `${field}.path`, canonical }),
  };

  if (hasOwn(project, 'label')) {
    normalized.label = normalizeTextRequired(project.label, `${field}.label`, MAX_LABEL_LENGTH, canonical);
  }
  if (hasOwn(project, 'icon')) {
    normalized.icon = normalizeTextNullable(project.icon, `${field}.icon`, MAX_ICON_LENGTH, canonical);
  }
  if (hasOwn(project, 'iconImage')) {
    normalized.iconImage = normalizeIconImage(project.iconImage, `${field}.iconImage`, canonical);
  }
  if (hasOwn(project, 'iconBackground')) {
    normalized.iconBackground = normalizeIconBackground(project.iconBackground, `${field}.iconBackground`, { canonical });
  }
  if (hasOwn(project, 'color')) {
    normalized.color = normalizeTextNullable(project.color, `${field}.color`, MAX_COLOR_LENGTH, canonical);
  }
  if (hasOwn(project, 'defaultAgentCombinationId')) {
    normalized.defaultAgentCombinationId = normalizeDefaultAgentCombinationIdRequired(
      project.defaultAgentCombinationId,
      `${field}.defaultAgentCombinationId`,
      canonical,
    );
  }
  if (hasOwn(project, 'defaultModel')) {
    normalized.defaultModel = normalizeDefaultModelRequired(project.defaultModel, `${field}.defaultModel`, canonical);
  }
  if (hasOwn(project, 'defaultVariant')) {
    if (!normalized.defaultModel) throw new SidebarStateValidationError(`${field}.defaultVariant requires a default model`);
    normalized.defaultVariant = normalizeTextRequired(project.defaultVariant, `${field}.defaultVariant`, MAX_MODEL_LENGTH, canonical);
  }
  if (hasOwn(project, 'addedAt')) {
    normalized.addedAt = normalizeTimestampRequired(project.addedAt, `${field}.addedAt`, canonical);
  }
  return normalized;
};

const normalizeLegacyProject = (value: JsonValue | undefined, field: string): JsonObject | null => {
  if (!isRecord(value)) return null;
  const id = tryNormalizeLegacyValue(() => normalizeProjectId(value.id, `${field}.id`));
  const projectPath = tryNormalizeLegacyValue(() => normalizeSidebarPath(value.path, { field: `${field}.path` }));
  if (id === undefined || projectPath === undefined) return null;

  const normalized: JsonObject = { id, path: projectPath };
  if (hasOwn(value, 'label')) {
    const label = normalizeLegacyBoundedText(value.label, `${field}.label`, MAX_LABEL_LENGTH);
    if (label !== undefined) normalized.label = label;
  }
  if (hasOwn(value, 'icon')) {
    const icon = tryNormalizeLegacyValue(() => normalizeTextNullable(value.icon, `${field}.icon`, MAX_ICON_LENGTH, false));
    if (icon !== undefined) normalized.icon = icon;
  }
  if (hasOwn(value, 'iconImage')) {
    const iconImage = tryNormalizeLegacyValue(() => normalizeIconImage(value.iconImage, `${field}.iconImage`, false));
    if (iconImage !== undefined) {
      normalized.iconImage = iconImage === null
        ? null
        : { mime: iconImage.mime, updatedAt: iconImage.updatedAt, source: iconImage.source };
    }
  }
  if (hasOwn(value, 'iconBackground')) {
    const iconBackground = tryNormalizeLegacyValue(() => normalizeIconBackground(value.iconBackground, `${field}.iconBackground`));
    if (iconBackground !== undefined) normalized.iconBackground = iconBackground;
  }
  if (hasOwn(value, 'color')) {
    const color = tryNormalizeLegacyValue(() => normalizeTextNullable(value.color, `${field}.color`, MAX_COLOR_LENGTH, false));
    if (color !== undefined) normalized.color = color;
  }
  if (hasOwn(value, 'defaultAgentCombinationId')) {
    const combinationId = tryNormalizeLegacyValue(() => normalizeDefaultAgentCombinationIdRequired(
      value.defaultAgentCombinationId,
      `${field}.defaultAgentCombinationId`,
      false,
    ));
    if (combinationId !== undefined) normalized.defaultAgentCombinationId = combinationId;
  }
  let hasDefaultModel = false;
  if (hasOwn(value, 'defaultModel')) {
    const defaultModel = tryNormalizeLegacyValue(() => normalizeDefaultModelRequired(
      value.defaultModel,
      `${field}.defaultModel`,
      false,
    ));
    if (defaultModel !== undefined) {
      normalized.defaultModel = defaultModel;
      hasDefaultModel = true;
    }
  }
  if (hasDefaultModel && hasOwn(value, 'defaultVariant')) {
    const variant = tryNormalizeLegacyValue(() => normalizeTextRequired(value.defaultVariant, `${field}.defaultVariant`, MAX_MODEL_LENGTH, false));
    if (variant !== undefined) normalized.defaultVariant = variant;
  }
  if (hasOwn(value, 'addedAt')) {
    const addedAt = tryNormalizeLegacyValue(() => normalizeTimestampRequired(value.addedAt, `${field}.addedAt`, false));
    if (addedAt !== undefined) normalized.addedAt = addedAt;
  }
  return normalized;
};

const normalizeProjectList = (
  value: JsonValue | undefined,
  options: NormalizeProjectOptions = {},
): SidebarProject[] => {
  const projects = requireArray(value, options.field || 'projects', MAX_PROJECTS);
  const normalized: SidebarProject[] = [];
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();

  for (let index = 0; index < projects.length; index += 1) {
    const project = normalizeProject(projects[index], {
      ...options,
      field: `${options.field || 'projects'}[${index}]`,
    });
    if (seenIds.has(project.id)) {
      throw new SidebarStateValidationError('projects contains duplicate project ids');
    }
    if (seenPaths.has(project.path)) {
      throw new SidebarStateValidationError('projects contains duplicate normalized paths');
    }
    seenIds.add(project.id);
    seenPaths.add(project.path);
    normalized.push(project);
  }
  return normalized;
};

export const normalizeLegacyProjects = (value: JsonValue | undefined): SidebarProject[] => {
  const field = 'legacyProjects';
  const projects = requireArray(value, field, Number.MAX_SAFE_INTEGER);
  const normalized: JsonObject[] = [];
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();

  for (let index = 0; index < projects.length && normalized.length < MAX_PROJECTS; index += 1) {
    const project = normalizeLegacyProject(projects[index], `${field}[${index}]`);
    if (!project || !isString(project.id) || !isString(project.path)) continue;
    if (seenIds.has(project.id) || seenPaths.has(project.path)) continue;
    seenIds.add(project.id);
    seenPaths.add(project.path);
    normalized.push(project);
  }
  return normalizeProjectList(normalized, { field });
};

const normalizeProjectPatch = (value: JsonValue | undefined): SidebarProjectPatch => {
  const patch = requireRecord(value, 'operation.patch');
  requireAllowedKeys(patch, PROJECT_PATCH_KEYS, 'operation.patch');
  if (Object.keys(patch).length === 0) {
    throw new SidebarStateValidationError('operation.patch must not be empty');
  }

  const normalized: SidebarProjectPatch = {};
  if (hasOwn(patch, 'path')) {
    normalized.path = normalizeSidebarPath(patch.path, { field: 'operation.patch.path' });
  }
  if (hasOwn(patch, 'label')) {
    normalized.label = patch.label === null
      ? null
      : normalizeTextRequired(patch.label, 'operation.patch.label', MAX_LABEL_LENGTH, false);
  }
  if (hasOwn(patch, 'icon')) {
    normalized.icon = normalizeTextNullable(patch.icon, 'operation.patch.icon', MAX_ICON_LENGTH, false);
  }
  if (hasOwn(patch, 'iconImage')) {
    normalized.iconImage = normalizeIconImage(patch.iconImage, 'operation.patch.iconImage', false);
  }
  if (hasOwn(patch, 'iconBackground')) {
    normalized.iconBackground = normalizeIconBackground(patch.iconBackground, 'operation.patch.iconBackground');
  }
  if (hasOwn(patch, 'color')) {
    normalized.color = normalizeTextNullable(patch.color, 'operation.patch.color', MAX_COLOR_LENGTH, false);
  }
  if (hasOwn(patch, 'defaultAgentCombinationId')) {
    normalized.defaultAgentCombinationId = normalizeDefaultAgentCombinationIdNullable(
      patch.defaultAgentCombinationId,
      'operation.patch.defaultAgentCombinationId',
      false,
    );
  }
  if (hasOwn(patch, 'defaultModel')) {
    normalized.defaultModel = normalizeDefaultModelNullable(patch.defaultModel, 'operation.patch.defaultModel', false);
  }
  if (hasOwn(patch, 'defaultVariant')) {
    normalized.defaultVariant = normalizeTextNullable(patch.defaultVariant, 'operation.patch.defaultVariant', MAX_MODEL_LENGTH, false);
  }
  if (hasOwn(patch, 'addedAt')) {
    normalized.addedAt = normalizeTimestampNullable(patch.addedAt, 'operation.patch.addedAt', false);
  }
  return normalized;
};

const normalizeIndex = (value: JsonValue | undefined, field: string): number => {
  if (!isSafeInteger(value) || value < 0) {
    throw new SidebarStateValidationError(`${field} must be a non-negative integer`);
  }
  return value;
};

const normalizeWorktreePaths = (
  value: JsonValue | undefined,
  options: NormalizePathOptions = {},
): string[] => {
  const field = options.field || 'orderedPaths';
  const paths = requireArray(value, field, MAX_WORKTREE_PATHS_PER_PROJECT);
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < paths.length; index += 1) {
    const normalizedPath = normalizeSidebarPath(paths[index], {
      field: `${field}[${index}]`,
      canonical: options.canonical === true,
    });
    if (seen.has(normalizedPath)) {
      if (options.canonical === true) {
        throw new SidebarStateValidationError(`${field} contains duplicate normalized paths`);
      }
      continue;
    }
    seen.add(normalizedPath);
    normalized.push(normalizedPath);
  }
  return normalized;
};

const requireOperationFields = (operation: JsonObject, keys: readonly string[]): void => {
  requireAllowedKeys(operation, new Set(['type', ...keys]), 'operation');
};

const normalizeSidebarOperation = (value: JsonValue | undefined): SidebarOperation => {
  const operation = requireRecord(value, 'operation');
  if (!isString(operation.type)) {
    throw new SidebarStateValidationError('operation.type must be a string');
  }

  switch (operation.type) {
    case 'project.add': {
      requireOperationFields(operation, ['project', 'index']);
      const normalized: Extract<SidebarOperation, { type: 'project.add' }> = {
        type: 'project.add',
        project: normalizeProject(operation.project, { field: 'operation.project' }),
      };
      if (hasOwn(operation, 'index')) {
        normalized.index = normalizeIndex(operation.index, 'operation.index');
      }
      return normalized;
    }
    case 'project.remove':
      requireOperationFields(operation, ['projectId']);
      return {
        type: 'project.remove',
        projectId: normalizeProjectId(operation.projectId),
      };
    case 'project.update':
      requireOperationFields(operation, ['projectId', 'patch']);
      return {
        type: 'project.update',
        projectId: normalizeProjectId(operation.projectId),
        patch: normalizeProjectPatch(operation.patch),
      };
    case 'project.move':
      requireOperationFields(operation, ['projectId', 'toIndex']);
      return {
        type: 'project.move',
        projectId: normalizeProjectId(operation.projectId),
        toIndex: normalizeIndex(operation.toIndex, 'operation.toIndex'),
      };
    case 'session.pin':
      requireOperationFields(operation, ['sessionId']);
      return {
        type: 'session.pin',
        sessionId: normalizeSessionId(operation.sessionId),
      };
    case 'session.unpin':
      requireOperationFields(operation, ['sessionId']);
      return {
        type: 'session.unpin',
        sessionId: normalizeSessionId(operation.sessionId),
      };
    case 'worktree.move': {
      requireOperationFields(operation, ['projectId', 'path', 'toIndex', 'orderedPaths']);
      const normalizedPath = normalizeSidebarPath(operation.path, { field: 'operation.path' });
      const orderedPaths = normalizeWorktreePaths(operation.orderedPaths, { field: 'operation.orderedPaths' });
      const toIndex = normalizeIndex(operation.toIndex, 'operation.toIndex');
      if (orderedPaths.length === 0 || !orderedPaths.includes(normalizedPath)) {
        throw new SidebarStateValidationError('operation.path must be present in operation.orderedPaths');
      }
      if (toIndex >= orderedPaths.length) {
        throw new SidebarStateValidationError('operation.toIndex is outside operation.orderedPaths');
      }
      return {
        type: 'worktree.move',
        projectId: normalizeProjectId(operation.projectId),
        path: normalizedPath,
        toIndex,
        orderedPaths,
      };
    }
    case 'worktree.clearOrder':
      requireOperationFields(operation, ['projectId']);
      return {
        type: 'worktree.clearOrder',
        projectId: normalizeProjectId(operation.projectId),
      };
    case 'folder.create':
      requireOperationFields(operation, ['scopeKey', 'folder']);
      return {
        type: 'folder.create',
        scopeKey: normalizeSidebarFolderScope(operation.scopeKey, { field: 'operation.scopeKey' }),
        folder: normalizeFolderDefinition(operation.folder, { field: 'operation.folder' }),
      };
    case 'folder.rename':
      requireOperationFields(operation, ['scopeKey', 'folderId', 'name']);
      return {
        type: 'folder.rename',
        scopeKey: normalizeSidebarFolderScope(operation.scopeKey, { field: 'operation.scopeKey' }),
        folderId: normalizeFolderId(operation.folderId),
        name: normalizeTextRequired(operation.name, 'operation.name', MAX_FOLDER_NAME_LENGTH, false),
      };
    case 'folder.delete':
      requireOperationFields(operation, ['scopeKey', 'folderId']);
      return {
        type: 'folder.delete',
        scopeKey: normalizeSidebarFolderScope(operation.scopeKey, { field: 'operation.scopeKey' }),
        folderId: normalizeFolderId(operation.folderId),
      };
    case 'folder.assign':
      requireOperationFields(operation, ['scopeKey', 'folderId', 'sessionIds']);
      return {
        type: 'folder.assign',
        scopeKey: normalizeSidebarFolderScope(operation.scopeKey, { field: 'operation.scopeKey' }),
        folderId: normalizeFolderId(operation.folderId),
        sessionIds: normalizeFolderSessionIds(operation.sessionIds, 'operation.sessionIds'),
      };
    case 'folder.unassign':
      requireOperationFields(operation, ['scopeKey', 'sessionIds']);
      return {
        type: 'folder.unassign',
        scopeKey: normalizeSidebarFolderScope(operation.scopeKey, { field: 'operation.scopeKey' }),
        sessionIds: normalizeFolderSessionIds(operation.sessionIds, 'operation.sessionIds'),
      };
    case 'folder.cleanup':
      requireOperationFields(operation, ['scopeKey', 'existingSessionIds', 'pruneEmpty']);
      if (!isBoolean(operation.pruneEmpty)) {
        throw new SidebarStateValidationError('operation.pruneEmpty must be a boolean');
      }
      return {
        type: 'folder.cleanup',
        scopeKey: normalizeSidebarFolderScope(operation.scopeKey, { field: 'operation.scopeKey' }),
        existingSessionIds: normalizeFolderSessionIds(operation.existingSessionIds, 'operation.existingSessionIds'),
        pruneEmpty: operation.pruneEmpty,
      };
    default:
      throw new SidebarStateValidationError('operation.type is unsupported');
  }
};

const normalizeRevision = (value: JsonValue | undefined, field = 'revision'): number => {
  if (!isSafeInteger(value) || value < 0) {
    throw new SidebarStateValidationError(`${field} must be a non-negative integer`);
  }
  return value;
};

export const normalizeMutationRequest = (value: JsonValue | undefined): SidebarMutationRequest => {
  const request = requireRecord(value, 'mutation');
  requireAllowedKeys(request, new Set(['baseRevision', 'clientMutationId', 'operation']), 'mutation');
  return {
    baseRevision: normalizeRevision(request.baseRevision, 'baseRevision'),
    clientMutationId: normalizeClientMutationId(request.clientMutationId),
    operation: normalizeSidebarOperation(request.operation),
  };
};

export const createEmptySidebarSnapshot = (
  projects: SidebarProject[] = [],
  sessionFoldersByScope: Record<string, SidebarFolder[]> = {},
): SidebarSnapshot => ({
  schemaVersion: SIDEBAR_STATE_SCHEMA_VERSION,
  revision: 0,
  projects,
  pinnedSessionIds: [],
  worktreeOrderByProject: {},
  sessionFoldersByScope,
});

const cloneProject = (project: SidebarProject): SidebarProject => {
  const cloned: SidebarProject = { ...project };
  if (project.iconImage) {
    cloned.iconImage = { ...project.iconImage };
  }
  return cloned;
};

export const cloneSidebarSnapshot = (snapshot: SidebarSnapshot): SidebarSnapshot => ({
  schemaVersion: snapshot.schemaVersion,
  revision: snapshot.revision,
  projects: snapshot.projects.map(cloneProject),
  pinnedSessionIds: [...snapshot.pinnedSessionIds],
  worktreeOrderByProject: Object.fromEntries(
    Object.entries(snapshot.worktreeOrderByProject).map(([projectId, paths]) => [projectId, [...paths]]),
  ),
  sessionFoldersByScope: Object.fromEntries(
    Object.entries(snapshot.sessionFoldersByScope).map(([scopeKey, folders]) => [
      scopeKey,
      folders.map((folder) => ({ ...folder, sessionIds: [...folder.sessionIds] })),
    ]),
  ),
});

const normalizeStoredSnapshot = (value: JsonValue | undefined): SidebarSnapshot => {
  const snapshot = requireRecord(value, 'snapshot');
  requireAllowedKeys(
    snapshot,
    new Set(['schemaVersion', 'revision', 'projects', 'pinnedSessionIds', 'worktreeOrderByProject', 'sessionFoldersByScope']),
    'snapshot',
  );
  if (snapshot.schemaVersion !== SIDEBAR_STATE_SCHEMA_VERSION) {
    throw new SidebarStateValidationError('snapshot.schemaVersion is unsupported');
  }

  const projects = normalizeProjectList(snapshot.projects, { canonical: true });
  const revision = normalizeRevision(snapshot.revision, 'snapshot.revision');
  const pinnedInput = requireArray(snapshot.pinnedSessionIds, 'snapshot.pinnedSessionIds', MAX_PINNED_SESSIONS);
  const pinnedSessionIds: string[] = [];
  const seenSessionIds = new Set<string>();
  for (let index = 0; index < pinnedInput.length; index += 1) {
    const sessionId = normalizeSessionId(pinnedInput[index], `snapshot.pinnedSessionIds[${index}]`, { canonical: true });
    if (seenSessionIds.has(sessionId)) {
      throw new SidebarStateValidationError('snapshot.pinnedSessionIds contains duplicates');
    }
    seenSessionIds.add(sessionId);
    pinnedSessionIds.push(sessionId);
  }

  const orderInput = requireRecord(snapshot.worktreeOrderByProject, 'snapshot.worktreeOrderByProject');
  if (Object.keys(orderInput).length > projects.length) {
    throw new SidebarStateValidationError('snapshot.worktreeOrderByProject contains too many projects');
  }
  const projectIds = new Set(projects.map((project) => project.id));
  for (const projectId of Object.keys(orderInput)) {
    const normalizedId = normalizeProjectId(projectId, 'snapshot.worktreeOrderByProject project id', { canonical: true });
    if (!projectIds.has(normalizedId)) {
      throw new SidebarStateValidationError('snapshot.worktreeOrderByProject references an unknown project');
    }
  }

  const worktreeOrderByProject: Record<string, string[]> = {};
  for (const project of projects) {
    if (!hasOwn(orderInput, project.id)) continue;
    const paths = normalizeWorktreePaths(orderInput[project.id], {
      field: `snapshot.worktreeOrderByProject.${project.id}`,
      canonical: true,
    });
    if (paths.length === 0) {
      throw new SidebarStateValidationError('snapshot.worktreeOrderByProject must omit empty orders');
    }
    worktreeOrderByProject[project.id] = paths;
  }

  return {
    schemaVersion: SIDEBAR_STATE_SCHEMA_VERSION,
    revision,
    projects,
    pinnedSessionIds,
    worktreeOrderByProject,
    sessionFoldersByScope: normalizeSessionFoldersByScope(snapshot.sessionFoldersByScope, {
      field: 'snapshot.sessionFoldersByScope',
      canonical: true,
    }),
  };
};

const normalizeStoredMutationRecords = (
  value: JsonValue | undefined,
  snapshotRevision: number,
): SidebarMutationRecord[] => {
  const records = requireArray(value, 'recentMutations', MAX_PERSISTED_MUTATION_DEDUPE);
  const normalized: SidebarMutationRecord[] = [];
  const seenIds = new Set<string>();
  let previousRevision = -1;

  for (let index = 0; index < records.length; index += 1) {
    const field = `recentMutations[${index}]`;
    const record = requireRecord(records[index], field);
    requireAllowedKeys(record, new Set(['clientMutationId', 'fingerprint', 'revision']), field);
    const clientMutationId = normalizeClientMutationId(record.clientMutationId, { canonical: true });
    if (seenIds.has(clientMutationId)) {
      throw new SidebarStateValidationError('recentMutations contains duplicate clientMutationId values');
    }
    if (!isString(record.fingerprint) || !/^[\da-f]{64}$/.test(record.fingerprint)) {
      throw new SidebarStateValidationError(`${field}.fingerprint is invalid`);
    }
    const revision = normalizeRevision(record.revision, `${field}.revision`);
    if (revision > snapshotRevision || revision <= previousRevision) {
      throw new SidebarStateValidationError(`${field}.revision is inconsistent`);
    }
    seenIds.add(clientMutationId);
    previousRevision = revision;
    normalized.push({ clientMutationId, fingerprint: record.fingerprint, revision });
  }
  return normalized;
};

export const normalizeStorageEnvelope = (value: JsonValue | undefined): SidebarStorageEnvelope => {
  const envelope = requireRecord(value, 'sidebar state file');
  requireAllowedKeys(envelope, new Set(['storageVersion', 'snapshot', 'recentMutations']), 'sidebar state file');
  if (envelope.storageVersion !== SIDEBAR_STATE_STORAGE_VERSION) {
    throw new SidebarStateValidationError('storageVersion is unsupported');
  }
  const snapshot = normalizeStoredSnapshot(envelope.snapshot);
  return {
    storageVersion: SIDEBAR_STATE_STORAGE_VERSION,
    snapshot,
    recentMutations: normalizeStoredMutationRecords(envelope.recentMutations, snapshot.revision),
  };
};

export const createStorageEnvelope = (
  snapshot: SidebarSnapshot,
  recentMutations: SidebarMutationRecord[] = [],
): SidebarStorageEnvelope => ({
  storageVersion: SIDEBAR_STATE_STORAGE_VERSION,
  snapshot: cloneSidebarSnapshot(snapshot),
  recentMutations: recentMutations.map((record) => ({ ...record })),
});

const orderWorktreeMap = (
  projects: SidebarProject[],
  orderByProject: Record<string, string[]>,
): SidebarSnapshot['worktreeOrderByProject'] => {
  const result: Record<string, string[]> = {};
  for (const project of projects) {
    const paths = orderByProject[project.id];
    if (Object.hasOwn(orderByProject, project.id) && paths && paths.length > 0) {
      result[project.id] = [...paths];
    }
  }
  return result;
};

const requireProject = (snapshot: SidebarSnapshot, projectId: string, operationType: string): number => {
  const index = snapshot.projects.findIndex((project) => project.id === projectId);
  if (index === -1) {
    throw new SidebarStateValidationError(`${operationType} references an unknown project`);
  }
  return index;
};

const applyProjectPatchFields = (current: SidebarProject, patch: SidebarProjectPatch): SidebarProject => {
  const updated: SidebarProject = { ...current };
  if (Object.hasOwn(patch, 'defaultModel') && patch.defaultModel !== current.defaultModel) {
    delete updated.defaultVariant;
  }
  if (patch.path !== undefined) updated.path = patch.path;
  if (Object.hasOwn(patch, 'label')) {
    if (patch.label === null || patch.label === undefined) delete updated.label;
    else updated.label = patch.label;
  }
  if (Object.hasOwn(patch, 'icon')) {
    if (patch.icon === null || patch.icon === undefined) delete updated.icon;
    else updated.icon = patch.icon;
  }
  if (Object.hasOwn(patch, 'iconImage')) {
    if (patch.iconImage === null || patch.iconImage === undefined) delete updated.iconImage;
    else updated.iconImage = { ...patch.iconImage };
  }
  if (Object.hasOwn(patch, 'iconBackground')) {
    if (patch.iconBackground === null || patch.iconBackground === undefined) delete updated.iconBackground;
    else updated.iconBackground = patch.iconBackground;
  }
  if (Object.hasOwn(patch, 'color')) {
    if (patch.color === null || patch.color === undefined) delete updated.color;
    else updated.color = patch.color;
  }
  if (Object.hasOwn(patch, 'defaultAgentCombinationId')) {
    if (patch.defaultAgentCombinationId === null || patch.defaultAgentCombinationId === undefined) delete updated.defaultAgentCombinationId;
    else updated.defaultAgentCombinationId = patch.defaultAgentCombinationId;
  }
  if (Object.hasOwn(patch, 'defaultModel')) {
    if (patch.defaultModel === null || patch.defaultModel === undefined) delete updated.defaultModel;
    else updated.defaultModel = patch.defaultModel;
  }
  if (Object.hasOwn(patch, 'defaultVariant')) {
    if (patch.defaultVariant === null || patch.defaultVariant === undefined) delete updated.defaultVariant;
    else updated.defaultVariant = patch.defaultVariant;
  }
  if (Object.hasOwn(patch, 'addedAt')) {
    if (patch.addedAt === null || patch.addedAt === undefined) delete updated.addedAt;
    else updated.addedAt = patch.addedAt;
  }
  return updated;
};

export const applySidebarOperation = (snapshot: SidebarSnapshot, operation: SidebarOperation): SidebarSnapshot => {
  const next = cloneSidebarSnapshot(snapshot);

  switch (operation.type) {
    case 'project.add': {
      if (next.projects.length >= MAX_PROJECTS) {
        throw new SidebarStateValidationError('projects exceeds its item limit');
      }
      if (next.projects.some((project) => project.id === operation.project.id)) {
        throw new SidebarStateValidationError('project.add uses an existing project id');
      }
      if (next.projects.some((project) => project.path === operation.project.path)) {
        throw new SidebarStateValidationError('project.add uses an existing normalized path');
      }
      const index = operation.index ?? next.projects.length;
      if (index > next.projects.length) {
        throw new SidebarStateValidationError('project.add index is outside projects');
      }
      next.projects.splice(index, 0, operation.project);
      break;
    }
    case 'project.remove': {
      const index = next.projects.findIndex((project) => project.id === operation.projectId);
      if (index !== -1) {
        next.projects.splice(index, 1);
        delete next.worktreeOrderByProject[operation.projectId];
      }
      break;
    }
    case 'project.update': {
      const index = requireProject(next, operation.projectId, operation.type);
      const current = next.projects[index];
      if (!current) {
        throw new SidebarStateValidationError(`${operation.type} references an unknown project`);
      }
      if (
        operation.patch.path
        && operation.patch.path !== current.path
        && next.projects.some((project) => project.path === operation.patch.path)
      ) {
        throw new SidebarStateValidationError('project.update uses an existing normalized path');
      }
      const updated = applyProjectPatchFields(current, operation.patch);
      if (updated.defaultVariant && !updated.defaultModel) {
        throw new SidebarStateValidationError('project.defaultVariant requires a default model');
      }
      next.projects[index] = updated;
      break;
    }
    case 'project.move': {
      const index = requireProject(next, operation.projectId, operation.type);
      if (operation.toIndex >= next.projects.length) {
        throw new SidebarStateValidationError('project.move toIndex is outside projects');
      }
      const [project] = next.projects.splice(index, 1);
      if (project) {
        next.projects.splice(operation.toIndex, 0, project);
      }
      break;
    }
    case 'session.pin':
      if (!next.pinnedSessionIds.includes(operation.sessionId)) {
        if (next.pinnedSessionIds.length >= MAX_PINNED_SESSIONS) {
          throw new SidebarStateValidationError('pinnedSessionIds exceeds its item limit');
        }
        next.pinnedSessionIds.push(operation.sessionId);
      }
      break;
    case 'session.unpin':
      next.pinnedSessionIds = next.pinnedSessionIds.filter((sessionId) => sessionId !== operation.sessionId);
      break;
    case 'worktree.move': {
      requireProject(next, operation.projectId, operation.type);
      const orderedPaths = [...operation.orderedPaths];
      const currentIndex = orderedPaths.indexOf(operation.path);
      const [worktreePath] = orderedPaths.splice(currentIndex, 1);
      if (worktreePath !== undefined) {
        orderedPaths.splice(operation.toIndex, 0, worktreePath);
      }
      next.worktreeOrderByProject[operation.projectId] = orderedPaths;
      break;
    }
    case 'worktree.clearOrder':
      requireProject(next, operation.projectId, operation.type);
      delete next.worktreeOrderByProject[operation.projectId];
      break;
    case 'folder.create': {
      const currentFolders = next.sessionFoldersByScope[operation.scopeKey] ?? [];
      if (!next.sessionFoldersByScope[operation.scopeKey]
        && Object.keys(next.sessionFoldersByScope).length >= MAX_FOLDER_SCOPES) {
        throw new SidebarStateValidationError('folder.create exceeds the folder scope limit');
      }
      if (currentFolders.length >= MAX_FOLDERS_PER_SCOPE) {
        throw new SidebarStateValidationError('folder.create exceeds the scope folder limit');
      }
      if (Object.values(next.sessionFoldersByScope).some((folders) => (
        folders.some((folder) => folder.id === operation.folder.id)
      ))) {
        throw new SidebarStateValidationError('folder.create uses an existing folder id');
      }
      if (operation.folder.parentId && !currentFolders.some((folder) => folder.id === operation.folder.parentId)) {
        throw new SidebarStateValidationError('folder.create references an unknown parent folder');
      }
      next.sessionFoldersByScope[operation.scopeKey] = [
        ...currentFolders,
        { ...operation.folder, sessionIds: [] },
      ];
      break;
    }
    case 'folder.rename': {
      const currentFolders = next.sessionFoldersByScope[operation.scopeKey] ?? [];
      const index = currentFolders.findIndex((folder) => folder.id === operation.folderId);
      const existing = index === -1 ? undefined : currentFolders[index];
      if (!existing) {
        throw new SidebarStateValidationError('folder.rename references an unknown folder');
      }
      const updated = [...currentFolders];
      updated[index] = { ...existing, name: operation.name };
      next.sessionFoldersByScope[operation.scopeKey] = updated;
      break;
    }
    case 'folder.delete': {
      const currentFolders = next.sessionFoldersByScope[operation.scopeKey] ?? [];
      if (!currentFolders.some((folder) => folder.id === operation.folderId)) break;
      const idsToDelete = new Set([operation.folderId]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const folder of currentFolders) {
          if (folder.parentId && idsToDelete.has(folder.parentId) && !idsToDelete.has(folder.id)) {
            idsToDelete.add(folder.id);
            changed = true;
          }
        }
      }
      const remaining = currentFolders.filter((folder) => !idsToDelete.has(folder.id));
      if (remaining.length > 0) next.sessionFoldersByScope[operation.scopeKey] = remaining;
      else delete next.sessionFoldersByScope[operation.scopeKey];
      break;
    }
    case 'folder.assign': {
      const currentFolders = next.sessionFoldersByScope[operation.scopeKey] ?? [];
      if (!currentFolders.some((folder) => folder.id === operation.folderId)) {
        throw new SidebarStateValidationError('folder.assign references an unknown folder');
      }
      const assigned = new Set(operation.sessionIds);
      const updated = currentFolders.map((folder) => {
        const sessionIds = folder.sessionIds.filter((sessionId) => !assigned.has(sessionId));
        return folder.id === operation.folderId
          ? { ...folder, sessionIds: [...sessionIds, ...operation.sessionIds] }
          : { ...folder, sessionIds };
      });
      if (updated.some((folder) => folder.sessionIds.length > MAX_FOLDER_SESSION_IDS)) {
        throw new SidebarStateValidationError('folder.assign exceeds the folder session limit');
      }
      next.sessionFoldersByScope[operation.scopeKey] = updated;
      break;
    }
    case 'folder.unassign': {
      const currentFolders = next.sessionFoldersByScope[operation.scopeKey] ?? [];
      if (currentFolders.length === 0) break;
      const unassigned = new Set(operation.sessionIds);
      next.sessionFoldersByScope[operation.scopeKey] = currentFolders.map((folder) => ({
        ...folder,
        sessionIds: folder.sessionIds.filter((sessionId) => !unassigned.has(sessionId)),
      }));
      break;
    }
    case 'folder.cleanup': {
      const currentFolders = next.sessionFoldersByScope[operation.scopeKey] ?? [];
      const existing = new Set(operation.existingSessionIds);
      const cleaned = currentFolders
        .map((folder) => ({
          ...folder,
          sessionIds: folder.sessionIds.filter((sessionId) => existing.has(sessionId)),
        }))
        .filter((folder) => !operation.pruneEmpty || folder.sessionIds.length > 0);
      let hierarchyCleaned = cleaned;
      let hierarchyChanged = true;
      while (hierarchyChanged) {
        const survivingIds = new Set(hierarchyCleaned.map((folder) => folder.id));
        const nextFolders = hierarchyCleaned.filter((folder) => !folder.parentId || survivingIds.has(folder.parentId));
        hierarchyChanged = nextFolders.length !== hierarchyCleaned.length;
        hierarchyCleaned = nextFolders;
      }
      if (hierarchyCleaned.length > 0) next.sessionFoldersByScope[operation.scopeKey] = hierarchyCleaned;
      else delete next.sessionFoldersByScope[operation.scopeKey];
      break;
    }
  }

  next.worktreeOrderByProject = orderWorktreeMap(next.projects, next.worktreeOrderByProject);
  return next;
};
