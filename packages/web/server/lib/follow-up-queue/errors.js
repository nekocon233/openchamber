class FollowUpQueueError extends Error {
  constructor(message, code) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class FollowUpQueueValidationError extends FollowUpQueueError {
  constructor(message) {
    super(message, 'FOLLOW_UP_QUEUE_VALIDATION');
  }
}

export class FollowUpQueueCorruptError extends FollowUpQueueError {
  constructor() {
    super('Stored follow-up queue is malformed', 'FOLLOW_UP_QUEUE_CORRUPT');
  }
}

export class FollowUpQueueConflictError extends FollowUpQueueError {
  constructor(baseRevision, latestSnapshot) {
    super('Follow-up queue revision conflict', 'FOLLOW_UP_QUEUE_CONFLICT');
    this.baseRevision = baseRevision;
    this.actualRevision = latestSnapshot.revision;
    this.latestSnapshot = latestSnapshot;
  }
}

export class FollowUpQueueItemConflictError extends FollowUpQueueError {
  constructor() {
    super('Follow-up queue item identity conflicts with an existing item', 'FOLLOW_UP_QUEUE_ITEM_CONFLICT');
  }
}

export class FollowUpQueueIdempotencyError extends FollowUpQueueError {
  constructor() {
    super(
      'clientMutationId was already used for a different follow-up queue mutation',
      'FOLLOW_UP_QUEUE_IDEMPOTENCY_KEY_REUSED',
    );
  }
}

export class FollowUpQueueReadError extends FollowUpQueueError {
  constructor() {
    super('Failed to read authoritative follow-up queue', 'FOLLOW_UP_QUEUE_READ_FAILED');
  }
}

export class FollowUpQueueWriteError extends FollowUpQueueError {
  constructor() {
    super('Failed to persist authoritative follow-up queue', 'FOLLOW_UP_QUEUE_WRITE_FAILED');
  }
}
