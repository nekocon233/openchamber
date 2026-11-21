import { createHash, randomUUID } from 'node:crypto';
import type fsPromisesModule from 'node:fs/promises';
import type pathModule from 'node:path';
import type { JsonObject, JsonValue } from '../shared/json-values.js';

import {
  SidebarStateConflictError,
  SidebarStateCorruptError,
  SidebarStateIdempotencyError,
  SidebarStateNotInitializedError,
  SidebarStateValidationError,
  SidebarStateWriteError,
} from './errors.js';
import {
  MAX_PERSISTED_MUTATION_DEDUPE,
  applySidebarOperation,
  cloneSidebarSnapshot,
  createEmptySidebarSnapshot,
  createStorageEnvelope,
  normalizeLegacyProjects,
  normalizeLegacySessionFolders,
  normalizeMutationRequest,
  normalizeStorageEnvelope,
} from './schema.js';
import type { SidebarOperation, SidebarSnapshot, SidebarStorageEnvelope } from './schema.js';

export type SidebarStateFsPromises = Pick<
  typeof fsPromisesModule,
  'readFile' | 'writeFile' | 'mkdir' | 'rename' | 'unlink'
>;

export type SidebarStatePath = Pick<typeof pathModule, 'dirname'> & Partial<Pick<typeof pathModule, 'isAbsolute'>>;

export interface SidebarStateRuntimeOptions {
  fsPromises: SidebarStateFsPromises;
  path: SidebarStatePath;
  filePath: string;
  dedupeLimit?: number;
  createTempId?: () => string;
  hashMutation?: (serializedOperation: string) => string;
}

export interface SidebarStateInitializeInput {
  legacyProjects?: JsonValue | undefined;
  legacySessionFoldersByScope?: JsonValue | undefined;
}

export interface SidebarMutationResult {
  snapshot: SidebarSnapshot;
  applied: boolean;
  deduplicated: boolean;
  mutationRevision: number;
}

const DEFAULT_MUTATION_DEDUPE_LIMIT = 256;
const MAX_STATE_FILE_BYTES = 16 * 1024 * 1024;

const isString = (value: unknown): value is string => typeof value === 'string';
const isCallable = (value: unknown): value is CallableFunction => typeof value === 'function';
const isSafeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
const isRuntimeOptions = (value: unknown): value is Partial<SidebarStateRuntimeOptions> => Boolean(value && typeof value === 'object');
const isJsonRecord = (value: unknown): value is JsonObject => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const isMissingFileError = (error: unknown): error is { code: 'ENOENT' } => (
  Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
);
const isErrorCause = (value: unknown): value is Error | string | number | boolean | null | object => value !== undefined;

const stableStringify = (value: JsonValue | undefined): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (isJsonRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

const defaultHashMutation = (serializedOperation: string): string => createHash('sha256')
  .update(serializedOperation)
  .digest('hex');

const requireDependency = <T>(value: T | undefined, name: string): T => {
  if (!value) {
    throw new SidebarStateValidationError(`${name} is required`);
  }
  return value;
};

export const createSidebarStateRuntime = (dependencies: SidebarStateRuntimeOptions) => {
  const options: Partial<SidebarStateRuntimeOptions> = isRuntimeOptions(dependencies) ? dependencies : {};
  const fsPromises = requireDependency(options.fsPromises, 'fsPromises');
  const path = requireDependency(options.path, 'path');
  const filePath = isString(options.filePath) ? options.filePath.trim() : '';
  const dedupeLimit = options.dedupeLimit ?? DEFAULT_MUTATION_DEDUPE_LIMIT;
  const createTempId = options.createTempId ?? randomUUID;
  const hashMutation = options.hashMutation ?? defaultHashMutation;

  const requiredFsMethods: readonly (keyof SidebarStateFsPromises)[] = [
    'readFile', 'writeFile', 'mkdir', 'rename', 'unlink',
  ];
  for (const method of requiredFsMethods) {
    if (!isCallable(fsPromises[method])) {
      throw new SidebarStateValidationError(`fsPromises.${method} is required`);
    }
  }
  if (!isCallable(path.dirname)) {
    throw new SidebarStateValidationError('path.dirname is required');
  }
  if (!filePath || filePath.includes('\u0000')) {
    throw new SidebarStateValidationError('filePath is invalid');
  }
  if (isCallable(path.isAbsolute) && !path.isAbsolute(filePath)) {
    throw new SidebarStateValidationError('filePath must be absolute');
  }
  if (!isSafeInteger(dedupeLimit) || dedupeLimit < 1 || dedupeLimit > MAX_PERSISTED_MUTATION_DEDUPE) {
    throw new SidebarStateValidationError('dedupeLimit is invalid');
  }
  if (!isCallable(createTempId) || !isCallable(hashMutation)) {
    throw new SidebarStateValidationError('createTempId and hashMutation must be functions');
  }

  let queueTail: Promise<void> = Promise.resolve();
  let tempSequence = 0;

  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const result = queueTail.then(task, task);
    queueTail = result.then(() => undefined, () => undefined);
    return result;
  };

  const readEnvelope = async (): Promise<SidebarStorageEnvelope> => {
    let raw: string;
    try {
      raw = await fsPromises.readFile(filePath, 'utf8');
    } catch (error) {
      if (isMissingFileError(error)) {
        throw new SidebarStateNotInitializedError();
      }
      throw error;
    }
    if (!isString(raw) || Buffer.byteLength(raw, 'utf8') > MAX_STATE_FILE_BYTES) {
      throw new SidebarStateCorruptError();
    }

    let parsed: JsonValue;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new SidebarStateCorruptError(isErrorCause(error) ? { cause: error } : {});
    }

    try {
      return normalizeStorageEnvelope(parsed);
    } catch (error) {
      if (error instanceof SidebarStateValidationError) {
        throw new SidebarStateCorruptError({ cause: error });
      }
      throw error;
    }
  };

  const nextTemporaryPath = (): string => {
    tempSequence += 1;
    const randomPart = String(createTempId());
    if (!/^[A-Za-z0-9_-]+$/.test(randomPart)) {
      throw new SidebarStateValidationError('createTempId returned an invalid value');
    }
    return `${filePath}.tmp-${process.pid}-${tempSequence}-${randomPart}`;
  };

  const writeEnvelope = async (envelope: SidebarStorageEnvelope): Promise<void> => {
    const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_STATE_FILE_BYTES) {
      throw new SidebarStateValidationError('sidebar state exceeds its storage limit');
    }
    let temporaryPath: string | undefined;
    let renamed = false;
    try {
      await fsPromises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      temporaryPath = nextTemporaryPath();
      await fsPromises.writeFile(temporaryPath, serialized, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      await fsPromises.rename(temporaryPath, filePath);
      renamed = true;
    } catch (error) {
      if (temporaryPath && !renamed) {
        await fsPromises.unlink(temporaryPath).catch(() => undefined);
      }
      throw new SidebarStateWriteError(isErrorCause(error) ? { cause: error } : {});
    }
  };

  const fingerprintOperation = (operation: SidebarOperation): string => {
    const operationJson: JsonValue = JSON.parse(JSON.stringify(operation));
    const fingerprint = hashMutation(stableStringify(operationJson));
    if (!isString(fingerprint) || !/^[\da-f]{64}$/.test(fingerprint)) {
      throw new SidebarStateValidationError('hashMutation returned an invalid fingerprint');
    }
    return fingerprint;
  };

  const initialize = (input: SidebarStateInitializeInput | JsonValue = {}): Promise<SidebarSnapshot> => enqueue(async () => {
    try {
      const envelope = await readEnvelope();
      return cloneSidebarSnapshot(envelope.snapshot);
    } catch (error) {
      if (!(error instanceof SidebarStateNotInitializedError)) {
        throw error;
      }
    }

    if (!isJsonRecord(input)) {
      throw new SidebarStateValidationError('initializer input must be an object');
    }
    for (const key of Object.keys(input)) {
      if (key !== 'legacyProjects' && key !== 'legacySessionFoldersByScope') {
        throw new SidebarStateValidationError(`initializer input contains unsupported field ${key}`);
      }
    }
    const projects = normalizeLegacyProjects(input.legacyProjects ?? []);
    const sessionFoldersByScope = normalizeLegacySessionFolders(input.legacySessionFoldersByScope ?? {});
    const snapshot = createEmptySidebarSnapshot(projects, sessionFoldersByScope);
    await writeEnvelope(createStorageEnvelope(snapshot));
    return cloneSidebarSnapshot(snapshot);
  });

  const readSnapshot = (): Promise<SidebarSnapshot> => enqueue(async () => {
    const envelope = await readEnvelope();
    return cloneSidebarSnapshot(envelope.snapshot);
  });

  const applyMutation = (input: JsonValue | undefined): Promise<SidebarMutationResult> => enqueue(async () => {
    const mutation = normalizeMutationRequest(input);
    const fingerprint = fingerprintOperation(mutation.operation);
    const envelope = await readEnvelope();
    const existingMutation = envelope.recentMutations.find(
      (record) => record.clientMutationId === mutation.clientMutationId,
    );

    if (existingMutation) {
      if (existingMutation.fingerprint !== fingerprint) {
        throw new SidebarStateIdempotencyError();
      }
      return {
        snapshot: cloneSidebarSnapshot(envelope.snapshot),
        applied: false,
        deduplicated: true,
        mutationRevision: existingMutation.revision,
      };
    }

    if (mutation.baseRevision !== envelope.snapshot.revision) {
      throw new SidebarStateConflictError(
        mutation.baseRevision,
        cloneSidebarSnapshot(envelope.snapshot),
      );
    }
    if (envelope.snapshot.revision === Number.MAX_SAFE_INTEGER) {
      throw new SidebarStateValidationError('snapshot revision cannot be incremented');
    }

    const nextSnapshot = applySidebarOperation(envelope.snapshot, mutation.operation);
    nextSnapshot.revision = envelope.snapshot.revision + 1;
    const recentMutations = [
      ...envelope.recentMutations,
      {
        clientMutationId: mutation.clientMutationId,
        fingerprint,
        revision: nextSnapshot.revision,
      },
    ].slice(-dedupeLimit);

    await writeEnvelope(createStorageEnvelope(nextSnapshot, recentMutations));
    return {
      snapshot: cloneSidebarSnapshot(nextSnapshot),
      applied: true,
      deduplicated: false,
      mutationRevision: nextSnapshot.revision,
    };
  });

  return {
    initialize,
    readSnapshot,
    applyMutation,
  };
};

export type SidebarStateRuntime = ReturnType<typeof createSidebarStateRuntime>;
