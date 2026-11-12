import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const MAX_MESSAGE = 8_000_000;
const validClose = (code: number) => (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999);

const keySchema = z.string().regex(/^[A-Za-z0-9+/]{22}==$/);
const protocolsSchema = z.string().optional();
export const websocketAccept = (req: IncomingMessage) => {
  const key = keySchema.safeParse(req.headers['sec-websocket-key']);
  const protocols = protocolsSchema.safeParse(req.headers['sec-websocket-protocol']);
  if (req.method !== 'GET' || req.headers.upgrade?.toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13'
    || !key.success || !protocols.success) return null;
  return { accept: createHash('sha1').update(`${key.data}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64'), protocol: protocols.data?.split(',').some((value) => value.trim() === 'binary') ? 'binary' : '' };
};

export const encodeFrame = (opcode: number, data: Buffer): Buffer => {
  const header = Buffer.alloc(data.length < 126 ? 2 : data.length <= 65535 ? 4 : 10);
  header[0] = 0x80 | opcode;
  header[1] = data.length < 126 ? data.length : data.length <= 65535 ? 126 : 127;
  if (header.length === 4) header.writeUInt16BE(data.length, 2);
  if (header.length === 10) header.writeBigUInt64BE(BigInt(data.length), 2);
  return Buffer.concat([header, data]);
};

/** Incremental masked-frame reader. RFB is a byte stream, so data is unmasked
 * in TCP-sized chunks and never collected into an entire framebuffer. */
export const createRfbWebSocket = (socket: Duplex, onBinary: (bytes: Buffer) => void, onEnd: () => void) => {
  let ended = false;
  let header = Buffer.alloc(0);
  let headerSize = 2;
  let remaining = 0;
  let offset = 0;
  let mask = Buffer.alloc(4);
  let opcode = 0;
  let control: Buffer[] = [];
  let fragmented = false;
  let messageSize = 0;
  let fin = true;
  const close = (code = 1000) => {
    if (ended) return;
    ended = true;
    const body = Buffer.alloc(2); body.writeUInt16BE(code);
    if (!socket.destroyed) socket.end(encodeFrame(8, body));
    const timer = setTimeout(() => socket.destroy(), 1000); timer.unref?.();
    socket.once('close', () => clearTimeout(timer));
    onEnd();
  };
  const finishFrame = () => {
    if (opcode >= 8) {
      const bytes = Buffer.concat(control);
      if (opcode === 8) {
        if (bytes.length === 1) { close(1002); return; }
        if (bytes.length >= 2) {
          if (!validClose(bytes.readUInt16BE())) { close(1002); return; }
          try { new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(2)); } catch { close(1007); return; }
        }
        close(bytes.length >= 2 ? bytes.readUInt16BE() : 1000);
      } else if (opcode === 9 && !socket.destroyed) socket.write(encodeFrame(10, bytes));
    } else if (fin) { fragmented = false; messageSize = 0; }
    header = Buffer.alloc(0); headerSize = 2; offset = 0; control = [];
  };
  const feed = (chunk: Buffer) => {
    let cursor = 0;
    while (cursor < chunk.length && !ended) {
      if (remaining === 0) {
        const count = Math.min(headerSize - header.length, chunk.length - cursor);
        header = Buffer.concat([header, chunk.subarray(cursor, cursor + count)]);
        cursor += count;
        if (header.length < headerSize) continue;
        if (headerSize === 2) {
          if (!(header[1]! & 0x80) || (header[0]! & 0x70)) { close(1002); return; }
          const length = header[1]! & 127;
          headerSize = 2 + (length === 126 ? 2 : length === 127 ? 8 : 0) + 4;
          continue;
        }
        fin = (header[0]! & 128) !== 0;
        opcode = header[0]! & 15;
        const small = header[1]! & 127;
        const length = small === 126 ? header.readUInt16BE(2) : small === 127 ? Number(header.readBigUInt64BE(2)) : small;
        if ((header[0]! & 0x70) || !(header[1]! & 0x80) || ![0, 2, 8, 9, 10].includes(opcode)
          || !Number.isSafeInteger(length) || length > MAX_MESSAGE || (small === 126 && length < 126) || (small === 127 && length <= 65535)
          || (opcode >= 8 && (!fin || length > 125))) { close(1002); return; }
        if (opcode < 8) {
          if ((opcode === 0 && !fragmented) || (opcode === 2 && fragmented)) { close(1002); return; }
          if (opcode === 2) messageSize = 0;
          messageSize += length;
          if (messageSize > MAX_MESSAGE) { close(1009); return; }
          if (!fin) fragmented = true;
        }
        mask = header.subarray(headerSize - 4);
        remaining = length;
        if (remaining === 0) { finishFrame(); continue; }
      }
      const count = Math.min(remaining, chunk.length - cursor);
      const bytes = Buffer.from(chunk.subarray(cursor, cursor + count));
      for (let i = 0; i < count; i += 1) bytes[i] = bytes[i]! ^ mask[(offset + i) % 4]!;
      cursor += count; offset += count; remaining -= count;
      if (opcode >= 8) control.push(bytes); else onBinary(bytes);
      if (remaining === 0) finishFrame();
    }
  };
  socket.on('data', feed);
  socket.once('error', () => close(1011));
  socket.once('close', () => { if (!ended) { ended = true; onEnd(); } });
  return {
    feed,
    close,
    send(data: Buffer) {
      if (ended || socket.destroyed) return false;
      if (socket.writableLength + data.length > MAX_MESSAGE) { close(1009); return false; }
      return socket.write(encodeFrame(2, data));
    },
  };
};
