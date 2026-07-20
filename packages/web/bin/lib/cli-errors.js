const EXIT_CODE = {
  SUCCESS: 0,
  GENERAL_ERROR: 1,
  USAGE_ERROR: 2,
  MISSING_DEPENDENCY: 3,
  AUTH_CONFIG_ERROR: 4,
  NETWORK_RUNTIME_ERROR: 5,
};

class TunnelCliError extends Error {
  constructor(message, exitCode = EXIT_CODE.GENERAL_ERROR, { reported = false } = {}) {
    super(message);
    this.name = 'TunnelCliError';
    this.exitCode = exitCode;
    this.reported = reported;
  }
}

export { EXIT_CODE, TunnelCliError };
