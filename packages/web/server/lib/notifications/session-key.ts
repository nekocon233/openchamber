import { createHash } from 'node:crypto';
import type { NotificationAuth } from './auth-runtime.js';
import type { SessionRecords } from './contracts.js';

const SESSION_KEY_PREFIX = 'sha256:';

export const sessionKeyFor = (key: string) => (key.startsWith(SESSION_KEY_PREFIX)
  ? key
  : `${SESSION_KEY_PREFIX}${createHash('sha256').update(key).digest('hex')}`);

export const clientSessionKeyFor = (clientId: string) => sessionKeyFor(`client:${clientId}`);

export const pairedSessionKey = (auth: NotificationAuth): string | null => {
  if (auth.kind === 'client') return clientSessionKeyFor(auth.clientId);
  if (auth.kind !== 'ui-session') return null;
  const digest = auth.identity.slice('notify:ui:'.length);
  if (!/^[A-Za-z0-9_-]{43}$/.test(digest)) return null;
  return `${SESSION_KEY_PREFIX}${Buffer.from(digest, 'base64url').toString('hex')}`;
};

export const withHashedSessionKeys = (bySession: SessionRecords) => {
  const hashed: SessionRecords = {};
  let changed = false;
  for (const [key, entries] of Object.entries(bySession)) {
    const hashedKey = sessionKeyFor(key);
    if (hashedKey !== key) changed = true;
    const previous = hashed[hashedKey];
    hashed[hashedKey] = Array.isArray(previous) && Array.isArray(entries)
      ? [...previous, ...entries]
      : entries;
  }
  return { bySession: hashed, changed };
};
