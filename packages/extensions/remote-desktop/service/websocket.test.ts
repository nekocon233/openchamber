import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { createRfbWebSocket, encodeFrame } from './websocket.ts';

const clientFrame = (opcode: number, data: Buffer, fin = true): Buffer => {
  const raw = encodeFrame(opcode, data); raw[0] = (fin ? 0x80 : 0) | opcode;
  const headerLength = raw.length - data.length;
  raw[1] = raw[1]! | 0x80;
  const mask = Buffer.from([12, 34, 56, 78]);
  const bytes = Buffer.from(data);
  for (let i = 0; i < bytes.length; i++) bytes[i] = bytes[i]! ^ mask[i % 4]!;
  return Buffer.concat([raw.subarray(0, headerLength), mask, bytes]);
};
const decoder = () => {
  const stream = new PassThrough();
  // Feed manually, so writes of server replies do not loop into its parser.
  const bytes: Buffer[] = []; let ended = 0;
  const ws = createRfbWebSocket(stream, (data) => bytes.push(data), () => { ended++; });
  stream.removeAllListeners('data');
  return { stream, bytes, ws, ended: () => ended };
};

describe('RFB WebSocket framing', () => {
  test('unmasks split headers and payloads without buffering an entire RFB message', () => {
    const run = decoder(); const data = Buffer.alloc(130_000, 0xad); const frame = clientFrame(2, data);
    for (let i = 0; i < frame.length; i += 127) run.ws.feed(frame.subarray(i, i + 127));
    expect(Buffer.concat(run.bytes)).toEqual(data); expect(run.ended()).toBe(0); run.stream.destroy();
  });
  test('handles fragmented binary input with interleaved ping frames', () => {
    const run = decoder();
    run.ws.feed(clientFrame(2, Buffer.from('RFB '), false));
    run.ws.feed(clientFrame(9, Buffer.from('ping')));
    run.ws.feed(clientFrame(0, Buffer.from('003.008\n')));
    expect(Buffer.concat(run.bytes).toString()).toBe('RFB 003.008\n'); expect(run.ended()).toBe(0); run.stream.destroy();
  });
  test('refuses unmasked, invalid continuation, compressed and oversized frames', () => {
    for (const frame of [encodeFrame(2, Buffer.from('raw')), clientFrame(0, Buffer.from('orphan')), Buffer.from([0xc2, 0x80, 1, 2, 3, 4]), Buffer.from([0x82, 0xff, 0, 0, 0, 0, 0, 0x7a, 0x12, 1, 0, 0, 0, 0])]) {
      const run = decoder(); run.ws.feed(frame); expect(run.ended()).toBe(1); run.stream.destroy();
    }
  });
});
