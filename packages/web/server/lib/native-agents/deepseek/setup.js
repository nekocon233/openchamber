import { isEnterpriseMode } from '../../enterprise-mode.js';
import { NativeAgentError } from '../errors.js';

/** One shared setup job continues when its initiating browser disconnects. */
export const createDeepseekSetup = ({ installation, configuration, enterpriseMode = isEnterpriseMode }) => {
  let state = { state: 'idle' };
  let job = null;
  let jobController = null;
  const controller = new AbortController();
  const allowed = () => {
    controller.signal.throwIfAborted();
    if (enterpriseMode()) {
      jobController?.abort();
      throw new NativeAgentError('DeepSeek Harness is unavailable in enterprise mode', { code: 'enterprise_mode', status: 403 });
    }
  };
  const proceed = () => { allowed(); jobController.signal.throwIfAborted(); };
  const run = async () => {
    try {
      proceed();
      await installation.prepare({ signal: AbortSignal.any([controller.signal, jobController.signal]) });
      proceed();
      state = { state: 'configuring' };
      const current = await configuration.read();
      proceed();
      // An existing credential is authoritative, including an environment key.
      state = { state: current.credential.configured ? 'ready' : 'needs-key' };
    } catch (error) {
      state = { state: 'error', code: error instanceof NativeAgentError ? error.code : 'NATIVE_DEEPSEEK_SETUP_FAILED' };
    }
  };
  return {
    status() { allowed(); return state; },
    start() {
      allowed();
      if (job) return state;
      state = { state: 'installing' };
      jobController = new AbortController();
      job = run().finally(() => { job = null; jobController = null; });
      return state;
    },
    async shutdown() {
      controller.abort();
      await installation.shutdown();
      await job;
    },
  };
};
