import { randomUUID } from 'node:crypto';

import {
  SidebarStateConflictError,
  SidebarStateCorruptError,
  SidebarStateLegacyWriteError,
  SidebarStateNotInitializedError,
  SidebarStateValidationError,
} from './errors.js';
import { createSidebarStateRuntime } from './runtime.js';

const MAX_LEGACY_FOLDERS_FILE_BYTES = 16 * 1024 * 1024;
const MAX_SERVER_MUTATION_CONFLICT_RETRIES = 8;

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const readLegacyFoldersStrict = async (fsPromises, filePath) => {
  let raw;
  try {
    raw = await fsPromises.readFile(filePath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return {};
    throw error;
  }
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_LEGACY_FOLDERS_FILE_BYTES) {
    throw new SidebarStateCorruptError();
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new SidebarStateCorruptError({ cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SidebarStateCorruptError();
  }
  if (!hasOwn(parsed, 'foldersMap')) return {};
  if (!parsed.foldersMap || typeof parsed.foldersMap !== 'object' || Array.isArray(parsed.foldersMap)) {
    throw new SidebarStateCorruptError();
  }
  return parsed.foldersMap;
};

export const createSidebarStateServerRuntime = (dependencies) => {
  const {
    fsPromises,
    path,
    filePath,
    legacyFoldersFilePath,
    readSettingsFromDiskMigratedStrict,
    broadcastGlobalUiEvent,
  } = dependencies;
  if (typeof readSettingsFromDiskMigratedStrict !== 'function') {
    throw new SidebarStateValidationError('readSettingsFromDiskMigratedStrict is required');
  }
  if (typeof broadcastGlobalUiEvent !== 'function') {
    throw new SidebarStateValidationError('broadcastGlobalUiEvent is required');
  }

  const repository = createSidebarStateRuntime({ fsPromises, path, filePath });
  let initializationPromise = null;

  const initialize = () => {
    if (initializationPromise) return initializationPromise;
    initializationPromise = (async () => {
      try {
        return await repository.readSnapshot();
      } catch (error) {
        if (!(error instanceof SidebarStateNotInitializedError)) throw error;
      }

      const settings = await readSettingsFromDiskMigratedStrict();
      const legacySessionFoldersByScope = legacyFoldersFilePath
        ? await readLegacyFoldersStrict(fsPromises, legacyFoldersFilePath)
        : {};
      return repository.initialize({
        legacyProjects: settings.projects ?? [],
        legacySessionFoldersByScope,
      });
    })();
    initializationPromise.catch(() => {
      initializationPromise = null;
    });
    return initializationPromise;
  };

  const readSnapshot = async () => {
    await initialize();
    return repository.readSnapshot();
  };

  const applyMutation = async (mutation) => {
    await initialize();
    const result = await repository.applyMutation(mutation);
    if (result.applied) {
      broadcastGlobalUiEvent({
        type: 'openchamber:sidebar-state.changed',
        properties: { revision: result.snapshot.revision },
      });
    }
    return result;
  };

  const applyOperation = async (operation, options = {}) => {
    const clientMutationId = options.clientMutationId ?? `server-${randomUUID()}`;
    for (let attempt = 0; attempt < MAX_SERVER_MUTATION_CONFLICT_RETRIES; attempt += 1) {
      const snapshot = await readSnapshot();
      try {
        return await applyMutation({
          baseRevision: snapshot.revision,
          clientMutationId,
          operation,
        });
      } catch (error) {
        if (!(error instanceof SidebarStateConflictError)) throw error;
      }
    }
    throw new SidebarStateConflictError(-1, await readSnapshot());
  };

  const projectSettingsProjection = async (settings) => {
    const snapshot = await readSnapshot();
    const current = settings && typeof settings === 'object' ? settings : {};
    const projectIds = new Set(snapshot.projects.map((project) => project.id));
    const currentActiveProjectId = typeof current.activeProjectId === 'string'
      ? current.activeProjectId.trim()
      : '';
    const activeProjectId = projectIds.has(currentActiveProjectId)
      ? currentActiveProjectId
      : snapshot.projects[0]?.id;
    const projected = {
      ...current,
      projects: snapshot.projects,
    };
    if (activeProjectId) projected.activeProjectId = activeProjectId;
    else delete projected.activeProjectId;
    return projected;
  };

  const assertSettingsWriteAllowed = (changes) => {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return;
    if (
      hasOwn(changes, 'projects')
      || hasOwn(changes, 'activeProjectId')
      || hasOwn(changes, 'sidebarCollapsed')
    ) {
      throw new SidebarStateLegacyWriteError();
    }
  };

  return {
    initialize,
    readSnapshot,
    applyMutation,
    applyOperation,
    projectSettingsProjection,
    assertSettingsWriteAllowed,
  };
};
