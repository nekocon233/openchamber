const RANDOM_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const RANDOM_LENGTH = 14;

let lastTimestamp = 0;
let counter = 0;

const randomBase62 = (length: number): string => {
  const bytes = new Uint8Array(length);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  let result = '';
  for (const byte of bytes) result += RANDOM_CHARS[byte % RANDOM_CHARS.length];
  return result;
};

/** Creates an ID compatible with OpenCode's time-sortable Identifier.ascending format. */
export const createOpenCodeIdentifier = (prefix: 'msg' | 'prt'): string => {
  const timestamp = Date.now();
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    counter = 0;
  }
  counter += 1;

  const sortable = BigInt(timestamp) * BigInt(0x1000) + BigInt(counter);
  const bytes = new Uint8Array(6);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number((sortable >> BigInt(40 - 8 * index)) & BigInt(0xff));
  }
  const time = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${time}${randomBase62(RANDOM_LENGTH)}`;
};
