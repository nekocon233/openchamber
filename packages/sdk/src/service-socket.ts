import type { GuestMessage, HostMessage, HostRequestErrorCode } from './contract.ts';
import { isGuestRequestPath } from './contract.ts';
import { OPENCHAMBER_SDK_API_VERSION, OPENCHAMBER_SDK_CHANNEL } from './api-version.ts';

export const GUEST_SERVICE_SOCKET_MAX = 8;
export const GUEST_SERVICE_SOCKET_FRAME_MAX = 8_000_000;
export const GUEST_SERVICE_SOCKET_BUFFER_MAX = 8_000_000;

export type GuestServiceSocketRequest = { path: string; query?: Record<string, string>; protocols?: string[] };
export type ServiceSocketData = string | Uint8Array<ArrayBuffer>;
export type GuestServiceSocketMessage =
  | { type: 'service-ws-open'; payload: GuestServiceSocketRequest & { socketId: string } }
  | { type: 'service-ws-send'; payload: { socketId: string; data: ServiceSocketData } | { socketId: string; received: number } }
  | { type: 'service-ws-close'; payload: { socketId: string; code?: number; reason?: string } };
export type HostServiceSocketMessage =
  | { type: 'service-ws-open'; payload: { socketId: string; protocol: string } }
  | { type: 'service-ws-message'; payload: { socketId: string; data: ServiceSocketData } | { socketId: string; sent: number } }
  | { type: 'service-ws-closed'; payload: { socketId: string; code: number; reason: string; wasClean: boolean; error?: HostRequestErrorCode } };

export const serviceSocketDataSize = (data: ServiceSocketData): number => typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data.byteLength;
export const isServiceSocketPath = (path: string): boolean => isGuestRequestPath(path) && !path.startsWith('//') && !/[?#\r\n]/.test(path);
export const isServiceSocketRequest = (request: GuestServiceSocketRequest): boolean => (
  isServiceSocketPath(request.path)
  && (!request.query || (Object.keys(request.query).length <= 32 && Object.entries(request.query).every(([key, value]) => key.length > 0 && key.length <= 128 && typeof value === 'string' && value.length <= 2000)))
  && (!request.protocols || (request.protocols.length <= 16 && new Set(request.protocols).size === request.protocols.length && request.protocols.every((value) => /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/.test(value))))
);
export const isServiceSocketCloseCode = (code: number): boolean => code === 1000 || (Number.isInteger(code) && code >= 3000 && code <= 4999);

/** A WebSocket-shaped channel carried by the host. It never dials from the iframe. */
export class GuestServiceSocket extends EventTarget {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readonly url: string;
  readonly extensions = '';
  readyState = 0;
  bufferedAmount = 0;
  protocol = '';
  binaryType: BinaryType = 'arraybuffer';
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  errorCode?: HostRequestErrorCode;
  private timer: ReturnType<typeof setTimeout> | null;

  constructor(
    readonly socketId: string,
    request: GuestServiceSocketRequest,
    private readonly post: (message: GuestMessage, transfer?: Transferable[]) => void,
    private readonly retire: () => void,
    timeoutMs: number,
  ) {
    super();
    this.url = `service:${request.path}`;
    this.timer = setTimeout(() => this.fail('HOST_TIMEOUT'), timeoutMs);
    this.postMessage({ type: 'service-ws-open', payload: { ...request, socketId } });
  }

  private postMessage(message: GuestServiceSocketMessage, transfer?: Transferable[]): void {
    this.post({ channel: OPENCHAMBER_SDK_CHANNEL, v: OPENCHAMBER_SDK_API_VERSION, ...message }, transfer);
  }

  send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void {
    if (this.readyState === this.CONNECTING) throw new DOMException('The service socket is connecting.', 'InvalidStateError');
    if (this.readyState !== this.OPEN) return;
    // Blob conversion is async and would reorder the RFB stream. Binary views
    // and ArrayBuffers cover streaming clients such as noVNC.
    if (data instanceof Blob) throw new TypeError('Service sockets accept strings, ArrayBuffers and typed arrays.');
    const payload = typeof data === 'string' ? data : ArrayBuffer.isView(data)
      ? new Uint8Array(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
      : new Uint8Array(new Uint8Array(data));
    const size = serviceSocketDataSize(payload);
    if (size > GUEST_SERVICE_SOCKET_FRAME_MAX || this.bufferedAmount + size > GUEST_SERVICE_SOCKET_BUFFER_MAX) {
      this.fail('RESPONSE_TOO_LARGE');
      return;
    }
    this.bufferedAmount += size;
    this.postMessage({ type: 'service-ws-send', payload: { socketId: this.socketId, data: payload } }, typeof payload === 'string' ? undefined : [payload.buffer]);
  }

  close(code = 1000, reason = ''): void {
    if (!isServiceSocketCloseCode(code)) throw new DOMException('Invalid close code.', 'InvalidAccessError');
    if (new TextEncoder().encode(reason).byteLength > 123) throw new DOMException('Close reason exceeds 123 bytes.', 'SyntaxError');
    if (this.readyState >= this.CLOSING) return;
    this.readyState = this.CLOSING;
    this.clearTimer();
    this.postMessage({ type: 'service-ws-close', payload: { socketId: this.socketId, code, reason } });
    this.timer = setTimeout(() => this.finish(1006, '', false), 5000);
  }

  receive(message: HostServiceSocketMessage): void {
    if (this.readyState === this.CLOSED) return;
    if (message.type === 'service-ws-open') {
      if (this.readyState !== this.CONNECTING) return;
      this.clearTimer();
      this.readyState = this.OPEN;
      this.protocol = message.payload.protocol;
      const event = new Event('open');
      this.dispatchEvent(event);
      this.onopen?.(event);
    } else if (message.type === 'service-ws-message') {
      const payload = message.payload;
      if ('sent' in payload) {
        this.bufferedAmount = Math.max(0, this.bufferedAmount - payload.sent);
        return;
      }
      if (this.readyState !== this.OPEN) return;
      const bytes = payload.data;
      const size = serviceSocketDataSize(bytes);
      if (size > GUEST_SERVICE_SOCKET_FRAME_MAX) { this.fail('RESPONSE_TOO_LARGE'); return; }
      const data = typeof bytes === 'string' ? bytes : this.binaryType === 'blob' ? new Blob([bytes]) : bytes.buffer;
      const event = new MessageEvent('message', { data });
      try { this.dispatchEvent(event); this.onmessage?.(event); }
      finally { this.postMessage({ type: 'service-ws-send', payload: { socketId: this.socketId, received: size } }); }
    } else {
      this.errorCode = message.payload.error;
      if (this.errorCode) this.emitError();
      this.finish(message.payload.code, message.payload.reason, message.payload.wasClean);
    }
  }

  fail(code: HostRequestErrorCode): void {
    if (this.readyState === this.CLOSED) return;
    this.errorCode = code;
    this.postMessage({ type: 'service-ws-close', payload: { socketId: this.socketId } });
    this.emitError();
    this.finish(1006, code, false);
  }

  private emitError(): void { const event = new Event('error'); this.dispatchEvent(event); this.onerror?.(event); }
  private clearTimer(): void { if (this.timer !== null) clearTimeout(this.timer); this.timer = null; }
  private finish(code: number, reason: string, wasClean: boolean): void {
    this.clearTimer();
    this.readyState = this.CLOSED;
    this.bufferedAmount = 0;
    this.retire();
    const event = new CloseEvent('close', { code, reason, wasClean });
    this.dispatchEvent(event);
    this.onclose?.(event);
  }
}

export const isHostServiceSocketMessage = (message: HostMessage): message is HostMessage & HostServiceSocketMessage => (
  message.type === 'service-ws-open' || message.type === 'service-ws-message' || message.type === 'service-ws-closed'
);
