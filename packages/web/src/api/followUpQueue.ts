import type {
  FollowUpQueueAPI,
  FollowUpQueueMutationRequest,
  FollowUpQueueMutationResult,
  FollowUpQueueSnapshot,
} from '@openchamber/ui/lib/api/types';
import {
  FollowUpQueueConflictError,
  FollowUpQueueRequestError,
  FollowUpQueueUnsupportedError,
  parseFollowUpQueueMutationResult,
  parseFollowUpQueueSnapshot,
} from '@openchamber/ui/lib/followUpQueue';
import { runtimeFetch } from '@openchamber/ui/lib/runtime-fetch';
import { getRuntimeEndpointGeneration, getRuntimeKey } from '@openchamber/ui/lib/runtime-switch';

const CAPABILITIES_PATH = '/auth/follow-up-queue/capabilities';
const LOAD_PATH = '/auth/follow-up-queue/load';
const MUTATIONS_PATH = '/auth/follow-up-queue/mutations';
const CAPABILITY_TIMEOUT_MS = 10_000;

const waitForProbe = <T>(request: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return request;
  if (signal.aborted) return Promise.reject(new DOMException('The operation was aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException('The operation was aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    request.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
};

const readErrorPayload = async (response: Response): Promise<Record<string, unknown> | null> => {
  const payload = await response.json().catch(() => null) as unknown;
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
};

const requestError = (
  response: Response,
  payload: Record<string, unknown> | null,
  fallback: string,
): FollowUpQueueRequestError => {
  const code = typeof payload?.code === 'string' ? payload.code : null;
  return new FollowUpQueueRequestError(
    typeof payload?.error === 'string' ? payload.error : fallback,
    {
      status: response.status,
      code,
      permanent: response.status === 400
        || response.status === 409
        || response.status === 413
        || response.status === 415
        || code === 'FOLLOW_UP_QUEUE_CORRUPT',
    },
  );
};

const readProtocolResult = async <T>(
  response: Response,
  parse: (value: unknown) => T,
  invalidMessage: string,
  invalidResponsePermanent = true,
): Promise<T> => {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new FollowUpQueueRequestError('Failed to read the host follow-up queue response', {
      status: response.status,
      code: 'FOLLOW_UP_QUEUE_RESPONSE_READ_FAILED',
      permanent: false,
    });
  }
  try {
    return parse(payload);
  } catch {
    throw new FollowUpQueueRequestError(invalidMessage, {
      status: response.status,
      code: 'FOLLOW_UP_QUEUE_INVALID_RESPONSE',
      permanent: invalidResponsePermanent,
    });
  }
};

export const createWebFollowUpQueueAPI = (): FollowUpQueueAPI => {
  const capabilityProbes = new Map<string, Promise<boolean>>();

  const ensureSupported = async (runtimeKey: string, signal?: AbortSignal): Promise<void> => {
    const probeKey = `${getRuntimeEndpointGeneration()}\u0000${runtimeKey}`;
    let request = capabilityProbes.get(probeKey);
    if (!request) {
      request = (async () => {
        const response = await runtimeFetch(CAPABILITIES_PATH, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          cache: 'no-store',
          signal: AbortSignal.timeout(CAPABILITY_TIMEOUT_MS),
          expectedRuntimeKey: runtimeKey,
        });
        if (!response.ok) {
          if (response.status === 404 || response.status === 405 || response.status === 501) return false;
          const payload = await readErrorPayload(response);
          throw requestError(response, payload, `Failed to probe follow-up queue support (${response.status})`);
        }
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          throw new FollowUpQueueRequestError('Failed to read follow-up queue capabilities', {
            status: response.status,
            code: 'FOLLOW_UP_QUEUE_RESPONSE_READ_FAILED',
            permanent: false,
          });
        }
        return Boolean(
          payload
          && typeof payload === 'object'
          && !Array.isArray(payload)
          && (payload as Record<string, unknown>).authority === 'openchamber-host'
          && (payload as Record<string, unknown>).version === 2
        );
      })();
      capabilityProbes.set(probeKey, request);
      if (capabilityProbes.size > 16) capabilityProbes.delete(capabilityProbes.keys().next().value as string);
      request.finally(() => {
        if (capabilityProbes.get(probeKey) === request) capabilityProbes.delete(probeKey);
      }).catch(() => {});
    }
    if (!await waitForProbe(request, signal)) throw new FollowUpQueueUnsupportedError();
  };

  return {
    supported: true,

    async load(sessionId, options): Promise<FollowUpQueueSnapshot> {
      const runtimeKey = options?.expectedRuntimeKey ?? getRuntimeKey();
      await ensureSupported(runtimeKey, options?.signal);
      const response = await runtimeFetch(LOAD_PATH, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ sessionId }),
        cache: 'no-store',
        signal: options?.signal,
        expectedRuntimeKey: runtimeKey,
      });
      if (!response.ok) {
        const payload = await readErrorPayload(response);
        throw requestError(response, payload, `Failed to load follow-up queue (${response.status})`);
      }
      return readProtocolResult(
        response,
        parseFollowUpQueueSnapshot,
        'Host returned an invalid follow-up queue snapshot',
      );
    },

    async mutate(
      request: FollowUpQueueMutationRequest,
      options,
    ): Promise<FollowUpQueueMutationResult> {
      const runtimeKey = options?.expectedRuntimeKey ?? getRuntimeKey();
      await ensureSupported(runtimeKey, options?.signal);
      const response = await runtimeFetch(MUTATIONS_PATH, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(request),
        cache: 'no-store',
        signal: options?.signal,
        expectedRuntimeKey: runtimeKey,
      });
      if (response.status === 409) {
        const payload = await readErrorPayload(response);
        if (payload?.latestSnapshot !== undefined) {
          try {
            throw new FollowUpQueueConflictError(parseFollowUpQueueSnapshot(payload.latestSnapshot));
          } catch (error) {
            if (error instanceof FollowUpQueueConflictError) throw error;
            throw new FollowUpQueueRequestError('Host returned an invalid follow-up queue conflict snapshot', {
              status: response.status,
              code: 'FOLLOW_UP_QUEUE_INVALID_RESPONSE',
              permanent: true,
            });
          }
        }
        throw requestError(response, payload, 'Follow-up queue mutation was rejected');
      }
      if (!response.ok) {
        const payload = await readErrorPayload(response);
        throw requestError(response, payload, `Failed to mutate follow-up queue (${response.status})`);
      }
      return readProtocolResult(
        response,
        parseFollowUpQueueMutationResult,
        'Host returned an invalid follow-up queue mutation result',
        false,
      );
    },
  };
};
