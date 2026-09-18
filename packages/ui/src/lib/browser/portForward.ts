/**
 * Client for forwarded dev-server ports.
 *
 * A dev server on the OpenChamber host answers on `localhost:<port>` there,
 * which means nothing here. The desktop shell solves that by binding an
 * equivalent local port (`./devTunnel`); a browser cannot bind anything, so the
 * host publishes the port on an origin of its own instead and this module
 * asks it to.
 *
 * Every result is a tagged union rather than a nullable value: "forwarding is
 * not configured", "this port is not forwarded", and "we could not ask" lead to
 * completely different UI, and collapsing them would show the wrong one.
 */
import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';
import { isLoopbackUrl, isRemoteOpenChamberOrigin, loopbackPort, urlPathWithQuery } from './url';

const forwardedPortSchema = z.object({
  port: z.number().int().positive(),
  origin: z.string().min(1),
});

const stateSchema = z.object({
  configured: z.boolean(),
  template: z.string().nullable(),
  templateError: z.string().nullable(),
  forwards: z.array(forwardedPortSchema),
});

const grantSchema = z.object({ url: z.string().min(1) });
const failureSchema = z.object({ error: z.string().optional() });

export type ForwardedPort = z.infer<typeof forwardedPortSchema>;

export type PortForwardState =
  | { readonly kind: 'ready'; readonly template: string; readonly forwards: ReadonlyArray<ForwardedPort> }
  | { readonly kind: 'unconfigured'; readonly templateError: string | null }
  | { readonly kind: 'unavailable' };

/** Carries the server's own explanation, which is the useful half of a failure. */
class PortForwardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PortForwardError';
  }
}

const failureFrom = async (response: Response, fallback: string): Promise<PortForwardError> => {
  try {
    const body = failureSchema.parse(await response.json());
    return new PortForwardError(body.error ?? fallback);
  } catch {
    return new PortForwardError(fallback);
  }
};

/**
 * Whether forwarding is the mechanism this client needs at all.
 *
 * The desktop shell tunnels instead, and a client talking to an OpenChamber on
 * this machine already resolves `localhost` correctly — forwarding either of
 * those would add a hop and an origin nobody asked for.
 */
export const isPortForwardRelevant = (): boolean => {
  if (!globalThis.window) return false;
  if (window.__OPENCHAMBER_ELECTRON__) return false;
  return isRemoteOpenChamberOrigin(getRuntimeApiBaseUrl());
};

export const fetchPortForwardState = async (signal?: AbortSignal): Promise<PortForwardState> => {
  try {
    const response = await runtimeFetch('/api/port-forward', { signal });
    if (!response.ok) return { kind: 'unavailable' };

    const body = stateSchema.parse(await response.json());
    if (!body.configured || body.template === null) {
      return { kind: 'unconfigured', templateError: body.templateError };
    }
    return { kind: 'ready', template: body.template, forwards: body.forwards };
  } catch {
    // Distinct from an empty `forwards` list: the caller must not read this as
    // "nothing is forwarded" and offer to start something it cannot reach.
    return { kind: 'unavailable' };
  }
};

export const startPortForward = async (port: number): Promise<ForwardedPort> => {
  const response = await runtimeFetch('/api/port-forward', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port }),
  });
  if (!response.ok) throw await failureFrom(response, 'Could not start the port forward');
  return forwardedPortSchema.parse(await response.json());
};

export const stopPortForward = async (port: number): Promise<void> => {
  const response = await runtimeFetch(`/api/port-forward/${port}`, { method: 'DELETE' });
  if (!response.ok) throw await failureFrom(response, 'Could not stop the port forward');
};

/**
 * The single-use URL that opens a forwarded page.
 *
 * Minted per load rather than cached. The forward trades it for a cookie on
 * first use, so a reused one is already spent — and minting again also renews a
 * cookie that has since expired, which a cached URL could not.
 */
const mintForwardUrl = async (port: number, path: string): Promise<string> => {
  const response = await runtimeFetch('/api/port-forward/grant', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port, path }),
  });
  if (!response.ok) throw await failureFrom(response, 'Could not open the forwarded dev server');
  return grantSchema.parse(await response.json()).url;
};

export type ForwardResolution =
  /** Load it as-is; either it is already reachable or forwarding does not apply. */
  | { readonly kind: 'direct'; readonly url: string }
  | { readonly kind: 'forwarded'; readonly url: string }
  | { readonly kind: 'not-forwarded'; readonly port: number }
  | { readonly kind: 'unconfigured'; readonly templateError: string | null }
  | { readonly kind: 'failed' };

/**
 * Turns an address the user asked for into one this browser can actually load.
 *
 * A failure is reported rather than papered over with the original URL. On a
 * remote instance that substitution changes which machine answers, so the user
 * would be shown whatever happens to run on that port *here* — possibly a
 * different application — under the address they typed.
 */
export const resolveForwardedUrl = async (url: string): Promise<ForwardResolution> => {
  if (!url || !isLoopbackUrl(url) || !isPortForwardRelevant()) return { kind: 'direct', url };

  const port = loopbackPort(url);
  if (!port) return { kind: 'direct', url };

  const state = await fetchPortForwardState();
  if (state.kind === 'unavailable') return { kind: 'failed' };
  if (state.kind === 'unconfigured') {
    return { kind: 'unconfigured', templateError: state.templateError };
  }
  if (!state.forwards.some((entry) => entry.port === port)) {
    return { kind: 'not-forwarded', port };
  }

  try {
    return { kind: 'forwarded', url: await mintForwardUrl(port, urlPathWithQuery(url)) };
  } catch {
    return { kind: 'failed' };
  }
};
