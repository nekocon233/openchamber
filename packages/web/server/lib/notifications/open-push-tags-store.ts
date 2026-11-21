import fs from 'node:fs/promises';
import path from 'node:path';
import { errorCodeOf } from '../shared/object-guards.js';
import type { JsonValue } from '../shared/json-values.js';
import type { NotificationTriggerDependencies } from './runtime.js';

export function createOpenPushTagsStore(file: string): NonNullable<NotificationTriggerDependencies['openPushTagsStore']> {
  return {
    read: async () => {
      try {
        const saved: JsonValue = JSON.parse(await fs.readFile(file, 'utf8'));
        return saved;
      } catch (cause) {
        if (errorCodeOf(cause) === 'ENOENT') return null;
        throw cause;
      }
    },
    write: async (state) => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify({ version: 1, ...state }), { encoding: 'utf8', mode: 0o600 });
    },
  };
}
