const EXIT_CODE = {
  SUCCESS: 0,
  GENERAL_ERROR: 1,
  USAGE_ERROR: 2,
  MISSING_DEPENDENCY: 3,
  AUTH_CONFIG_ERROR: 4,
  NETWORK_RUNTIME_ERROR: 5,
};

export interface TunnelCliErrorOptions {
  reported?: boolean;
}

class TunnelCliError extends Error {
  declare exitCode: number;
  declare reported: boolean;

  constructor(
    message: string,
    exitCode = EXIT_CODE.GENERAL_ERROR,
    { reported = false }: TunnelCliErrorOptions = {},
  ) {
    super(message);
    this.name = 'TunnelCliError';
    this.exitCode = exitCode;
    if (reported) {
      this.reported = true;
    }
  }
}

TunnelCliError.prototype.reported = false;

export { EXIT_CODE, TunnelCliError };
