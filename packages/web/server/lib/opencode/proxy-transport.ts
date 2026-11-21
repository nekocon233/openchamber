import http from 'node:http';
import { createRealpathCache } from '../path-realpath-cache.js';
import type { Request, Response } from '../shared/http-contracts.js';
import type { RealpathCacheOptions } from '../path-realpath-cache.js';

export const isString = (value: unknown): value is string => typeof value === 'string';

export const createDirectoryQueryCanonicalizer = ({ realpath, ...cacheOptions }: RealpathCacheOptions = {}) => {
  const realpathCache = createRealpathCache({ fallbackOnError: true, realpath, ...cacheOptions });

  return async (requestUrl: string) => {
    if (!requestUrl.includes('directory=')) {
      return requestUrl;
    }

    const url = new URL(requestUrl, 'http://localhost');
    const directory = url.searchParams.get('directory');
    if (!directory) {
      return requestUrl;
    }

    const canonicalDirectory = await realpathCache.resolve(directory);
    if (!canonicalDirectory || canonicalDirectory === directory) {
      return requestUrl;
    }

    url.searchParams.set('directory', canonicalDirectory);
    return `${url.pathname}${url.search}`;
  };
};

const PERCENT_ESCAPE = /%[0-9a-fA-F]{2}/;

export const directoriesAsOpenCodeReadsThem = (req: Request, url: URL) => {
  const directories = [...url.searchParams.getAll('directory'), ...url.searchParams.getAll('location[directory]')];
  const header = req.get('x-opencode-directory');
  if (header) {
    let directory = header;
    if (req.get('x-opencode-directory-encoding') === 'uri' || PERCENT_ESCAPE.test(header)) {
      try {
        directory = decodeURIComponent(header);
      } catch {
        void 0;
      }
    }
    directories.push(directory);
  }
  return directories;
};

export const normalizeForwardedDirectoryHeaders = <Headers extends http.IncomingHttpHeaders>(headers: Headers) => {
  const writableHeaders: http.IncomingHttpHeaders = headers;
  const rawDirectory = headers?.['x-opencode-directory'];
  if (!isString(rawDirectory)) {
    return headers;
  }

  if (headers['x-opencode-directory-encoding'] !== 'uri') {
    return headers;
  }

  try {
    const decodedDirectory = decodeURIComponent(rawDirectory);
    try {
      http.validateHeaderValue('x-opencode-directory', decodedDirectory);
    } catch {
      return headers;
    }
    writableHeaders['x-opencode-directory'] = decodedDirectory;
  } catch {
    void 0;
  }
  delete headers['x-opencode-directory-encoding'];
  return headers;
};

const waitForSseDrain = (res: Response, signal?: AbortSignal) => new Promise<void>((resolve) => {
  if (signal?.aborted || res.writableEnded || res.destroyed) {
    resolve();
    return;
  }

  const cleanup = () => {
    res.off?.('drain', onDone);
    res.off?.('close', onDone);
    res.off?.('error', onDone);
    signal?.removeEventListener?.('abort', onDone);
  };
  const onDone = () => {
    cleanup();
    resolve();
  };

  res.once?.('drain', onDone);
  res.once?.('close', onDone);
  res.once?.('error', onDone);
  signal?.addEventListener?.('abort', onDone, { once: true });
});

export const writeSseChunkWithBackpressure = async (res: Response, value: string | Uint8Array | undefined, signal?: AbortSignal) => {
  if (!value || value.length === 0 || signal?.aborted || res.writableEnded || res.destroyed) {
    return false;
  }

  const flushed = res.write(value);
  if (flushed !== false) {
    return true;
  }

  await waitForSseDrain(res, signal);
  return !signal?.aborted && !res.writableEnded && !res.destroyed;
};

export const createSseBoundaryTracker = () => {
  const decoder = new TextDecoder();
  let tail = '';

  const normalize = (value: string) => value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  return {
    observe(value: string | Uint8Array) {
      const text = isString(value)
        ? value
        : decoder.decode(value, { stream: true });
      if (text.length > 0) {
        tail = `${tail}${normalize(text)}`;
        if (tail.length > 4096) {
          tail = tail.slice(-4096);
        }
      }
      return this.isAtBoundary();
    },
    isAtBoundary() {
      return tail.length === 0 || tail.endsWith('\n\n');
    },
  };
};
