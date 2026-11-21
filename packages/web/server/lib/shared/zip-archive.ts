import { crc32, inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';

const inflate = promisify(inflateRaw);

interface ArchiveEntry {
  offset: number;
  compressed: number;
  size: number;
  method: number;
  crc: number;
  attributes: number;
}

export function openZipArchive(bytes: Buffer, maxExpandedBytes: number) {
  let end = bytes.length - 22;
  const lower = Math.max(0, end - 65535);
  while (end >= lower && (bytes.readUInt32LE(end) !== 0x06054b50 || end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length)) end--;
  if (end < lower) throw new Error('Invalid ZIP directory');
  const count = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  let cursor = bytes.readUInt32LE(end + 16);
  if (count > 5000 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)
    || bytes.readUInt16LE(end + 8) !== count || cursor + directorySize !== end) throw new Error('Unsupported ZIP directory');
  const entries = new Map<string, ArchiveEntry>();
  let totalSize = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid ZIP entry');
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const compressed = bytes.readUInt32LE(cursor + 20);
    const size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const next = cursor + 46 + nameLength + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
    const offset = bytes.readUInt32LE(cursor + 42);
    if (next > end || nameLength > 1024 || flags & 1 || ![0, 8].includes(method)) throw new Error('Unsupported ZIP entry');
    const name = bytes.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    const parts = name.replace(/\/$/, '').split('/');
    if (parts.some((part) => !part || part === '.' || part === '..') || /[\\\0:]/.test(name) || entries.has(name)) throw new Error('Unsafe ZIP path');
    totalSize += size;
    if (totalSize > maxExpandedBytes) throw new Error('ZIP contents too large');
    entries.set(name, { offset, compressed, size, method, crc: bytes.readUInt32LE(cursor + 16), attributes: bytes.readUInt32LE(cursor + 38) });
    cursor = next;
  }
  if (cursor !== end) throw new Error('Invalid ZIP directory size');
  return async (name: string, maxFileBytes: number) => {
    const entry = entries.get(name);
    if (!entry) throw new Error(`ZIP archive does not contain ${name}`);
    const fileType = (entry.attributes >>> 16) & 0o170000;
    if (name.endsWith('/') || entry.attributes & 0x10 || (fileType !== 0 && fileType !== 0o100000)) {
      throw new Error('ZIP member is not a regular file');
    }
    if (entry.size > maxFileBytes) throw new Error('ZIP member is too large');
    const { offset, compressed, size, method } = entry;
    if (offset + 30 > bytes.length || bytes.readUInt32LE(offset) !== 0x04034b50 || bytes.readUInt16LE(offset + 8) !== method) throw new Error('Invalid ZIP file');
    const nameLength = bytes.readUInt16LE(offset + 26);
    const start = offset + 30 + nameLength + bytes.readUInt16LE(offset + 28);
    if (start + compressed > bytes.length || bytes.toString('utf8', offset + 30, offset + 30 + nameLength) !== name) throw new Error('Invalid ZIP file bounds');
    const data = bytes.subarray(start, start + compressed);
    const result = method === 0 ? data : await inflate(data, { maxOutputLength: maxFileBytes });
    if (result.length !== size) throw new Error('Invalid ZIP file size');
    if (crc32(result) !== entry.crc) throw new Error('Invalid ZIP file checksum');
    return result;
  };
}
