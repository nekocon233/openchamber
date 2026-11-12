import RFB from '@novnc/novnc';
import { remoteModifierKey, sendPasteKeys } from './clipboard-keys.ts';
import { GUEST_CLIPBOARD_TEXT_MAX, connectHost, type HostReadyContext, type GuestServiceSocket } from '@openchamber/sdk';
import { applyHostReady, mountButton, mountMenu, mountSelect, mountTextField } from '@openchamber/sdk/ui';
import { translate, type TextKey } from './i18n.ts';
import { readDesktopStatus, readSession, readFailure, type DesktopStatus, type Mode } from './model.ts';

const host = connectHost();
const root = document.querySelector<HTMLElement>('#root');
if (!root) throw new Error('Missing extension root');
const element = (tag: string, className: string): HTMLElement => { const node = document.createElement(tag); node.className = className; return node; };
const toolbar = element('div', 'toolbar');
const modeSlot = element('div', 'mode');
const displaySlot = element('div', 'display');
const connectSlot = element('div', 'connect');
const moreSlot = element('div', 'more');
const statusLine = element('div', 'status'); statusLine.setAttribute('role', 'status'); statusLine.setAttribute('aria-live', 'polite');
const viewport = element('div', 'viewport'); viewport.dir = 'ltr'; viewport.tabIndex = 0;
const empty = element('div', 'empty');
const emptyContent = element('div', 'empty-content');
const description = document.createElement('p');
const installTitle = document.createElement('p');
const installCommands = document.createElement('pre'); installCommands.dir = 'ltr';
emptyContent.append(description, installTitle, installCommands); empty.append(emptyContent);
const clipboard = element('section', 'clipboard oc-sdk oc-sdk-popup'); clipboard.hidden = true;
const clipboardHeader = element('div', 'row');
const clipboardTitle = document.createElement('span');
const clipboardClose = element('div', ''); clipboardHeader.append(clipboardTitle, clipboardClose);
const clipboardField = element('div', '');
const clipboardActions = element('div', 'row');
clipboard.append(clipboardHeader, clipboardField, clipboardActions);
const spacer = element('div', 'spacer');
toolbar.append(modeSlot, displaySlot, connectSlot, spacer, moreSlot);
root.append(toolbar, statusLine, viewport, empty, clipboard);

let context: HostReadyContext | null = null;
let locale = 'en';
let mode: Mode = 'physical';
let display = '';
let desktopStatus: DesktopStatus | null = null;
let rfb: RFB | null = null;
let socket: GuestServiceSocket | null = null;
let state: TextKey = 'loading';
let failure: TextKey | null = null;
let generation = 0;
let fitted = true;
let resize = false;
let sync = true;
let clipboardText = '';
let initialized = false;
let resumeWhenVisible = false;
let viewportVisible = true;
let pasteWithShift = false;
const heldModifiers = new Map<string, ReturnType<typeof remoteModifierKey>>();
const t = (key: TextKey) => translate(locale, key);
const modes = mountSelect(modeSlot, { value: mode, options: [], onChange: (next) => {
  if (next !== 'physical' && next !== 'virtual') return;
  disconnect(); mode = next; resize = mode === 'virtual'; failure = null; state = 'disconnected';
  void host.storage.set('desktop-mode', mode).catch(() => {});
  render();
} });
const displays = mountSelect(displaySlot, { value: display, options: [], onChange: (next) => { disconnect(); display = next; render(); } });
const connection = mountButton(connectSlot, { label: t('connect'), size: 'sm', onClick: () => { if (rfb) disconnect(); else void connect(); } });
const menu = mountMenu(moreSlot, { label: t('more'), size: 'sm', variant: 'ghost', items: [], onSelect: (id) => { void action(id); } });
const field = mountTextField(clipboardField, { label: t('clipboardLabel'), value: '', multiline: true, onChange: (value) => { clipboardText = value; field.update({ value }); if (value.length > GUEST_CLIPBOARD_TEXT_MAX) failure = 'clipboardLimit'; else if (failure === 'clipboardLimit') failure = null; render(); } });
const copy = mountButton(clipboardActions, { label: t('copy'), size: 'sm', variant: 'outline', onClick: () => { void copyClipboard(); } });
const paste = mountButton(clipboardActions, { label: t('send'), size: 'sm', onClick: () => pasteClipboard(clipboardText) });
const closeClipboard = mountButton(clipboardClose, { label: t('close'), size: 'sm', variant: 'ghost', onClick: () => { clipboard.hidden = true; } });

function render(): void {
  const missing = desktopStatus?.missing[mode] ?? [];
  const notice = failure ?? (missing.length ? missing[0]! : state);
  const text = t(notice);
  statusLine.textContent = text; statusLine.title = text; statusLine.dataset.error = String(Boolean(failure || missing.length));
  document.title = t(mode);
  modes.update({ label: t(mode), value: mode, options: [{ id: 'physical', label: t('physical') }, { id: 'virtual', label: t('virtual') }], disabled: state === 'connecting' });
  displaySlot.hidden = mode !== 'physical' || (desktopStatus?.displays.length ?? 0) < 2;
  displays.update({ label: display, value: display, options: (desktopStatus?.displays ?? []).map((item) => ({ id: item.display, label: item.display, hint: item.user })), disabled: state === 'connecting' });
  connection.update({ label: t(rfb ? 'disconnect' : 'connect'), disabled: !context?.features?.serviceSockets || state === 'loading' || state === 'connecting' || (!rfb && missing.length > 0) });
  empty.hidden = state === 'connected';
  description.textContent = failure ? t(failure) : missing.length ? missing.map(t).join(' ') : t('choose');
  const showInstall = missing.some((key) => ['NO_PHYSICAL_SERVER', 'NO_VIRTUAL_SERVER', 'NO_PASSWORD_TOOL', 'NO_DESKTOP'].includes(key));
  installTitle.textContent = t('install'); installTitle.hidden = !showInstall; installCommands.hidden = !showInstall;
  installCommands.textContent = Object.values(desktopStatus?.install ?? {}).join('\n\n');
  clipboardTitle.textContent = t('clipboard');
  clipboard.setAttribute('aria-label', t('clipboard'));
  field.update({ label: t('clipboardLabel') }); copy.update({ label: t('copy'), disabled: !clipboardText || clipboardText.length > GUEST_CLIPBOARD_TEXT_MAX }); paste.update({ label: t('send'), disabled: state !== 'connected' || clipboardText.length > GUEST_CLIPBOARD_TEXT_MAX }); closeClipboard.update({ label: t('close') });
  menu.update({ label: t('more'), items: [
    { id: 'fit', label: t('fit') + (fitted ? ' ✓' : '') },
    { id: 'resize', label: t('resize') + (resize ? ' ✓' : ''), disabled: !rfb },
    { id: 'sync', label: t('sync') + (sync ? ' ✓' : '') },
    { id: 'clipboard', label: t('clipboard') },
    { separator: true },
    { id: 'cad', label: 'Ctrl+Alt+Del', disabled: state !== 'connected' },
    { id: 'super', label: 'Super', disabled: state !== 'connected' },
    { id: 'tab', label: 'Alt+Tab', disabled: state !== 'connected' },
    ...(context?.surface === 'panel' && context.features?.pages ? [{ separator: true as const }, { id: 'expand', label: t('expand') }] : []),
    { separator: true },
    { id: 'stop', label: t('stop'), destructive: true, disabled: !desktopStatus?.sessions.some((item) => item.mode === 'virtual') },
  ] });
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
  if (!display || !desktopStatus.displays.some((item) => item.display === display)) display = desktopStatus.displays.find((item) => item.authorized)?.display ?? desktopStatus.displays[0]?.display ?? '';
}
async function connect(): Promise<void> {
  if (!viewportVisible || document.hidden) { resumeWhenVisible = true; return; }
  disconnect();
  const current = generation;
  state = 'connecting'; failure = null; render();
  try {
    const bounds = viewport.getBoundingClientRect();
    const result = await host.serviceRequest({ method: 'POST', path: '/session/start', body: JSON.stringify({ mode, display: mode === 'physical' && display ? display : undefined,
      width: Math.max(320, Math.min(4096, Math.round(bounds.width))), height: Math.max(200, Math.min(4096, Math.round(bounds.height))) }) });
    if (current !== generation) return;
    if (result.status !== 200) { failure = readFailure(result.body); state = 'disconnected'; render(); return; }
    const session = readSession(result.body);
    const channel = host.openServiceSocket({ path: '/rfb', query: { session: session.id }, protocols: ['binary'] }); socket = channel;
    const client = new RFB(viewport, channel, { credentials: { password: session.password }, shared: true }); rfb = client;
    client.scaleViewport = fitted; client.resizeSession = resize; client.focusOnClick = true;
    client.addEventListener('connect', () => { if (current !== generation) return; state = 'connected'; failure = null; render(); client.focus(); void refresh().then(render).catch(() => {}); });
    client.addEventListener('disconnect', ({ detail }) => {
      if (current !== generation) return;
      rfb = null; socket = null; state = 'disconnected';
      if (!detail.clean) failure = 'START_FAILED'; render();
    });
    client.addEventListener('securityfailure', () => { if (current === generation) { failure = 'START_FAILED'; render(); } });
    client.addEventListener('clipboard', ({ detail }) => {
      if (current !== generation || !sync) return;
      const text = detail.text;
      if (!clipboard.contains(document.activeElement)) { clipboardText = text; field.update({ value: text }); }
      if (text.length > GUEST_CLIPBOARD_TEXT_MAX) { failure = 'clipboardLimit'; render(); return; }
      if (clipboardText.length <= GUEST_CLIPBOARD_TEXT_MAX && failure === 'clipboardLimit') failure = null;
      render();
      if (text) void host.writeClipboard(text).catch(() => { if (current === generation) { failure = 'clipboardFailed'; render(); } });
    });
  } catch { if (current === generation) { disconnect(); failure = 'START_FAILED'; render(); } }
}
async function copyClipboard(): Promise<void> {
  if (clipboardText.length > GUEST_CLIPBOARD_TEXT_MAX) { failure = 'clipboardLimit'; render(); return; }
  try { if (clipboardText) await host.writeClipboard(clipboardText); failure = null; render(); }
  catch { failure = 'clipboardFailed'; render(); }
}
function pasteClipboard(text: string, withShift = false): void {
  if (!rfb || state !== 'connected') return;
  clipboardText = text; field.update({ value: text });
  if (text.length > GUEST_CLIPBOARD_TEXT_MAX) { failure = 'clipboardLimit'; render(); return; }
  failure = null; render();
  rfb.clipboardPasteFrom(text);
  sendPasteKeys(rfb, withShift, [...heldModifiers.values()]);
  rfb.focus();
}
async function action(id: string): Promise<void> {
  if (id === 'fit') { fitted = !fitted; if (rfb) rfb.scaleViewport = fitted; }
  else if (id === 'resize') { resize = !resize; if (rfb) rfb.resizeSession = resize; }
  else if (id === 'sync') sync = !sync;
  else if (id === 'clipboard') { clipboard.hidden = !clipboard.hidden; if (!clipboard.hidden) clipboard.querySelector('textarea')?.focus(); }
  else if (id === 'cad') rfb?.sendCtrlAltDel();
  else if (id === 'super') rfb?.sendKey(0xffeb, 'MetaLeft');
  else if (id === 'tab') { rfb?.sendKey(0xffe9, 'AltLeft', true); rfb?.sendKey(0xff09, 'Tab'); rfb?.sendKey(0xffe9, 'AltLeft', false); }
  else if (id === 'expand') { disconnect(); await host.openPage().catch(() => { failure = 'START_FAILED'; }); }
  else if (id === 'stop') {
    if (mode === 'virtual') disconnect();
    try { const result = await host.serviceRequest({ method: 'POST', path: '/session/stop', body: JSON.stringify({ mode: 'virtual' }) }); if (result.status !== 200) throw new Error('Stop failed'); await refresh(); }
    catch { failure = 'START_FAILED'; }
  }
  render();
}

// The iframe cannot read the OS clipboard directly. A real paste supplies
// text; capture the chord so noVNC cannot paste the previous remote value first.
document.addEventListener('keydown', (event) => {
  if (viewport.contains(document.activeElement) && /^(Meta|Control|Shift|Alt)(Left|Right)$/.test(event.code)) heldModifiers.set(event.code, remoteModifierKey(event.code, /Mac|iPhone|iPad/.test(navigator.platform)));
  if (sync && rfb && viewport.contains(document.activeElement) && (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'v') { pasteWithShift = event.shiftKey; event.stopImmediatePropagation(); }
}, true);
document.addEventListener('keyup', (event) => { heldModifiers.delete(event.code); }, true);
window.addEventListener('blur', () => heldModifiers.clear());
viewport.addEventListener('focusout', () => heldModifiers.clear());
document.addEventListener('paste', (event) => {
  if (!sync || !rfb || !viewport.contains(document.activeElement)) return;
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
  context = next; locale = next.locale;
  applyHostReady(next, document.documentElement);
  document.documentElement.lang = locale;
  document.documentElement.dir = locale === 'ar' || locale === 'he' ? 'rtl' : 'ltr';
  render();
  if (initialized) return;
  initialized = true;
  if (!next.features?.serviceSockets) { failure = 'unsupportedHost'; render(); return; }
  void (async () => {
    await refresh();
    const preference = await host.storage.get('desktop-mode');
    if (preference === 'physical' || preference === 'virtual') mode = preference;
    else if (desktopStatus?.sessions.some((item) => item.mode === 'virtual')) mode = 'virtual';
    resize = mode === 'virtual'; state = 'disconnected'; render();
    if (desktopStatus?.sessions.some((item) => item.mode === mode && item.ready)) await connect();
  })().catch(() => { failure = 'START_FAILED'; state = 'disconnected'; render(); });
});
