import { createHash, randomUUID } from 'node:crypto';

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

const DEFAULT_MUTATION_DEDUPE_LIMIT = 256;
const MAX_STATE_FILE_BYTES = 16 * 1024 * 1024;

const stableStringify = (value) => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

const defaultHashMutation = (serializedOperation) => createHash('sha256')
  .update(serializedOperation)
  .digest('hex');

const requireDependency = (value, name) => {
  if (!value) {
    throw new SidebarStateValidationError(`${name} is required`);
  }
  return value;
};

const isMissingFileError = (error) => Boolean(error && typeof error === 'object' && error.code === 'ENOENT');

export const createSidebarStateRuntime = (dependencies) => {
  const options = dependencies && typeof dependencies === 'object' ? dependencies : {};
  const fsPromises = requireDependency(options.fsPromises, 'fsPromises');
  const path = requireDependency(options.path, 'path');
  const filePath = typeof options.filePath === 'string' ? options.filePath.trim() : '';
  const dedupeLimit = options.dedupeLimit ?? DEFAULT_MUTATION_DEDUPE_LIMIT;
  const createTempId = options.createTempId ?? randomUUID;
  const hashMutation = options.hashMutation ?? defaultHashMutation;

  for (const method of ['readFile', 'writeFile', 'mkdir', 'rename', 'unlink']) {
    if (typeof fsPromises[method] !== 'function') {
      throw new SidebarStateValidationError(`fsPromises.${method} is required`);
    }
  }
  if (typeof path.dirname !== 'function') {
    throw new SidebarStateValidationError('path.dirname is required');
  }
  if (!filePath || filePath.includes('\u0000')) {
    throw new SidebarStateValidationError('filePath is invalid');
  }
  if (typeof path.isAbsolute === 'function' && !path.isAbsolute(filePath)) {
    throw new SidebarStateValidationError('filePath must be absolute');
  }
  if (!Number.isSafeInteger(dedupeLimit) || dedupeLimit < 1 || dedupeLimit > MAX_PERSISTED_MUTATION_DEDUPE) {
    throw new SidebarStateValidationError('dedupeLimit is invalid');
  }
  if (typeof createTempId !== 'function' || typeof hashMutation !== 'function') {
    throw new SidebarStateValidationError('createTempId and hashMutation must be functions');
  }

  let queueTail = Promise.resolve();
  let tempSequence = 0;

  const enqueue = (task) => {
    const result = queueTail.then(task, task);
    queueTail = result.then(() => undefined, () => undefined);
    return result;
  };

  const readEnvelope = async () => {
    let raw;
    try {
      raw = await fsPromises.readFile(filePath, 'utf8');
    } catch (error) {
      if (isMissingFileError(error)) {
        throw new SidebarStateNotInitializedError();
      }
      throw error;
    }
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_STATE_FILE_BYTES) {
      throw new SidebarStateCorruptError();
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new SidebarStateCorruptError({ cause: error });
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

  const nextTemporaryPath = () => {
    tempSequence += 1;
    const randomPart = String(createTempId());
    if (!/^[A-Za-z0-9_-]+$/.test(randomPart)) {
      throw new SidebarStateValidationError('createTempId returned an invalid value');
    }
    return `${filePath}.tmp-${process.pid}-${tempSequence}-${randomPart}`;
  };

  const writeEnvelope = async (envelope) => {
    const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_STATE_FILE_BYTES) {
      throw new SidebarStateValidationError('sidebar state exceeds its storage limit');
    }
    let temporaryPath;
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
        await fsPromises.unlink(temporaryPath).catch(() => {});
      }
      throw new SidebarStateWriteError({ cause: error });
    }
  };

  const fingerprintOperation = (operation) => {
    const fingerprint = hashMutation(stableStringify(operation));
    if (typeof fingerprint !== 'string' || !/^[\da-f]{64}$/.test(fingerprint)) {
      throw new SidebarStateValidationError('hashMutation returned an invalid fingerprint');
    }
    return fingerprint;
  };

  const initialize = (input = {}) => enqueue(async () => {
    try {
      const envelope = await readEnvelope();
      return cloneSidebarSnapshot(envelope.snapshot);
    } catch (error) {
      if (!(error instanceof SidebarStateNotInitializedError)) {
        throw error;
      }
    }

    if (!input || typeof input !== 'object' || Array.isArray(input)) {
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

  const readSnapshot = () => enqueue(async () => {
    const envelope = await readEnvelope();
    return cloneSidebarSnapshot(envelope.snapshot);
  });

  const applyMutation = (input) => enqueue(async () => {
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
