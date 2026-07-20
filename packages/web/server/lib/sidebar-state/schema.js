import { SidebarStateValidationError } from './errors.js';

const SIDEBAR_STATE_SCHEMA_VERSION = 1;
const SIDEBAR_STATE_STORAGE_VERSION = 1;
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
  'addedAt',
]);

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const isRecord = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const requireRecord = (value, field) => {
  if (!isRecord(value)) {
    throw new SidebarStateValidationError(`${field} must be an object`);
  }
  return value;
};

const requireAllowedKeys = (value, allowed, field) => {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new SidebarStateValidationError(`${field} contains unsupported field ${key}`);
    }
  }
};

const requireArray = (value, field, maximum) => {
  if (!Array.isArray(value)) {
    throw new SidebarStateValidationError(`${field} must be an array`);
  }
  if (value.length > maximum) {
    throw new SidebarStateValidationError(`${field} exceeds its item limit`);
  }
  return value;
};

const normalizeIdentifier = (value, field, maximum, options = {}) => {
  if (typeof value !== 'string') {
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

const normalizeProjectId = (value, field = 'projectId', options = {}) => normalizeIdentifier(
  value,
  field,
  MAX_PROJECT_ID_LENGTH,
  { ...options, rejectReserved: true },
);

const normalizeSessionId = (value, field = 'sessionId', options = {}) => normalizeIdentifier(
  value,
  field,
  MAX_SESSION_ID_LENGTH,
  options,
);

const normalizeClientMutationId = (value, options = {}) => normalizeIdentifier(
  value,
  'clientMutationId',
  MAX_CLIENT_MUTATION_ID_LENGTH,
  options,
);

const normalizePathSegments = (segments, minimumDepth, field) => {
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

export const normalizeSidebarPath = (value, options = {}) => {
  const field = options.field || 'path';
  if (typeof value !== 'string') {
    throw new SidebarStateValidationError(`${field} must be a string`);
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_PATH_LENGTH || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new SidebarStateValidationError(`${field} is invalid`);
  }

  const slashed = trimmed.replace(/\\/g, '/');
  let normalized;

  if (/^[A-Za-z]:\//.test(slashed)) {
    const drive = slashed[0].toUpperCase();
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

const normalizeSidebarFolderScope = (value, options = {}) => {
  const field = options.field || 'scopeKey';
  if (typeof value !== 'string') {
    throw new SidebarStateValidationError(`${field} must be a string`);
  }
  const archived = value.startsWith(ARCHIVED_SCOPE_PREFIX);
  const pathValue = archived ? value.slice(ARCHIVED_SCOPE_PREFIX.length) : value;
  const path = normalizeSidebarPath(pathValue, { field, canonical: false });
  const normalized = archived ? `${ARCHIVED_SCOPE_PREFIX}${path}` : path;
  if (options.canonical === true && normalized !== value) {
    throw new SidebarStateValidationError(`${field} is not normalized`);
  }
  return normalized;
};

const normalizeText = (value, field, maximum, options = {}) => {
  if (value === null && options.nullable === true) return null;
  if (typeof value !== 'string') {
    throw new SidebarStateValidationError(`${field} must be a string${options.nullable === true ? ' or null' : ''}`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new SidebarStateValidationError(`${field} is invalid`);
  }
  if (options.canonical === true && normalized !== value) {
    throw new SidebarStateValidationError(`${field} is not normalized`);
  }
  return normalized;
};

const tryNormalizeLegacyValue = (normalize) => {
  try {
    return normalize();
  } catch (error) {
    if (error instanceof SidebarStateValidationError) return undefined;
    throw error;
  }
};

const normalizeLegacyBoundedText = (value, field, maximum, options = {}) => {
  if (value === null && options.nullable === true) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || /[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  let bounded = trimmed.slice(0, maximum);
  if (/[\ud800-\udbff]$/.test(bounded)) bounded = bounded.slice(0, -1);
  return tryNormalizeLegacyValue(() => normalizeText(bounded, field, maximum, options));
};

const normalizeIconBackground = (value, field, options = {}) => {
  if (value === null) return null;
  const normalized = normalizeText(value, field, 7, options).toLowerCase();
  if (!/^#(?:[\da-f]{3}|[\da-f]{6})$/.test(normalized)) {
    throw new SidebarStateValidationError(`${field} must be a three- or six-digit hex color`);
  }
  if (options.canonical === true && normalized !== value) {
    throw new SidebarStateValidationError(`${field} is not normalized`);
  }
  return normalized;
};

const normalizeTimestamp = (value, field, options = {}) => {
  if (value === null && options.nullable === true) return null;
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new SidebarStateValidationError(`${field} must be a non-negative finite number`);
  }
  const normalized = Math.round(value);
  if (options.canonical === true && normalized !== value) {
    throw new SidebarStateValidationError(`${field} is not normalized`);
  }
  return normalized;
};

const normalizeFolderId = (value, field = 'folderId', options = {}) => normalizeIdentifier(
  value,
  field,
  MAX_FOLDER_ID_LENGTH,
  { ...options, rejectReserved: true },
);

const normalizeFolderSessionIds = (value, field, options = {}) => {
  const input = requireArray(value, field, MAX_FOLDER_SESSION_IDS);
  const result = [];
  const seen = new Set();
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

const normalizeFolderDefinition = (value, options = {}) => {
  const field = options.field || 'folder';
  const folder = requireRecord(value, field);
  const includeSessions = options.includeSessions === true;
  requireAllowedKeys(
    folder,
    new Set(['id', 'name', 'createdAt', 'parentId', ...(includeSessions ? ['sessionIds'] : [])]),
    field,
  );
  const canonical = options.canonical === true;
  const parentId = folder.parentId === null || folder.parentId === undefined
    ? null
    : normalizeFolderId(folder.parentId, `${field}.parentId`, { canonical });
  const normalized = {
    id: normalizeFolderId(folder.id, `${field}.id`, { canonical }),
    name: normalizeText(folder.name, `${field}.name`, MAX_FOLDER_NAME_LENGTH, { canonical }),
    createdAt: normalizeTimestamp(folder.createdAt, `${field}.createdAt`, { canonical }),
    parentId,
  };
  if (includeSessions) {
    normalized.sessionIds = normalizeFolderSessionIds(folder.sessionIds, `${field}.sessionIds`, { canonical });
  }
  return normalized;
};

const validateFolderHierarchy = (folders, field) => {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  for (const folder of folders) {
    if (folder.parentId && !byId.has(folder.parentId)) {
      throw new SidebarStateValidationError(`${field} references an unknown parent folder`);
    }
    if (folder.parentId === folder.id) {
      throw new SidebarStateValidationError(`${field} contains a folder parent cycle`);
    }
  }

  const complete = new Set();
  const visiting = new Set();
  const visit = (folder) => {
    if (complete.has(folder.id)) return;
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

const normalizeSessionFoldersByScope = (value, options = {}) => {
  const field = options.field || 'sessionFoldersByScope';
  const input = requireRecord(value, field);
  const scopeEntries = Object.entries(input);
  if (scopeEntries.length > MAX_FOLDER_SCOPES) {
    throw new SidebarStateValidationError(`${field} exceeds its scope limit`);
  }

  const result = {};
  const seenScopes = new Set();
  const seenFolderIds = new Set();
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

    const folders = inputFolders.map((folder, index) => normalizeFolderDefinition(folder, {
      field: `${field}.${scopeKey}[${index}]`,
      includeSessions: true,
      canonical: options.canonical === true,
    }));
    const assignedSessionIds = new Set();
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

const normalizeLegacyFolderSessionIds = (value, field) => {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();
  for (let index = 0; index < value.length && result.length < MAX_FOLDER_SESSION_IDS; index += 1) {
    const sessionId = tryNormalizeLegacyValue(() => normalizeSessionId(value[index], `${field}[${index}]`));
    if (sessionId === undefined || seen.has(sessionId)) continue;
    seen.add(sessionId);
    result.push(sessionId);
  }
  return result;
};

const normalizeLegacyFolder = (value, field) => {
  if (!isRecord(value)) return null;
  const id = tryNormalizeLegacyValue(() => normalizeFolderId(value.id, `${field}.id`));
  const name = normalizeLegacyBoundedText(value.name, `${field}.name`, MAX_FOLDER_NAME_LENGTH);
  if (id === undefined || name === undefined) return null;

  let parentId = null;
  if (value.parentId !== null && value.parentId !== undefined) {
    parentId = tryNormalizeLegacyValue(() => normalizeFolderId(value.parentId, `${field}.parentId`));
    if (parentId === undefined) return null;
  }
  const createdAt = tryNormalizeLegacyValue(() => normalizeTimestamp(value.createdAt, `${field}.createdAt`));
  return {
    id,
    name,
    sessionIds: normalizeLegacyFolderSessionIds(value.sessionIds, `${field}.sessionIds`),
    createdAt: createdAt ?? 0,
    parentId,
  };
};

const retainValidFolderHierarchy = (folders) => {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const validity = new Map();
  for (const folder of folders) {
    if (validity.has(folder.id)) continue;
    const path = [];
    const visiting = new Set();
    let current = folder;
    let valid;
    while (true) {
      if (validity.has(current.id)) {
        valid = validity.get(current.id);
        break;
      }
      if (visiting.has(current.id)) {
        valid = false;
        break;
      }
      visiting.add(current.id);
      path.push(current);
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
    path.forEach((entry) => validity.set(entry.id, valid));
  }
  return folders.filter((folder) => validity.get(folder.id));
};

export const normalizeLegacySessionFolders = (value) => {
  const field = 'legacySessionFoldersByScope';
  const input = requireRecord(value, field);
  const foldersByScope = new Map();

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

  const result = {};
  let resultScopeCount = 0;
  const seenFolderIds = new Set();
  for (const [scopeKey, rawFolders] of foldersByScope) {
    if (resultScopeCount >= MAX_FOLDER_SCOPES) break;
    const localFolderIds = new Set();
    const candidates = [];
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

    const assignedSessionIds = new Set();
    folders = folders.map((folder) => ({
      ...folder,
      sessionIds: folder.sessionIds.filter((sessionId) => {
        if (assignedSessionIds.has(sessionId)) return false;
        assignedSessionIds.add(sessionId);
        return true;
      }),
    }));
    result[scopeKey] = folders;
    resultScopeCount += 1;
    folders.forEach((folder) => seenFolderIds.add(folder.id));
  }

  return normalizeSessionFoldersByScope(result, { field });
};

const normalizeDefaultModel = (value, field, options = {}) => {
  if (value === null && options.nullable === true) return null;
  const normalized = normalizeText(value, field, MAX_MODEL_LENGTH, options);
  const separator = normalized.indexOf('/');
  if (separator <= 0 || separator === normalized.length - 1) {
    throw new SidebarStateValidationError(`${field} must contain provider/model`);
  }
  return normalized;
};

const normalizeIconImage = (value, field, options = {}) => {
  if (value === null) return null;
  const image = requireRecord(value, field);
  requireAllowedKeys(image, new Set(['mime', 'updatedAt', 'source']), field);
  const source = image.source;
  if (source !== 'custom' && source !== 'auto') {
    throw new SidebarStateValidationError(`${field}.source is invalid`);
  }
  return {
    mime: normalizeText(image.mime, `${field}.mime`, MAX_MIME_LENGTH, options),
    updatedAt: normalizeTimestamp(image.updatedAt, `${field}.updatedAt`, options),
    source,
  };
};

const normalizeProject = (value, options = {}) => {
  const field = options.field || 'project';
  const project = requireRecord(value, field);
  requireAllowedKeys(project, options.legacy === true ? LEGACY_PROJECT_KEYS : PROJECT_KEYS, field);
  const canonical = options.canonical === true;
  const normalized = {
    id: normalizeProjectId(project.id, `${field}.id`, { canonical }),
    path: normalizeSidebarPath(project.path, { field: `${field}.path`, canonical }),
  };

  if (hasOwn(project, 'label')) {
    normalized.label = normalizeText(project.label, `${field}.label`, MAX_LABEL_LENGTH, { canonical });
  }
  if (hasOwn(project, 'icon')) {
    normalized.icon = normalizeText(project.icon, `${field}.icon`, MAX_ICON_LENGTH, { canonical, nullable: true });
  }
  if (hasOwn(project, 'iconImage')) {
    normalized.iconImage = normalizeIconImage(project.iconImage, `${field}.iconImage`, { canonical });
  }
  if (hasOwn(project, 'iconBackground')) {
    normalized.iconBackground = normalizeIconBackground(project.iconBackground, `${field}.iconBackground`, { canonical });
  }
  if (hasOwn(project, 'color')) {
    normalized.color = normalizeText(project.color, `${field}.color`, MAX_COLOR_LENGTH, { canonical, nullable: true });
  }
  if (hasOwn(project, 'defaultModel')) {
    normalized.defaultModel = normalizeDefaultModel(project.defaultModel, `${field}.defaultModel`, { canonical });
  }
  if (hasOwn(project, 'addedAt')) {
    normalized.addedAt = normalizeTimestamp(project.addedAt, `${field}.addedAt`, { canonical });
  }
  return normalized;
};

const normalizeLegacyProject = (value, field) => {
  if (!isRecord(value)) return null;
  const id = tryNormalizeLegacyValue(() => normalizeProjectId(value.id, `${field}.id`));
  const path = tryNormalizeLegacyValue(() => normalizeSidebarPath(value.path, { field: `${field}.path` }));
  if (id === undefined || path === undefined) return null;

  const normalized = { id, path };
  if (hasOwn(value, 'label')) {
    const label = normalizeLegacyBoundedText(value.label, `${field}.label`, MAX_LABEL_LENGTH);
    if (label !== undefined) normalized.label = label;
  }
  if (hasOwn(value, 'icon')) {
    const icon = tryNormalizeLegacyValue(() => normalizeText(
      value.icon,
      `${field}.icon`,
      MAX_ICON_LENGTH,
      { nullable: true },
    ));
    if (icon !== undefined) normalized.icon = icon;
  }
  if (hasOwn(value, 'iconImage')) {
    const iconImage = tryNormalizeLegacyValue(() => normalizeIconImage(value.iconImage, `${field}.iconImage`));
    if (iconImage !== undefined) normalized.iconImage = iconImage;
  }
  if (hasOwn(value, 'iconBackground')) {
    const iconBackground = tryNormalizeLegacyValue(() => normalizeIconBackground(
      value.iconBackground,
      `${field}.iconBackground`,
    ));
    if (iconBackground !== undefined) normalized.iconBackground = iconBackground;
  }
  if (hasOwn(value, 'color')) {
    const color = tryNormalizeLegacyValue(() => normalizeText(
      value.color,
      `${field}.color`,
      MAX_COLOR_LENGTH,
      { nullable: true },
    ));
    if (color !== undefined) normalized.color = color;
  }
  if (hasOwn(value, 'defaultModel')) {
    const defaultModel = tryNormalizeLegacyValue(() => normalizeDefaultModel(
      value.defaultModel,
      `${field}.defaultModel`,
    ));
    if (defaultModel !== undefined) normalized.defaultModel = defaultModel;
  }
  if (hasOwn(value, 'addedAt')) {
    const addedAt = tryNormalizeLegacyValue(() => normalizeTimestamp(value.addedAt, `${field}.addedAt`));
    if (addedAt !== undefined) normalized.addedAt = addedAt;
  }
  return normalized;
};

const normalizeProjectList = (value, options = {}) => {
  const projects = requireArray(value, options.field || 'projects', MAX_PROJECTS);
  const normalized = [];
  const seenIds = new Set();
  const seenPaths = new Set();

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

export const normalizeLegacyProjects = (value) => {
  const field = 'legacyProjects';
  const projects = requireArray(value, field, Number.MAX_SAFE_INTEGER);
  const normalized = [];
  const seenIds = new Set();
  const seenPaths = new Set();

  for (let index = 0; index < projects.length && normalized.length < MAX_PROJECTS; index += 1) {
    const project = normalizeLegacyProject(projects[index], `${field}[${index}]`);
    if (!project || seenIds.has(project.id) || seenPaths.has(project.path)) continue;
    seenIds.add(project.id);
    seenPaths.add(project.path);
    normalized.push(project);
  }
  return normalizeProjectList(normalized, { field });
};

const normalizeProjectPatch = (value) => {
  const patch = requireRecord(value, 'operation.patch');
  requireAllowedKeys(patch, PROJECT_PATCH_KEYS, 'operation.patch');
  if (Object.keys(patch).length === 0) {
    throw new SidebarStateValidationError('operation.patch must not be empty');
  }

  const normalized = {};
  if (hasOwn(patch, 'path')) {
    normalized.path = normalizeSidebarPath(patch.path, { field: 'operation.patch.path' });
  }
  if (hasOwn(patch, 'label')) {
    normalized.label = patch.label === null
      ? null
      : normalizeText(patch.label, 'operation.patch.label', MAX_LABEL_LENGTH);
  }
  if (hasOwn(patch, 'icon')) {
    normalized.icon = normalizeText(patch.icon, 'operation.patch.icon', MAX_ICON_LENGTH, { nullable: true });
  }
  if (hasOwn(patch, 'iconImage')) {
    normalized.iconImage = normalizeIconImage(patch.iconImage, 'operation.patch.iconImage');
  }
  if (hasOwn(patch, 'iconBackground')) {
    normalized.iconBackground = normalizeIconBackground(patch.iconBackground, 'operation.patch.iconBackground');
  }
  if (hasOwn(patch, 'color')) {
    normalized.color = normalizeText(patch.color, 'operation.patch.color', MAX_COLOR_LENGTH, { nullable: true });
  }
  if (hasOwn(patch, 'defaultModel')) {
    normalized.defaultModel = normalizeDefaultModel(patch.defaultModel, 'operation.patch.defaultModel', { nullable: true });
  }
  if (hasOwn(patch, 'addedAt')) {
    normalized.addedAt = normalizeTimestamp(patch.addedAt, 'operation.patch.addedAt', { nullable: true });
  }
  return normalized;
};

const normalizeIndex = (value, field) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SidebarStateValidationError(`${field} must be a non-negative integer`);
  }
  return value;
};

const normalizeWorktreePaths = (value, options = {}) => {
  const field = options.field || 'orderedPaths';
  const paths = requireArray(value, field, MAX_WORKTREE_PATHS_PER_PROJECT);
  const normalized = [];
  const seen = new Set();
  for (let index = 0; index < paths.length; index += 1) {
    const path = normalizeSidebarPath(paths[index], {
      field: `${field}[${index}]`,
      canonical: options.canonical === true,
    });
    if (seen.has(path)) {
      if (options.canonical === true) {
        throw new SidebarStateValidationError(`${field} contains duplicate normalized paths`);
      }
      continue;
    }
    seen.add(path);
    normalized.push(path);
  }
  return normalized;
};

const requireOperationShape = (operation, keys) => {
  requireAllowedKeys(operation, new Set(['type', ...keys]), 'operation');
};

const normalizeSidebarOperation = (value) => {
  const operation = requireRecord(value, 'operation');
  if (typeof operation.type !== 'string') {
    throw new SidebarStateValidationError('operation.type must be a string');
  }

  switch (operation.type) {
    case 'project.add': {
      requireOperationShape(operation, ['project', 'index']);
      const normalized = {
        type: operation.type,
        project: normalizeProject(operation.project, { field: 'operation.project' }),
      };
      if (hasOwn(operation, 'index')) {
        normalized.index = normalizeIndex(operation.index, 'operation.index');
      }
      return normalized;
    }
    case 'project.remove':
      requireOperationShape(operation, ['projectId']);
      return {
        type: operation.type,
        projectId: normalizeProjectId(operation.projectId),
      };
    case 'project.update':
      requireOperationShape(operation, ['projectId', 'patch']);
      return {
        type: operation.type,
        projectId: normalizeProjectId(operation.projectId),
        patch: normalizeProjectPatch(operation.patch),
      };
    case 'project.move':
      requireOperationShape(operation, ['projectId', 'toIndex']);
      return {
        type: operation.type,
        projectId: normalizeProjectId(operation.projectId),
        toIndex: normalizeIndex(operation.toIndex, 'operation.toIndex'),
      };
    case 'session.pin':
    case 'session.unpin':
      requireOperationShape(operation, ['sessionId']);
      return {
        type: operation.type,
        sessionId: normalizeSessionId(operation.sessionId),
      };
    case 'worktree.move': {
      requireOperationShape(operation, ['projectId', 'path', 'toIndex', 'orderedPaths']);
      const path = normalizeSidebarPath(operation.path, { field: 'operation.path' });
      const orderedPaths = normalizeWorktreePaths(operation.orderedPaths, { field: 'operation.orderedPaths' });
      const toIndex = normalizeIndex(operation.toIndex, 'operation.toIndex');
      if (orderedPaths.length === 0 || !orderedPaths.includes(path)) {
        throw new SidebarStateValidationError('operation.path must be present in operation.orderedPaths');
      }
      if (toIndex >= orderedPaths.length) {
        throw new SidebarStateValidationError('operation.toIndex is outside operation.orderedPaths');
      }
      return {
        type: operation.type,
        projectId: normalizeProjectId(operation.projectId),
        path,
        toIndex,
        orderedPaths,
      };
    }
    case 'worktree.clearOrder':
      requireOperationShape(operation, ['projectId']);
      return {
        type: operation.type,
        projectId: normalizeProjectId(operation.projectId),
      };
    case 'folder.create':
      requireOperationShape(operation, ['scopeKey', 'folder']);
      return {
        type: operation.type,
        scopeKey: normalizeSidebarFolderScope(operation.scopeKey, { field: 'operation.scopeKey' }),
        folder: normalizeFolderDefinition(operation.folder, { field: 'operation.folder' }),
      };
    case 'folder.rename':
      requireOperationShape(operation, ['scopeKey', 'folderId', 'name']);
      return {
        type: operation.type,
        scopeKey: normalizeSidebarFolderScope(operation.scopeKey, { field: 'operation.scopeKey' }),
        folderId: normalizeFolderId(operation.folderId),
        name: normalizeText(operation.name, 'operation.name', MAX_FOLDER_NAME_LENGTH),
      };
    case 'folder.delete':
      requireOperationShape(operation, ['scopeKey', 'folderId']);
      return {
        type: operation.type,
        scopeKey: normalizeSidebarFolderScope(operation.scopeKey, { field: 'operation.scopeKey' }),
        folderId: normalizeFolderId(operation.folderId),
      };
    case 'folder.assign':
      requireOperationShape(operation, ['scopeKey', 'folderId', 'sessionIds']);
      return {
        type: operation.type,
        scopeKey: normalizeSidebarFolderScope(operation.scopeKey, { field: 'operation.scopeKey' }),
        folderId: normalizeFolderId(operation.folderId),
        sessionIds: normalizeFolderSessionIds(operation.sessionIds, 'operation.sessionIds'),
      };
    case 'folder.unassign':
      requireOperationShape(operation, ['scopeKey', 'sessionIds']);
      return {
        type: operation.type,
        scopeKey: normalizeSidebarFolderScope(operation.scopeKey, { field: 'operation.scopeKey' }),
        sessionIds: normalizeFolderSessionIds(operation.sessionIds, 'operation.sessionIds'),
      };
    case 'folder.cleanup':
      requireOperationShape(operation, ['scopeKey', 'existingSessionIds', 'pruneEmpty']);
      if (typeof operation.pruneEmpty !== 'boolean') {
        throw new SidebarStateValidationError('operation.pruneEmpty must be a boolean');
      }
      return {
        type: operation.type,
        scopeKey: normalizeSidebarFolderScope(operation.scopeKey, { field: 'operation.scopeKey' }),
        existingSessionIds: normalizeFolderSessionIds(operation.existingSessionIds, 'operation.existingSessionIds'),
        pruneEmpty: operation.pruneEmpty,
      };
    default:
      throw new SidebarStateValidationError('operation.type is unsupported');
  }
};

const normalizeRevision = (value, field = 'revision') => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SidebarStateValidationError(`${field} must be a non-negative integer`);
  }
  return value;
};

export const normalizeMutationRequest = (value) => {
  const request = requireRecord(value, 'mutation');
  requireAllowedKeys(request, new Set(['baseRevision', 'clientMutationId', 'operation']), 'mutation');
  return {
    baseRevision: normalizeRevision(request.baseRevision, 'baseRevision'),
    clientMutationId: normalizeClientMutationId(request.clientMutationId),
    operation: normalizeSidebarOperation(request.operation),
  };
};

export const createEmptySidebarSnapshot = (projects = [], sessionFoldersByScope = {}) => ({
  schemaVersion: SIDEBAR_STATE_SCHEMA_VERSION,
  revision: 0,
  projects,
  pinnedSessionIds: [],
  worktreeOrderByProject: {},
  sessionFoldersByScope,
});

export const cloneSidebarSnapshot = (snapshot) => ({
  schemaVersion: snapshot.schemaVersion,
  revision: snapshot.revision,
  projects: snapshot.projects.map((project) => ({
    ...project,
    ...(project.iconImage && typeof project.iconImage === 'object'
      ? { iconImage: { ...project.iconImage } }
      : {}),
  })),
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

const normalizeStoredSnapshot = (value) => {
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
  const pinnedSessionIds = [];
  const seenSessionIds = new Set();
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

  const worktreeOrderByProject = {};
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

const normalizeStoredMutationRecords = (value, snapshotRevision) => {
  const records = requireArray(value, 'recentMutations', MAX_PERSISTED_MUTATION_DEDUPE);
  const normalized = [];
  const seenIds = new Set();
  let previousRevision = -1;

  for (let index = 0; index < records.length; index += 1) {
    const field = `recentMutations[${index}]`;
    const record = requireRecord(records[index], field);
    requireAllowedKeys(record, new Set(['clientMutationId', 'fingerprint', 'revision']), field);
    const clientMutationId = normalizeClientMutationId(record.clientMutationId, { canonical: true });
    if (seenIds.has(clientMutationId)) {
      throw new SidebarStateValidationError('recentMutations contains duplicate clientMutationId values');
    }
    if (typeof record.fingerprint !== 'string' || !/^[\da-f]{64}$/.test(record.fingerprint)) {
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

export const normalizeStorageEnvelope = (value) => {
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

export const createStorageEnvelope = (snapshot, recentMutations = []) => ({
  storageVersion: SIDEBAR_STATE_STORAGE_VERSION,
  snapshot: cloneSidebarSnapshot(snapshot),
  recentMutations: recentMutations.map((record) => ({ ...record })),
});

const orderWorktreeMap = (projects, orderByProject) => {
  const result = {};
  for (const project of projects) {
    if (hasOwn(orderByProject, project.id) && orderByProject[project.id].length > 0) {
      result[project.id] = [...orderByProject[project.id]];
    }
  }
  return result;
};

const requireProject = (snapshot, projectId, operationType) => {
  const index = snapshot.projects.findIndex((project) => project.id === projectId);
  if (index === -1) {
    throw new SidebarStateValidationError(`${operationType} references an unknown project`);
  }
  return index;
};

export const applySidebarOperation = (snapshot, operation) => {
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
      if (
        operation.patch.path
        && operation.patch.path !== current.path
        && next.projects.some((project) => project.path === operation.patch.path)
      ) {
        throw new SidebarStateValidationError('project.update uses an existing normalized path');
      }
      const updated = { ...current };
      for (const [key, value] of Object.entries(operation.patch)) {
        if (value === null) {
          delete updated[key];
        } else {
          updated[key] = value;
        }
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
      next.projects.splice(operation.toIndex, 0, project);
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
      orderedPaths.splice(operation.toIndex, 0, worktreePath);
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
      if (index === -1) {
        throw new SidebarStateValidationError('folder.rename references an unknown folder');
      }
      const updated = [...currentFolders];
      updated[index] = { ...updated[index], name: operation.name };
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
    default:
      throw new SidebarStateValidationError('operation.type is unsupported');
  }

  next.worktreeOrderByProject = orderWorktreeMap(next.projects, next.worktreeOrderByProject);
  return next;
};
