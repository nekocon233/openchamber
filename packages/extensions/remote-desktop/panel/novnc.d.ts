declare module '@novnc/novnc' {
  import type { GuestServiceSocket } from '@openchamber/sdk';
  type RfbEvents = {
    connect: Event;
    disconnect: CustomEvent<{ clean: boolean }>;
    clipboard: CustomEvent<{ text: string }>;
    securityfailure: CustomEvent<{ status: number; reason?: string }>;
    credentialsrequired: CustomEvent<{ types: string[] }>;
  };
  export default class RFB {
    constructor(target: HTMLElement, channel: GuestServiceSocket, options?: { credentials?: { password: string }; shared?: boolean });
    scaleViewport: boolean;
    resizeSession: boolean;
    focusOnClick: boolean;
    addEventListener<K extends keyof RfbEvents>(type: K, listener: (event: RfbEvents[K]) => void): void;
    disconnect(): void;
    focus(): void;
    sendCredentials(credentials: { password: string }): void;
    sendCtrlAltDel(): void;
    sendKey(keysym: number, code?: string, down?: boolean): void;
    clipboardPasteFrom(text: string): void;
  }
}
