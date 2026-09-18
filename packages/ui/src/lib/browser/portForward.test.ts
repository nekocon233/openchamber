import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  fetchPortForwardState,
  isPortForwardRelevant,
  resolveForwardedUrl,
  startPortForward,
  stopPortForward,
} from './portForward';

/**
 * These drive the real `runtimeFetch`, replacing only the network call. The
 * injected globals are the same ones the app sets, so the "is OpenChamber
 * somewhere else" decision is exercised rather than stubbed — that decision is
 * what sends a request down the forwarding path in the first place.
 */

type RecordedCall = { readonly method: string; readonly path: string; readonly body: string };

type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** Exactly what the code under test reads off `window`. */
type WindowStub = {
  readonly location: { readonly href: string };
  readonly __OPENCHAMBER_API_BASE_URL__: string;
  readonly __OPENCHAMBER_LOCAL_ORIGIN__?: string;
  readonly __OPENCHAMBER_ELECTRON__?: boolean;
};

let calls: RecordedCall[] = [];
let reply: (path: string) => Response;

const originalFetch = globalThis.fetch;

const jsonResponse = (body: JsonValue, status = 200): Response => new Response(
  JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json' } },
);

/**
 * `defineProperty` rather than assignment: `window` does not exist in this
 * environment, and the stub is deliberately a fraction of a real one.
 */
const installWindow = (stub: WindowStub | undefined): void => {
  Object.defineProperty(globalThis, 'window', { value: stub, configurable: true, writable: true });
};

const setApiBaseUrl = (apiBaseUrl: string): void => {
  installWindow({
    location: { href: 'https://client.example.test/' },
    __OPENCHAMBER_API_BASE_URL__: apiBaseUrl,
    __OPENCHAMBER_LOCAL_ORIGIN__: '',
  });
};

beforeEach(() => {
  calls = [];
  reply = () => jsonResponse({}, 404);
  setApiBaseUrl('https://remote.example.test');

  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    calls.push({
      method: request.method,
      path: new URL(request.url).pathname,
      body: await request.clone().text(),
    });
    return reply(new URL(request.url).pathname);
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  installWindow(undefined);
});

describe('isPortForwardRelevant', () => {
  test('is true for a browser talking to an OpenChamber elsewhere', () => {
    expect(isPortForwardRelevant()).toBe(true);
  });

  test('is false against a local OpenChamber, which resolves localhost itself', () => {
    setApiBaseUrl('http://127.0.0.1:14514');
    expect(isPortForwardRelevant()).toBe(false);
  });

  test('is false in the desktop shell, which binds a local port instead', () => {
    installWindow({
      location: { href: 'https://client.example.test/' },
      __OPENCHAMBER_API_BASE_URL__: 'https://remote.example.test',
      __OPENCHAMBER_ELECTRON__: true,
    });

    expect(isPortForwardRelevant()).toBe(false);
  });
});

describe('fetchPortForwardState', () => {
  test('reports the forwards in force', async () => {
    reply = () => jsonResponse({
      configured: true,
      template: 'oc--{port}.example.com',
      templateError: null,
      forwards: [{ port: 5173, origin: 'https://oc--5173.example.com' }],
    });

    expect(await fetchPortForwardState()).toEqual({
      kind: 'ready',
      template: 'oc--{port}.example.com',
      forwards: [{ port: 5173, origin: 'https://oc--5173.example.com' }],
    });
  });

  test('separates "no template" from "nothing forwarded"', async () => {
    reply = () => jsonResponse({
      configured: false,
      template: null,
      templateError: 'The forward host template must contain {port}',
      forwards: [],
    });

    expect(await fetchPortForwardState()).toEqual({
      kind: 'unconfigured',
      templateError: 'The forward host template must contain {port}',
    });
  });

  test('a failed request is not an empty list', async () => {
    reply = () => jsonResponse({ error: 'nope' }, 500);

    // Reading this as "nothing is forwarded" would offer to start a forward
    // against a server that is not answering.
    expect(await fetchPortForwardState()).toEqual({ kind: 'unavailable' });
  });

  test('a malformed payload is a failure, not a partial success', async () => {
    reply = () => jsonResponse({ configured: true, template: 'x', forwards: 'not-an-array' });

    expect(await fetchPortForwardState()).toEqual({ kind: 'unavailable' });
  });
});

describe('resolveForwardedUrl', () => {
  const ready = (forwards: ReadonlyArray<{ port: number; origin: string }>) => jsonResponse({
    configured: true,
    template: 'oc--{port}.example.com',
    templateError: null,
    forwards,
  });

  test('mints a single-use URL for a forwarded port, keeping the path', async () => {
    reply = (path) => (path === '/api/port-forward/grant'
      ? jsonResponse({ url: 'https://oc--5173.example.com/docs?__oc_fwd=abc' })
      : ready([{ port: 5173, origin: 'https://oc--5173.example.com' }]));

    const resolution = await resolveForwardedUrl('http://localhost:5173/docs');

    expect(resolution).toEqual({ kind: 'forwarded', url: 'https://oc--5173.example.com/docs?__oc_fwd=abc' });
    expect(JSON.parse(calls.at(-1)!.body)).toEqual({ port: 5173, path: '/docs' });
  });

  test('says a port is not forwarded rather than loading this machine\'s own', async () => {
    reply = () => ready([]);

    expect(await resolveForwardedUrl('http://localhost:5173/')).toEqual({ kind: 'not-forwarded', port: 5173 });
  });

  test('says forwarding is unconfigured, with the reason', async () => {
    reply = () => jsonResponse({
      configured: false,
      template: null,
      templateError: 'bad template',
      forwards: [],
    });

    expect(await resolveForwardedUrl('http://localhost:5173/')).toEqual({
      kind: 'unconfigured',
      templateError: 'bad template',
    });
  });

  test('reports a failure instead of falling back to the original URL', async () => {
    reply = () => jsonResponse({}, 503);

    // Loading `localhost:5173` here would show whatever runs on that port on
    // *this* machine, under the address the user asked for.
    expect(await resolveForwardedUrl('http://localhost:5173/')).toEqual({ kind: 'failed' });
  });

  test('reports a failure when the grant cannot be minted', async () => {
    reply = (path) => (path === '/api/port-forward/grant'
      ? jsonResponse({ error: 'gone' }, 404)
      : ready([{ port: 5173, origin: 'https://oc--5173.example.com' }]));

    expect(await resolveForwardedUrl('http://localhost:5173/')).toEqual({ kind: 'failed' });
  });

  test('leaves an address that is not loopback alone', async () => {
    const url = 'https://openchamber.dev/docs';
    expect(await resolveForwardedUrl(url)).toEqual({ kind: 'direct', url });
    expect(calls).toEqual([]);
  });

  test('leaves an empty address alone', async () => {
    expect(await resolveForwardedUrl('')).toEqual({ kind: 'direct', url: '' });
    expect(calls).toEqual([]);
  });

  test('leaves loopback alone when OpenChamber runs on this machine', async () => {
    setApiBaseUrl('http://127.0.0.1:14514');

    expect(await resolveForwardedUrl('http://localhost:5173/')).toEqual({
      kind: 'direct',
      url: 'http://localhost:5173/',
    });
    expect(calls).toEqual([]);
  });

  test('resolves the implicit port of a schemeless loopback address', async () => {
    reply = (path) => (path === '/api/port-forward/grant'
      ? jsonResponse({ url: 'https://oc--80.example.com/' })
      : ready([{ port: 80, origin: 'https://oc--80.example.com' }]));

    expect(await resolveForwardedUrl('http://localhost/')).toEqual({
      kind: 'forwarded',
      url: 'https://oc--80.example.com/',
    });
  });
});

describe('starting and stopping', () => {
  test('starts a forward and returns where it answers', async () => {
    reply = () => jsonResponse({ port: 5173, origin: 'https://oc--5173.example.com' });

    expect(await startPortForward(5173)).toEqual({ port: 5173, origin: 'https://oc--5173.example.com' });
    expect(calls[0]?.method).toBe('POST');
  });

  test('surfaces the server\'s explanation when a start is refused', async () => {
    reply = () => jsonResponse({ error: 'Set a forward host template first.', reason: 'no-template' }, 409);

    await expect(startPortForward(5173)).rejects.toThrow('Set a forward host template first.');
  });

  test('stops a forward', async () => {
    reply = () => jsonResponse({ stopped: true });

    await stopPortForward(5173);
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.path).toBe('/api/port-forward/5173');
  });

  test('reports a refused stop rather than looking successful', async () => {
    reply = () => jsonResponse({}, 500);

    await expect(stopPortForward(5173)).rejects.toThrow();
  });
});
