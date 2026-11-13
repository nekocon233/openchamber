import RFB from '@novnc/novnc';
import { remoteModifierKey, sendPasteKeys } from './clipboard-keys.ts';
import { GUEST_CLIPBOARD_TEXT_MAX, connectHost, type HostReadyContext, type GuestServiceSocket } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import { translate, type TextKey } from './i18n.ts';
import { readDesktopStatus, readSession, readFailure, type DesktopStatus } from './model.ts';

const host = connectHost();
const root = document.querySelector<HTMLElement>('#root');
if (!root) throw new Error('Missing extension root');
const element = (tag: string, className: string): HTMLElement => { const node = document.createElement(tag); node.className = className; return node; };
const viewport = element('div', 'viewport'); viewport.dir = 'ltr'; viewport.tabIndex = 0;
const empty = element('div', 'empty');
const emptyContent = element('div', 'empty-content'); emptyContent.setAttribute('role', 'status'); emptyContent.setAttribute('aria-live', 'polite');
const description = document.createElement('p');
const installTitle = document.createElement('p');
const installCommands = document.createElement('pre'); installCommands.dir = 'ltr';
emptyContent.append(description, installTitle, installCommands); empty.append(emptyContent);
root.append(viewport, empty);

let context: HostReadyContext | null = null;
let locale = 'en';
let desktopStatus: DesktopStatus | null = null;
let rfb: RFB | null = null;
let socket: GuestServiceSocket | null = null;
let state: 'loading' | 'connecting' | 'connected' | 'disconnected' = 'loading';
let failure: TextKey | null = null;
let generation = 0;
let initialized = false;
let resumeWhenVisible = false;
let viewportVisible = true;
let pasteWithShift = false;
let publishedSignature = '';
const heldModifiers = new Map<string, ReturnType<typeof remoteModifierKey>>();
const t = (key: TextKey) => translate(locale, key);

function publishHeaderControl(missingCount: number): void {
  if (!context?.features?.statusControls) return;
  const connected = state === 'connected';
  const controls = [{
    kind: 'button' as const,
    id: 'connection',
    label: t(connected ? 'disconnect' : 'connect'),
    disabled: !context.features?.serviceSockets || state === 'loading' || state === 'connecting' || (!connected && missingCount > 0),
  }];
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
  publishHeaderControl(missing.length);
}

function disconnect(resume = false): void {
  resumeWhenVisible = resume;
  generation += 1;
  heldModifiers.clear();
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

async function connect(): Promise<void> {
  if (!viewportVisible || document.hidden) { resumeWhenVisible = true; return; }
  disconnect();
  const current = generation;
  state = 'connecting'; failure = null; render();
  try {
    const bounds = viewport.getBoundingClientRect();
    const result = await host.serviceRequest({
      method: 'POST',
      path: '/session/start',
      body: JSON.stringify({
        width: Math.max(320, Math.min(4096, Math.round(bounds.width))),
        height: Math.max(200, Math.min(4096, Math.round(bounds.height))),
      }),
    });
    if (current !== generation) return;
    if (result.status !== 200) { failure = readFailure(result.body); state = 'disconnected'; render(); return; }
    const session = readSession(result.body);
    const channel = host.openServiceSocket({ path: '/rfb', query: { session: session.id }, protocols: ['binary'] }); socket = channel;
    const client = new RFB(viewport, channel, { credentials: { password: session.password }, shared: true }); rfb = client;
    client.scaleViewport = true; client.resizeSession = true; client.focusOnClick = true;
    client.addEventListener('connect', () => { if (current !== generation) return; state = 'connected'; failure = null; render(); client.focus(); void refresh().then(render).catch(() => {}); });
    client.addEventListener('disconnect', ({ detail }) => {
      if (current !== generation) return;
      rfb = null; socket = null; state = 'disconnected';
      if (!detail.clean) failure = 'START_FAILED'; render();
    });
    client.addEventListener('securityfailure', () => { if (current === generation) { failure = 'START_FAILED'; render(); } });
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
  } catch { if (current === generation) { disconnect(); failure = 'START_FAILED'; render(); } }
}

function pasteClipboard(text: string, withShift = false): void {
  if (!rfb || state !== 'connected') return;
  if (text.length > GUEST_CLIPBOARD_TEXT_MAX) {
    void host.toast({ kind: 'error', message: t('clipboardLimit') }).catch(() => {});
    return;
  }
  rfb.clipboardPasteFrom(text);
  sendPasteKeys(rfb, withShift, [...heldModifiers.values()]);
  rfb.focus();
}

host.onStatusControl(({ id }) => {
  if (id !== 'connection') return;
  if (rfb || state === 'connecting') { failure = null; disconnect(); }
  else void connect();
});

// The iframe cannot read the OS clipboard directly. A real paste supplies
// text; capture the chord so noVNC cannot paste the previous remote value first.
document.addEventListener('keydown', (event) => {
  if (viewport.contains(document.activeElement) && /^(Meta|Control|Shift|Alt)(Left|Right)$/.test(event.code)) heldModifiers.set(event.code, remoteModifierKey(event.code, /Mac|iPhone|iPad/.test(navigator.platform)));
  if (rfb && viewport.contains(document.activeElement) && (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'v') { pasteWithShift = event.shiftKey; event.stopImmediatePropagation(); }
}, true);
document.addEventListener('keyup', (event) => { heldModifiers.delete(event.code); }, true);
window.addEventListener('blur', () => heldModifiers.clear());
viewport.addEventListener('focusout', () => heldModifiers.clear());
document.addEventListener('paste', (event) => {
  if (!rfb || !viewport.contains(document.activeElement)) return;
  const text = event.clipboardData?.getData('text/plain');
  if (text !== undefined) { event.preventDefault(); event.stopImmediatePropagation(); pasteClipboard(text, pasteWithShift); pasteWithShift = false; }
}, true);
const visibilityChanged = () => {
  const viewing = viewportVisible && !document.hidden;
  if (!viewing && (rfb || state === 'connecting')) disconnect(true);
  else if (viewing && resumeWhenVisible) { resumeWhenVisible = false; void connect(); }
};
const visibility = new IntersectionObserver(([entry]) => { viewportVisible = Boolean(entry?.isIntersecting); visibilityChanged(); });
visibility.observe(viewport);
document.addEventListener('visibilitychange', visibilityChanged);
window.addEventListener('pagehide', () => { visibility.disconnect(); document.removeEventListener('visibilitychange', visibilityChanged); disconnect(); host.dispose(); }, { once: true });
host.onReady((next) => {
  context = next; locale = next.locale; publishedSignature = '';
  applyHostReady(next, document.documentElement);
  document.documentElement.lang = locale;
  document.documentElement.dir = locale === 'ar' || locale === 'he' ? 'rtl' : 'ltr';
  render();
  if (initialized) return;
  initialized = true;
  if (!next.features?.serviceSockets || !next.features?.statusControls) { failure = 'unsupportedHost'; state = 'disconnected'; render(); return; }
  void (async () => {
    await refresh();
    state = 'disconnected'; render();
    if (desktopStatus?.session?.ready) await connect();
  })().catch(() => { failure = 'START_FAILED'; state = 'disconnected'; render(); });
});
