import { isEnterpriseMode } from '../../enterprise-mode.js';
import { NativeAgentError } from '../errors.js';
import type { DeepseekInstallation } from './installation.js';

export type DeepseekSetupState =
  | { state: 'idle' }
  | { state: 'installing' }
  | { state: 'ready' }
  | { state: 'error'; code: string };

export interface DeepseekSetupOptions {
  installation: Pick<DeepseekInstallation, 'prepare' | 'shutdown'>;
  enterpriseMode?: (() => boolean) | undefined;
}

export interface DeepseekSetup {
  status: () => DeepseekSetupState;
  start: () => DeepseekSetupState;
  shutdown: () => Promise<void>;
}

export const createDeepseekSetup = ({ installation, enterpriseMode = isEnterpriseMode }: DeepseekSetupOptions): DeepseekSetup => {
  let state: DeepseekSetupState = { state: 'idle' };
  let job: Promise<void> | null = null;
  let jobController: AbortController | null = null;
  const controller = new AbortController();

  const allowed = (): void => {
    controller.signal.throwIfAborted();
    if (enterpriseMode()) {
      jobController?.abort();
      throw new NativeAgentError('DeepSeek Harness is unavailable in enterprise mode', { code: 'enterprise_mode', status: 403 });
    }
  };

  const run = async (activeController: AbortController): Promise<void> => {
    const proceed = (): void => {
      allowed();
      activeController.signal.throwIfAborted();
    };
    try {
      proceed();
      await installation.prepare({ signal: AbortSignal.any([controller.signal, activeController.signal]) });
      proceed();
      state = { state: 'ready' };
    } catch (error) {
      state = { state: 'error', code: error instanceof NativeAgentError ? error.code : 'NATIVE_DEEPSEEK_SETUP_FAILED' };
    }
  };

  return {
    status() {
      allowed();
      return state;
    },
    start() {
      allowed();
      if (job) return state;
      state = { state: 'installing' };
      const activeController = new AbortController();
      jobController = activeController;
      job = run(activeController).finally(() => {
        job = null;
        jobController = null;
      });
      return state;
    },
    async shutdown() {
      controller.abort();
      await installation.shutdown();
      await job;
    },
  };
};
