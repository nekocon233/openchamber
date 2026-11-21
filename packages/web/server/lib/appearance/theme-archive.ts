import { openZipArchive } from '../shared/zip-archive.js';

const MAX_FILE_BYTES = 512 * 1024;

export function openThemeArchive(bytes: Buffer) {
  const read = openZipArchive(bytes, 100 * 1024 * 1024);
  return async (name: string) => (await read(name, MAX_FILE_BYTES)).toString('utf8');
}
