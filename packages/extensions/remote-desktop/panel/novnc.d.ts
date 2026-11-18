declare module '@novnc/novnc' {
  import type { GuestServiceSocket } from '@openchamber/sdk';
  type RfbEvents = {
    connect: Event;
    disconnect: CustomEvent<{ clean: boolean }>;
    clipboard: CustomEvent<{ text: string }>;
    securityfailure: CustomEvent<{ status: number; reason?: string }>;
    credentialsrequired: CustomEvent<{ types: string[] }>;
  };
  export type RfbScreenSize = { w: number; h: number };
  export default class RFB {
    constructor(target: HTMLElement, channel: GuestServiceSocket, options?: { credentials?: { password: string }; shared?: boolean });
    scaleViewport: boolean;
    clipViewport: boolean;
    dragViewport: boolean;
    resizeSession: boolean;
    focusOnClick: boolean;
    background: string;
    protected _requestRemoteResize(): void;
    protected _screenSize(): RfbScreenSize;
    addEventListener<K extends keyof RfbEvents>(type: K, listener: (event: RfbEvents[K]) => void): void;
    disconnect(): void;
    focus(): void;
    sendCredentials(credentials: { password: string }): void;
    sendCtrlAltDel(): void;
    sendKey(keysym: number, code?: string | null, down?: boolean): void;
    clipboardPasteFrom(text: string): void;
  }
}
