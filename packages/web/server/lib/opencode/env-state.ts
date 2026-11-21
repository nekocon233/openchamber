import type { OpenCodeEnvState } from './env-runtime.js';

export function createOpenCodeEnvState(): Required<OpenCodeEnvState> {
  return {
    cachedLoginShellEnvSnapshot: undefined,
    resolvedOpencodeBinary: null,
    resolvedOpencodeBinarySource: null,
    resolvedNodeBinary: null,
    resolvedBunBinary: null,
    resolvedGitBinary: null,
    useWslForOpencode: false,
    resolvedWslBinary: null,
    resolvedWslOpencodePath: null,
    resolvedWslDistro: null,
  };
}
