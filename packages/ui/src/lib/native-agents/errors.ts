/** A native session request the OpenChamber server answered with an error. */
export class NativeAgentsRequestError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = 'NativeAgentsRequestError';
    this.status = status;
    this.code = code;
  }
}

/** The runtime has no OpenChamber server to host native sessions (VS Code). */
export class NativeAgentsUnsupportedError extends Error {
  constructor() {
    super('Native CLI sessions are not available in this runtime');
    this.name = 'NativeAgentsUnsupportedError';
  }
}
