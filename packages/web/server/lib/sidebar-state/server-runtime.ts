import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { JsonObject, JsonValue } from '../shared/json-values.js';
import type { SettingsDocument } from '../settings/settings-helpers.js';

import {
  SidebarStateConflictError,
  SidebarStateCorruptError,
  SidebarStateLegacyWriteError,
  SidebarStateNotInitializedError,
  SidebarStateValidationError,
} from './errors.js';
import { createSidebarStateRuntime } from './runtime.js';
import type { SidebarMutationResult, SidebarStateFsPromises, SidebarStatePath } from './runtime.js';
import type { SidebarSnapshot } from './schema.js';

const MAX_LEGACY_FOLDERS_FILE_BYTES = 16 * 1024 * 1024;
const MAX_SERVER_MUTATION_CONFLICT_RETRIES = 8;

const operationInputSchema = z.looseObject({ type: z.string() });
export type SidebarOperationInput = z.infer<typeof operationInputSchema>;

export interface SidebarStateChangedEvent {
  type: 'openchamber:sidebar-state.changed';
  properties: {
    revision: number;
  };
}

export interface SidebarStateServerRuntimeOptions {
  fsPromises: SidebarStateFsPromises;
  path: SidebarStatePath;
  filePath: string;
  legacyFoldersFilePath?: string | null | undefined;
  readSettingsFromDiskMigratedStrict: () => Promise<SettingsDocument>;
  broadcastGlobalUiEvent: (event: SidebarStateChangedEvent) => void;
}

const hasOwn = (value: JsonObject, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const isString = (value: unknown): value is string => typeof value === 'string';
const isCallable = (value: unknown): value is CallableFunction => typeof value === 'function';
const isJsonRecord = (value: unknown): value is JsonObject => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const isMissingFileError = (error: unknown): error is { code: 'ENOENT' } => (
  Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
);
const isErrorCause = (value: unknown): value is Error | string | number | boolean | null | object => value !== undefined;

const toJsonValue = (value: SettingsDocument[string] | SidebarOperationInput): JsonValue => (
  JSON.parse(JSON.stringify(value ?? null))
);

const readLegacyFoldersStrict = async (
  fsPromises: SidebarStateFsPromises,
  filePath: string,
): Promise<JsonObject> => {
  let raw: string;
  try {
    raw = await fsPromises.readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) return {};
    throw error;
  }
  if (!isString(raw) || Buffer.byteLength(raw, 'utf8') > MAX_LEGACY_FOLDERS_FILE_BYTES) {
    throw new SidebarStateCorruptError();
  }

  let parsed: JsonValue;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new SidebarStateCorruptError(isErrorCause(error) ? { cause: error } : {});
  }
  if (!isJsonRecord(parsed)) {
    throw new SidebarStateCorruptError();
  }
  if (!hasOwn(parsed, 'foldersMap')) return {};
  if (!isJsonRecord(parsed.foldersMap)) {
    throw new SidebarStateCorruptError();
  }
  return parsed.foldersMap;
};

export const createSidebarStateServerRuntime = (dependencies: SidebarStateServerRuntimeOptions) => {
  const {
    fsPromises,
    path,
    filePath,
    legacyFoldersFilePath,
    readSettingsFromDiskMigratedStrict,
    broadcastGlobalUiEvent,
  } = dependencies;
  if (!isCallable(readSettingsFromDiskMigratedStrict)) {
    throw new SidebarStateValidationError('readSettingsFromDiskMigratedStrict is required');
  }
  if (!isCallable(broadcastGlobalUiEvent)) {
    throw new SidebarStateValidationError('broadcastGlobalUiEvent is required');
  }

  const repository = createSidebarStateRuntime({ fsPromises, path, filePath });
  let initializationPromise: Promise<SidebarSnapshot> | null = null;

  const initialize = (): Promise<SidebarSnapshot> => {
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
        legacyProjects: settings.projects === undefined ? [] : toJsonValue(settings.projects),
        legacySessionFoldersByScope,
      });
    })();
    initializationPromise.catch(() => {
      initializationPromise = null;
    });
    return initializationPromise;
  };

  const readSnapshot = async (): Promise<SidebarSnapshot> => {
    await initialize();
    return repository.readSnapshot();
  };

  const applyMutation = async (mutation: JsonValue | undefined): Promise<SidebarMutationResult> => {
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

  const applyOperation = async (
    operation: SidebarOperationInput,
    options: { clientMutationId?: string } = {},
  ): Promise<SidebarMutationResult> => {
    const clientMutationId = options.clientMutationId ?? `server-${randomUUID()}`;
    const serializedOperation = toJsonValue(operation);
    for (let attempt = 0; attempt < MAX_SERVER_MUTATION_CONFLICT_RETRIES; attempt += 1) {
      const snapshot = await readSnapshot();
      try {
        return await applyMutation({
          baseRevision: snapshot.revision,
          clientMutationId,
          operation: serializedOperation,
        });
      } catch (error) {
        if (!(error instanceof SidebarStateConflictError)) throw error;
      }
    }
    throw new SidebarStateConflictError(-1, await readSnapshot());
  };

  const projectSettingsProjection = async (settings: SettingsDocument | null | undefined): Promise<SettingsDocument> => {
    const snapshot = await readSnapshot();
    const current: SettingsDocument = settings && !Array.isArray(settings) ? settings : {};
    const projectIds = new Set(snapshot.projects.map((project) => project.id));
    const currentActiveProjectId = isString(current.activeProjectId)
      ? current.activeProjectId.trim()
      : '';
    const activeProjectId = projectIds.has(currentActiveProjectId)
      ? currentActiveProjectId
      : snapshot.projects[0]?.id;
    const projected: SettingsDocument = {
      ...current,
      projects: snapshot.projects,
    };
    if (activeProjectId) projected.activeProjectId = activeProjectId;
    else delete projected.activeProjectId;
    return projected;
  };

  const assertSettingsWriteAllowed = (changes: SettingsDocument | null | undefined): void => {
    if (!changes || Array.isArray(changes)) return;
    if (
      Object.hasOwn(changes, 'projects')
      || Object.hasOwn(changes, 'activeProjectId')
      || Object.hasOwn(changes, 'sidebarCollapsed')
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

export type SidebarStateServerRuntime = ReturnType<typeof createSidebarStateServerRuntime>;
