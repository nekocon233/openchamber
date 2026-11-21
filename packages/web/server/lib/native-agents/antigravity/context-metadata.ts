import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type AgyCompactionBudget = {
  used: number;
  threshold: number;
};

const MAX_METADATA_BYTES = 8 * 1024 * 1024;

const isSafeInt = (value: number | Uint8Array | undefined): value is number => Number.isSafeInteger(value);

const readVarint = (bytes: Uint8Array, cursor: { offset: number }): number => {
  let value = 0;
  for (let shift = 0; shift < 70 && cursor.offset < bytes.length; shift += 7) {
    const byte = bytes[cursor.offset];
    cursor.offset += 1;
    if (byte === undefined) break;
    value += (byte & 127) * 2 ** shift;
    if (byte < 128) return value;
  }
  throw new Error('Invalid Antigravity generation metadata varint');
};

function* fields(bytes: Uint8Array | undefined): Generator<[number, number | Uint8Array]> {
  if (!bytes) return;
  const cursor = { offset: 0 };
  while (cursor.offset < bytes.length) {
    const tag = readVarint(bytes, cursor);
    const number = Math.floor(tag / 8);
    const type = tag % 8;
    if (!Number.isSafeInteger(tag) || number === 0) throw new Error('Invalid metadata field');
    if (type === 0) {
      yield [number, readVarint(bytes, cursor)];
      continue;
    }
    const length = type === 2 ? readVarint(bytes, cursor) : type === 1 ? 8 : type === 5 ? 4 : -1;
    const end = cursor.offset + length;
    if (length < 0 || end > bytes.length) throw new Error('Invalid metadata field length');
    if (type === 2) yield [number, bytes.subarray(cursor.offset, end)];
    cursor.offset = end;
  }
}

const hasStep = (value: number | Uint8Array, stepIndex: number): boolean => {
  if (!(value instanceof Uint8Array)) return value === stepIndex;
  const cursor = { offset: 0 };
  while (cursor.offset < value.length) {
    if (readVarint(value, cursor) === stepIndex) return true;
  }
  return false;
};

const messageField = (decoded: Iterable<[number, number | Uint8Array]>, number: number): Uint8Array | undefined => {
  for (const [field, value] of decoded) {
    if (field === number && value instanceof Uint8Array) return value;
  }
  return undefined;
};

const decodeContext = (bytes: Uint8Array, stepIndex: number): AgyCompactionBudget | null => {
  const generation = [...fields(bytes)];
  if (!generation.some(([number, value]) => number === 2 && hasStep(value, stepIndex))) return null;
  const chat = messageField(generation, 1);
  const start = messageField(fields(chat), 9);
  const context = new Map(fields(messageField(fields(start), 10)));
  const used = context.get(1) ?? 0;
  const threshold = context.get(4);
  if (!isSafeInt(used) || used < 0 || !isSafeInt(threshold) || threshold <= 0) return null;
  return { used, threshold };
};

export const readAgyCompactionBudget = (
  root: string,
  nativeId: string,
  stepIndex: number | undefined,
): AgyCompactionBudget | null => {
  if (stepIndex === undefined) return null;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path.join(root, 'conversations', `${nativeId}.db`), { readOnly: true });
    const rows = db.prepare('select case when length(data) <= ? then data end as data from gen_metadata order by idx desc limit 4');
    for (const row of rows.iterate(MAX_METADATA_BYTES)) {
      const data = row.data;
      if (!(data instanceof Uint8Array)) continue;
      try {
        const budget = decodeContext(data, stepIndex);
        if (budget) return budget;
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  } finally {
    db?.close();
  }
  return null;
};
