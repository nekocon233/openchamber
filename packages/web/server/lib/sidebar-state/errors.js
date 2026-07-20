export class SidebarStateError extends Error {
  constructor(message, code, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
  }
}

export class SidebarStateValidationError extends SidebarStateError {
  constructor(message) {
    super(message, 'SIDEBAR_STATE_VALIDATION');
  }
}

export class SidebarStateNotInitializedError extends SidebarStateError {
  constructor() {
    super('Sidebar state has not been initialized', 'SIDEBAR_STATE_NOT_INITIALIZED');
  }
}

export class SidebarStateCorruptError extends SidebarStateError {
  constructor(options = {}) {
    super('Stored sidebar state is malformed', 'SIDEBAR_STATE_CORRUPT', options);
  }
}

export class SidebarStateConflictError extends SidebarStateError {
  constructor(baseRevision, latestSnapshot) {
    super('Sidebar state revision conflict', 'SIDEBAR_STATE_CONFLICT');
    this.baseRevision = baseRevision;
    this.actualRevision = latestSnapshot.revision;
    this.latestSnapshot = latestSnapshot;
  }
}

export class SidebarStateIdempotencyError extends SidebarStateError {
  constructor() {
    super(
      'clientMutationId was already used for a different sidebar mutation',
      'SIDEBAR_STATE_IDEMPOTENCY_KEY_REUSED',
    );
  }
}

export class SidebarStateWriteError extends SidebarStateError {
  constructor(options = {}) {
    super('Failed to persist sidebar state', 'SIDEBAR_STATE_WRITE_FAILED', options);
  }
}

export class SidebarStateLegacyWriteError extends SidebarStateError {
  constructor() {
    super(
      'Projects and active sidebar navigation cannot be written through settings',
      'SIDEBAR_STATE_LEGACY_WRITE_REJECTED',
    );
  }
}
