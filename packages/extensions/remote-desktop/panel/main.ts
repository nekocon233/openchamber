import RFB, { type RfbScreenSize } from '@novnc/novnc';
import { remoteModifierKey, sendPasteKeys } from './clipboard-keys.ts';
import { GUEST_CLIPBOARD_TEXT_MAX, connectHost, type HostReadyContext, type GuestServiceSocket, type GuestStatusControl, type JsonValue } from '@openchamber/sdk';
import { applyHostReady, mountButton, mountSelect } from '@openchamber/sdk/ui';
import { translate, type TextKey } from './i18n.ts';
import {
  displayRatioOptions,
  readDesktopStatus,
  readDesktopUrlItem,
  readDisplayRatio,
  readFailure,
  readSession,
  resolveSessionSize,
  targetDesktopResolution,
  type DesktopDisplayRatio,
  type DesktopDisplayResolution,
  type DesktopStatus,
} from './model.ts';
import { bindSoftKeyboardInput, resetSoftKeyboardBuffer } from './soft-keyboard.ts';

const DISPLAY_RATIO_STORAGE_KEY = 'displayRatio';

class DesktopRFB extends RFB {
  private targetSize: DesktopDisplayResolution | null;
  private readingRemoteTarget = false;

  constructor(
    target: HTMLElement,
    channel: GuestServiceSocket,
    options: { credentials?: { password: string }; shared?: boolean },
    targetSize: DesktopDisplayResolution | null,
  ) {
    super(target, channel, options);
    this.targetSize = targetSize;
  }

  setTargetDesktopSize(size: DesktopDisplayResolution | null): void {
    this.targetSize = size;
    if (this.resizeSession) this._requestRemoteResize();
  }

  protected override _requestRemoteResize(): void {
    this.readingRemoteTarget = true;
    try {
      super._requestRemoteResize();
    } finally {
      this.readingRemoteTarget = false;
    }
  }

  protected override _screenSize(): RfbScreenSize {
    if (this.readingRemoteTarget && this.targetSize) {
      return { w: this.targetSize.width, h: this.targetSize.height };
    }
    return super._screenSize();
  }
}

const host = connectHost();
const root = document.querySelector<HTMLElement>('#root');
if (!root) throw new Error('Missing extension root');
const element = (tag: string, className: string): HTMLElement => { const node = document.createElement(tag); node.className = className; return node; };
const toolbar = element('div', 'toolbar'); toolbar.hidden = true;
const stage = element('div', 'stage');
const viewport = element('div', 'viewport'); viewport.dir = 'ltr'; viewport.tabIndex = 0;
const touchKeyboardSlot = element('div', 'touch-keyboard-pill'); touchKeyboardSlot.hidden = true;
const keyboardInput = document.createElement('textarea');
keyboardInput.className = 'soft-keyboard';
keyboardInput.rows = 1;
keyboardInput.tabIndex = -1;
keyboardInput.setAttribute('autocapitalize', 'none');
keyboardInput.setAttribute('autocomplete', 'off');
keyboardInput.setAttribute('autocorrect', 'off');
keyboardInput.setAttribute('spellcheck', 'false');
keyboardInput.setAttribute('aria-hidden', 'true');
const empty = element('div', 'empty');
const emptyContent = element('div', 'empty-content'); emptyContent.setAttribute('role', 'status'); emptyContent.setAttribute('aria-live', 'polite');
const description = document.createElement('p');
const installTitle = document.createElement('p');
const installCommands = document.createElement('pre'); installCommands.dir = 'ltr';
emptyContent.append(description, installTitle, installCommands); empty.append(emptyContent);
stage.append(viewport, empty, touchKeyboardSlot);
root.append(toolbar, stage, keyboardInput);

let context: HostReadyContext | null = null;
let locale = 'en';
let desktopStatus: DesktopStatus | null = null;
let rfb: DesktopRFB | null = null;
let socket: GuestServiceSocket | null = null;
let state: 'loading' | 'connecting' | 'connected' | 'disconnected' = 'loading';
let failure: TextKey | null = null;
let generation = 0;
let initialized = false;
let resumeWhenVisible = false;
let viewportVisible = true;
let pasteWithShift = false;
let publishedSignature = '';
let displayRatio: DesktopDisplayRatio = 'auto';
let ratioChangedByUser = false;
let panViewport = false;
let keyboardOpen = false;
let touchDetected = false;
let viewportTouching = false;
let pendingKeyboardOpen: boolean | null = null;
let keyboardTogglePressing = false;
let keyboardToggleReleaseTimer: ReturnType<typeof setTimeout> | null = null;
let pendingOpenRequest: { id: string; url: string } | null = null;
let lastHandledItemId: string | null = null;
let openInFlight = false;
const heldModifiers = new Map<string, ReturnType<typeof remoteModifierKey>>();
const t = (key: TextKey) => translate(locale, key);

const clearKeyboardTogglePress = (): void => {
  if (keyboardToggleReleaseTimer) {
    clearTimeout(keyboardToggleReleaseTimer);
    keyboardToggleReleaseTimer = null;
  }
  keyboardTogglePressing = false;
  pendingKeyboardOpen = null;
};

const wireKeyboardTriggerSlot = (slot: HTMLElement): void => {
  const beginPress = () => {
    if (pendingKeyboardOpen === null) pendingKeyboardOpen = !keyboardOpen;
    keyboardTogglePressing = true;
    if (keyboardToggleReleaseTimer) clearTimeout(keyboardToggleReleaseTimer);
    keyboardToggleReleaseTimer = setTimeout(() => {
      clearKeyboardTogglePress();
      if (keyboardOpen && document.activeElement !== keyboardInput && !viewportTouching) {
        keyboardOpen = false;
        if (rfb) rfb.focusOnClick = true;
        render();
      }
    }, 400);
  };
  slot.addEventListener('mousedown', (event) => { event.preventDefault(); beginPress(); }, true);
  slot.addEventListener('pointerdown', beginPress, true);
  slot.addEventListener('touchstart', beginPress, { capture: true, passive: true });
  slot.addEventListener('pointercancel', clearKeyboardTogglePress, true);
  slot.addEventListener('touchcancel', clearKeyboardTogglePress, { capture: true, passive: true });
};

const viewportSize = () => {
  const bounds = viewport.getBoundingClientRect();
  return {
    width: Math.max(320, Math.min(4096, Math.round(bounds.width))),
    height: Math.max(200, Math.min(4096, Math.round(bounds.height))),
  };
};
const desiredTargetResolution = () => targetDesktopResolution(displayRatio, viewportSize(), panViewport);
const desiredSessionSize = () => resolveSessionSize(displayRatio, viewportSize(), panViewport);

function applyViewportMode(): void {
  if (!rfb) return;
  const target = desiredTargetResolution();
  if (panViewport) {
    rfb.setTargetDesktopSize(target);
    rfb.scaleViewport = false;
    rfb.clipViewport = true;
    rfb.dragViewport = true;
    return;
  }
  rfb.dragViewport = false;
  rfb.clipViewport = false;
  rfb.scaleViewport = true;
  rfb.setTargetDesktopSize(target);
}

function setSoftKeyboardOpen(open: boolean): void {
  const next = open && state === 'connected';
  keyboardOpen = next;
  if (rfb) rfb.focusOnClick = !next;
  if (next) {
    resetSoftKeyboardBuffer(keyboardInput);
    keyboardInput.focus({ preventScroll: true });
  } else {
    keyboardInput.blur();
    if (state === 'connected') rfb?.focus();
  }
  render();
}

function changeDisplayRatio(value: JsonValue | undefined): void {
  ratioChangedByUser = true;
  displayRatio = readDisplayRatio(value);
  void host.storage.set(DISPLAY_RATIO_STORAGE_KEY, displayRatio).catch(() => {});
  applyViewportMode();
  render();
}

function togglePanViewport(): void {
  if (state !== 'connected') return;
  panViewport = !panViewport;
  applyViewportMode();
  render();
}

function activateKeyboardButton(): void {
  const nextOpen = pendingKeyboardOpen ?? !keyboardOpen;
  clearKeyboardTogglePress();
  if (state !== 'connected') return;
  setSoftKeyboardOpen(nextOpen);
}

function toggleConnection(): void {
  if (rfb || state === 'connecting') { pendingOpenRequest = null; failure = null; disconnect(); }
  else void connect();
}

const ratioSelect = mountSelect(toolbar, {
  value: displayRatio,
  options: displayRatioOptions(t('ratioAuto')).map((option) => ({ id: option.value, label: option.label })),
  disabled: true,
  onChange: (id) => changeDisplayRatio(id),
});
const panSlot = element('div', 'toolbar-slot');
panSlot.addEventListener('mousedown', (event) => event.preventDefault(), true);
toolbar.append(panSlot);
const panButton = mountButton(panSlot, {
  label: t('panView'),
  variant: 'outline',
  size: 'sm',
  disabled: true,
  onClick: togglePanViewport,
});
const keyboardSlot = element('div', 'toolbar-slot');
wireKeyboardTriggerSlot(keyboardSlot);
toolbar.append(keyboardSlot);
const keyboardButton = mountButton(keyboardSlot, {
  label: t('showKeyboard'),
  variant: 'outline',
  size: 'sm',
  disabled: true,
  onClick: activateKeyboardButton,
});
const connectionSlot = element('div', 'toolbar-slot');
toolbar.append(connectionSlot);
const connectionButton = mountButton(connectionSlot, {
  label: t('connect'),
  variant: 'outline',
  size: 'sm',
  disabled: true,
  onClick: toggleConnection,
});
wireKeyboardTriggerSlot(touchKeyboardSlot);
const floatingKeyboardButton = mountButton(touchKeyboardSlot, {
  label: t('showKeyboard'),
  variant: 'outline',
  size: 'sm',
  disabled: true,
  onClick: activateKeyboardButton,
});

async function handleUnsupportedFallback(url: string, dismiss = true): Promise<void> {
  await host.openUrl(url).catch(() => {});
  if (dismiss) await host.close().catch(() => {});
}

function publishControls(missingCount: number): void {
  const hasHostHeader = Boolean(context?.features?.statusControls);
  const hasSockets = Boolean(context?.features?.serviceSockets);
  const connected = state === 'connected';
  const unavailable = !hasSockets || state === 'loading' || (!connected && missingCount > 0);
  const ratioItems = displayRatioOptions(t('ratioAuto'));
  const panLabel = t(panViewport ? 'fitView' : 'panView');
  const keyboardLabel = t(keyboardOpen ? 'hideKeyboard' : 'showKeyboard');
  const connectionLabel = t(connected ? 'disconnect' : 'connect');

  toolbar.hidden = !context || hasHostHeader || !hasSockets;
  touchKeyboardSlot.hidden = !(hasHostHeader && hasSockets && touchDetected && connected);

  if (!toolbar.hidden) {
    ratioSelect.update({
      value: displayRatio,
      options: ratioItems.map((option) => ({ id: option.value, label: option.label })),
      disabled: unavailable,
    });
    panButton.update({ label: panLabel, disabled: !connected });
    keyboardButton.update({ label: keyboardLabel, disabled: !connected });
    connectionButton.update({ label: connectionLabel, disabled: unavailable || state === 'connecting' });
  }
  if (!touchKeyboardSlot.hidden) {
    floatingKeyboardButton.update({ label: keyboardLabel, disabled: !connected });
  }
  if (!hasHostHeader) return;

  const controls: GuestStatusControl[] = [
    {
      kind: 'select',
      id: 'ratio',
      label: t('ratioLabel'),
      value: displayRatio,
      options: ratioItems,
      disabled: unavailable,
    },
  ];
  if (touchDetected) {
    controls.push({
      kind: 'button',
      id: 'pan',
      label: panLabel,
      disabled: !connected,
    });
  }
  controls.push({
    kind: 'button',
    id: 'connection',
    label: connectionLabel,
    disabled: unavailable || state === 'connecting',
  });
  const signature = JSON.stringify(controls);
  if (signature === publishedSignature) return;
  publishedSignature = signature;
  void host.setStatusControls(controls).catch(() => { publishedSignature = ''; });
}

function render(): void {
  const missing = desktopStatus?.missing ?? [];
  empty.hidden = state === 'connected';
  emptyContent.dataset.error = String(Boolean(failure || missing.length));
  description.textContent = failure
    ? t(failure)
    : missing.length
      ? missing.map(t).join(' ')
      : state === 'loading' || state === 'connecting'
        ? t(state)
        : t('choose');
  const showInstall = !failure && missing.some((key) => ['NO_VIRTUAL_SERVER', 'NO_PASSWORD_TOOL', 'NO_DESKTOP'].includes(key));
  installTitle.textContent = t('install'); installTitle.hidden = !showInstall; installCommands.hidden = !showInstall;
  installCommands.textContent = Object.values(desktopStatus?.install ?? {}).join('\n\n');
  publishControls(missing.length);
}

function disconnect(resume = false): void {
  resumeWhenVisible = resume;
  generation += 1;
  heldModifiers.clear();
  keyboardOpen = false;
  if (!resume) panViewport = false;
  keyboardInput.blur();
  const previous = rfb; rfb = null;
  const channel = socket; socket = null;
  previous?.disconnect(); channel?.close();
  viewport.replaceChildren(); state = 'disconnected';
  render();
}

async function refresh(): Promise<void> {
  const result = await host.serviceRequest({ method: 'GET', path: '/status' });
  if (result.status !== 200) throw new Error('Desktop status request failed');
  desktopStatus = readDesktopStatus(result.body);
}

async function openUrlOnConnectedDesktop(url: string): Promise<void> {
  openInFlight = true;
  try {
    const result = await host.serviceRequest({
      method: 'POST',
      path: '/session/open-url',
      body: JSON.stringify({ url, ...desiredSessionSize() }),
    });
    if (result.status !== 200) {
      const code = readFailure(result.body, 'BROWSER_FAILED');
      if (code === 'UNSUPPORTED') {
        await handleUnsupportedFallback(url);
        return;
      }
      void host.toast({ kind: 'error', message: t(code) }).catch(() => {});
      await handleUnsupportedFallback(url, false);
      return;
    }
    if (keyboardOpen) keyboardInput.focus({ preventScroll: true });
    else rfb?.focus();
  } catch {
    void host.toast({ kind: 'error', message: t('BROWSER_FAILED') }).catch(() => {});
    await handleUnsupportedFallback(url, false);
  } finally {
    openInFlight = false;
    if (pendingOpenRequest) void processPendingOpen();
  }
}

async function processPendingOpen(): Promise<void> {
  if (!pendingOpenRequest || !initialized || state === 'loading' || state === 'connecting' || openInFlight) return;
  if (!context?.features?.serviceSockets || !context?.features?.statusControls) {
    const request = pendingOpenRequest;
    pendingOpenRequest = null;
    await handleUnsupportedFallback(request.url, false);
    return;
  }
  const missing = desktopStatus?.missing ?? [];
  if (missing.length > 0) {
    const request = pendingOpenRequest;
    pendingOpenRequest = null;
    await handleUnsupportedFallback(request.url, missing.includes('UNSUPPORTED'));
    return;
  }
  if (!viewportVisible || document.hidden) {
    resumeWhenVisible = true;
    return;
  }
  const request = pendingOpenRequest;
  pendingOpenRequest = null;
  if (state === 'connected' && rfb) {
    await openUrlOnConnectedDesktop(request.url);
    return;
  }
  await connect(request.url);
}

async function connect(openUrl?: string): Promise<void> {
  if (!viewportVisible || document.hidden) { resumeWhenVisible = true; return; }
  disconnect(resumeWhenVisible);
  const current = generation;
  state = 'connecting'; failure = null; render();
  try {
    const size = desiredSessionSize();
    const result = await host.serviceRequest({
      method: 'POST',
      path: openUrl ? '/session/open-url' : '/session/start',
      body: JSON.stringify(openUrl ? { url: openUrl, ...size } : size),
    });
    if (current !== generation) return;
    if (result.status !== 200) {
      const code = readFailure(result.body);
      pendingOpenRequest = null;
      failure = code;
      state = 'disconnected';
      render();
      if (openUrl) await handleUnsupportedFallback(openUrl, code === 'UNSUPPORTED');
      return;
    }
    const session = readSession(result.body);
    const channel = host.openServiceSocket({ path: '/rfb', query: { session: session.id }, protocols: ['binary'] }); socket = channel;
    const client = new DesktopRFB(viewport, channel, { credentials: { password: session.password }, shared: true }, desiredTargetResolution()); rfb = client;
    client.background = 'var(--oc-background)'; client.resizeSession = true; client.focusOnClick = !keyboardOpen;
    applyViewportMode();
    client.addEventListener('connect', () => {
      if (current !== generation) return;
      state = 'connected'; failure = null; applyViewportMode(); render();
      if (keyboardOpen) keyboardInput.focus({ preventScroll: true });
      else client.focus();
      void refresh().then(render).catch(() => {});
      if (pendingOpenRequest) void processPendingOpen();
    });
    client.addEventListener('disconnect', ({ detail }) => {
      if (current !== generation) return;
      rfb = null; socket = null; state = 'disconnected'; keyboardOpen = false; keyboardInput.blur();
      if (!detail.clean) { pendingOpenRequest = null; failure = 'START_FAILED'; }
      render();
    });
    client.addEventListener('securityfailure', () => { if (current === generation) { pendingOpenRequest = null; failure = 'START_FAILED'; render(); } });
    client.addEventListener('clipboard', ({ detail }) => {
      if (current !== generation) return;
      const text = detail.text;
      if (text.length > GUEST_CLIPBOARD_TEXT_MAX) {
        void host.toast({ kind: 'error', message: t('clipboardLimit') }).catch(() => {});
        return;
      }
      if (text) void host.writeClipboard(text).catch(() => {
        if (current === generation) void host.toast({ kind: 'error', message: t('clipboardFailed') }).catch(() => {});
      });
    });
  } catch { if (current === generation) { pendingOpenRequest = null; disconnect(); failure = 'START_FAILED'; render(); } }
}

function pasteClipboard(text: string, withShift = false): void {
  if (!rfb || state !== 'connected') return;
  if (text.length > GUEST_CLIPBOARD_TEXT_MAX) {
    void host.toast({ kind: 'error', message: t('clipboardLimit') }).catch(() => {});
    return;
  }
  rfb.clipboardPasteFrom(text);
  sendPasteKeys(rfb, withShift, [...heldModifiers.values()]);
  if (keyboardOpen) keyboardInput.focus({ preventScroll: true });
  else rfb.focus();
}

const unbindSoftKeyboard = bindSoftKeyboardInput(keyboardInput, {
  isConnected: () => Boolean(rfb && state === 'connected'),
  sendKey: (keysym, code, down) => rfb?.sendKey(keysym, code, down),
  onDismiss: () => {
    if (!keyboardOpen) return;
    keyboardOpen = false;
    if (rfb) rfb.focusOnClick = true;
    render();
  },
  shouldRetainFocus: () => viewportTouching || keyboardTogglePressing,
});

host.onStatusControl(({ id, value }) => {
  if (id === 'ratio') {
    changeDisplayRatio(value);
    return;
  }
  if (id === 'pan') {
    togglePanViewport();
    return;
  }
  if (id !== 'connection') return;
  toggleConnection();
});

host.onItem((item) => {
  const request = readDesktopUrlItem(item);
  if (!request || request.id === lastHandledItemId) return;
  lastHandledItemId = request.id;
  pendingOpenRequest = request;
  void processPendingOpen();
});

viewport.addEventListener('touchstart', () => {
  viewportTouching = true;
  if (!touchDetected) {
    touchDetected = true;
    render();
  }
}, { capture: true, passive: true });
viewport.addEventListener('touchend', (event) => {
  viewportTouching = event.touches.length > 0;
  if (!viewportTouching && keyboardOpen && state === 'connected') {
    keyboardInput.focus({ preventScroll: true });
  }
}, { capture: true, passive: true });
viewport.addEventListener('touchcancel', (event) => {
  viewportTouching = event.touches.length > 0;
}, { capture: true, passive: true });

// The iframe cannot read the OS clipboard directly. A real paste supplies
// text; capture the chord so noVNC cannot paste the previous remote value first.
document.addEventListener('keydown', (event) => {
  const activeInDesktop = viewport.contains(document.activeElement) || document.activeElement === keyboardInput;
  if (activeInDesktop && /^(Meta|Control|Shift|Alt)(Left|Right)$/.test(event.code)) heldModifiers.set(event.code, remoteModifierKey(event.code, /Mac|iPhone|iPad/.test(navigator.platform)));
  if (rfb && activeInDesktop && (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'v') { pasteWithShift = event.shiftKey; event.stopImmediatePropagation(); }
}, true);
document.addEventListener('keyup', (event) => { heldModifiers.delete(event.code); }, true);
window.addEventListener('blur', () => heldModifiers.clear());
viewport.addEventListener('focusout', () => heldModifiers.clear());
document.addEventListener('paste', (event) => {
  const activeInDesktop = viewport.contains(document.activeElement) || document.activeElement === keyboardInput;
  if (!rfb || !activeInDesktop) return;
  const text = event.clipboardData?.getData('text/plain');
  if (text !== undefined) { event.preventDefault(); event.stopImmediatePropagation(); pasteClipboard(text, pasteWithShift); pasteWithShift = false; }
}, true);

const viewportResize = new ResizeObserver(() => {
  if (rfb && panViewport && displayRatio === 'auto') {
    rfb.setTargetDesktopSize(desiredTargetResolution());
  }
});
viewportResize.observe(viewport);

const visibilityChanged = () => {
  const viewing = viewportVisible && !document.hidden;
  if (!viewing && (rfb || state === 'connecting')) disconnect(true);
  else if (viewing && pendingOpenRequest) { resumeWhenVisible = false; void processPendingOpen(); }
  else if (viewing && resumeWhenVisible) { resumeWhenVisible = false; void connect(); }
};
const visibility = new IntersectionObserver(([entry]) => { viewportVisible = Boolean(entry?.isIntersecting); visibilityChanged(); });
visibility.observe(viewport);
document.addEventListener('visibilitychange', visibilityChanged);
window.addEventListener('pagehide', () => {
  clearKeyboardTogglePress();
  unbindSoftKeyboard();
  ratioSelect.dispose();
  panButton.dispose();
  keyboardButton.dispose();
  connectionButton.dispose();
  floatingKeyboardButton.dispose();
  viewportResize.disconnect();
  visibility.disconnect();
  document.removeEventListener('visibilitychange', visibilityChanged);
  disconnect();
  host.dispose();
}, { once: true });
host.onReady((next) => {
  context = next; locale = next.locale; publishedSignature = '';
  applyHostReady(next, document.documentElement);
  document.documentElement.lang = locale;
  document.documentElement.dir = locale === 'ar' || locale === 'he' ? 'rtl' : 'ltr';
  render();
  if (initialized) return;
  initialized = true;
  if (!next.features?.serviceSockets) {
    failure = 'unsupportedHost'; state = 'disconnected'; render();
    if (pendingOpenRequest) void processPendingOpen();
    return;
  }
  void (async () => {
    const [storedRatio] = await Promise.all([
      host.storage.get(DISPLAY_RATIO_STORAGE_KEY).catch(() => undefined),
      refresh(),
    ]);
    if (!ratioChangedByUser) displayRatio = readDisplayRatio(storedRatio);
    if (state === 'loading') state = 'disconnected';
    render();
    if (pendingOpenRequest) await processPendingOpen();
    else if (desktopStatus?.session?.ready && state === 'disconnected') await connect();
  })().catch(() => { pendingOpenRequest = null; failure = 'START_FAILED'; state = 'disconnected'; render(); });
});
