import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MAX_METADATA_BYTES = 8 * 1024 * 1024;

const readVarint = (bytes, cursor) => {
  let value = 0;
  for (let shift = 0; shift < 70 && cursor.offset < bytes.length; shift += 7) {
    const byte = bytes[cursor.offset++];
    value += (byte & 127) * 2 ** shift;
    if (byte < 128) return value;
  }
  throw new Error('Invalid Antigravity generation metadata varint');
};

function* fields(bytes) {
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

const hasStep = (value, stepIndex) => {
  if (!(value instanceof Uint8Array)) return value === stepIndex;
  const cursor = { offset: 0 };
  while (cursor.offset < value.length) {
    if (readVarint(value, cursor) === stepIndex) return true;
  }
  return false;
};

const decodeContext = (bytes, stepIndex) => {
  // GeneratorMetadata.step_indices are trajectory steps. The table's idx
  // counts model calls, which can emit more than one trajectory step.
  const generation = [...fields(bytes)];
  if (!generation.some(([number, value]) => number === 2 && hasStep(value, stepIndex))) return null;
  const messageField = (decoded, number) => [...decoded]
    .find(([field, value]) => field === number && value instanceof Uint8Array)?.[1];
  const chat = messageField(generation, 1);
  const start = messageField(fields(chat), 9);
  const context = new Map(fields(messageField(fields(start), 10)));
  const used = context.get(1) ?? 0;
  const threshold = context.get(4);
  if (!Number.isSafeInteger(used) || used < 0 || !Number.isSafeInteger(threshold) || threshold <= 0) return null;
  return { used, threshold };
};

/** Latest saved CLI estimate and compaction threshold for this exact response. */
export const readAgyCompactionBudget = (root, nativeId, stepIndex) => {
  if (stepIndex === undefined) return null;
  let db;
  try {
    db = new DatabaseSync(path.join(root, 'conversations', `${nativeId}.db`), { readOnly: true });
    const rows = db.prepare('select case when length(data) <= ? then data end as data from gen_metadata order by idx desc limit 4');
    for (const { data } of rows.iterate(MAX_METADATA_BYTES)) {
      if (!data) continue;
      try {
        const budget = decodeContext(data, stepIndex);
        if (budget) return budget;
      } catch { /* A malformed observation does not change saved chat history. */ }
    }
  } catch { /* Older CLI stores and in-progress writes can lack this reading. */ }
  finally { db?.close(); }
  return null;
};
