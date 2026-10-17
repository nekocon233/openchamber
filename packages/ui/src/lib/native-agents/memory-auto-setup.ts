import type { NativeAgentsAPI } from '@/lib/api/types';

import { NativeAgentsRequestError } from './errors';

export type NativeMemoryAutoSetupResult = {
  kind: 'ready' | 'remote' | 'failed';
  reviewRequired: boolean;
};

/**
 * Installs missing terminal hooks without touching installed ones: reconnecting
 * resets the CLI's ready/lastSeen proof.
 */
export const autoConnectNativeMemory = async (
  nativeAgents: Pick<NativeAgentsAPI, 'memoryStatus' | 'connectMemory'>,
): Promise<NativeMemoryAutoSetupResult> => {
  let status;
  try {
    status = await nativeAgents.memoryStatus();
  } catch {
    return { kind: 'failed', reviewRequired: false };
  }
  if (!status.canManage) return { kind: 'remote', reviewRequired: false };

  let reviewRequired = status.backends.some((backend) => backend.status === 'ok' && backend.reviewRequired);
  let failed = false;
  for (const backend of status.backends) {
    if (backend.status !== 'ok') {
      failed = true;
      continue;
    }
    if (backend.installed) continue;
    try {
      const connection = await nativeAgents.connectMemory(backend.backend);
      reviewRequired ||= connection.reviewRequired;
    } catch (error) {
      if (error instanceof NativeAgentsRequestError && error.code === 'NATIVE_MEMORY_LOCAL_REQUIRED') {
        return { kind: 'remote', reviewRequired };
      }
      failed = true;
    }
  }
  return { kind: failed ? 'failed' : 'ready', reviewRequired };
};
