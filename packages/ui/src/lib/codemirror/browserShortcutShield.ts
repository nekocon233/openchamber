import { isMacOS } from '@/lib/utils';

type ShieldedEditorShortcutAction =
  | 'go-to-definition'
  | 'peek-definition'
  | 'find-references'
  | 'rename-symbol'
  | 'change-all-occurrences'
  | 'go-back'
  | 'go-forward'
  | 'prevent-browser-default';

/**
 * Classifies a `keydown` event inside the file editor that would otherwise
 * trigger a browser default action (DevTools on `F12`, page zoom on `Ctrl+-`,
 * browser history on `Alt+Left/Right`, bookmark on `Mod+D`, save on `Mod+S`,
 * find on `Mod+F` / `Mod+G`).
 */
export const classifyEditorBrowserShortcut = (
  event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
  mac = isMacOS(),
): ShieldedEditorShortcutAction | null => {
  const mod = mac ? event.metaKey : event.ctrlKey;
  const keyLower = event.key.toLowerCase();

  // F12 family (DevTools in browsers)
  if (event.key === 'F12' || event.code === 'F12') {
    if (event.ctrlKey || event.metaKey) return null;
    if (event.altKey && !event.shiftKey) return 'peek-definition';
    if (event.shiftKey && !event.altKey) return 'find-references';
    if (!event.altKey && !event.shiftKey) return 'go-to-definition';
    return 'prevent-browser-default';
  }

  // F2 family
  if (event.key === 'F2' || event.code === 'F2') {
    if (mod && !event.altKey && !event.shiftKey) return 'change-all-occurrences';
    if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) return 'rename-symbol';
  }

  // Ctrl + - / Ctrl + Shift + - (Browser zoom out)
  if (
    event.ctrlKey
    && !event.metaKey
    && !event.altKey
    && (event.key === '-' || event.key === '_' || event.code === 'Minus')
  ) {
    return event.shiftKey ? 'go-forward' : 'go-back';
  }

  // Alt + Left / Right on Windows & Linux triggers browser Back / Forward navigation
  if (
    !mac
    && event.altKey
    && !event.ctrlKey
    && !event.metaKey
    && !event.shiftKey
    && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
  ) {
    return event.key === 'ArrowLeft' ? 'go-back' : 'go-forward';
  }

  // Common Mod chords that browsers intercept when focus slips outside `.cm-content`
  if (mod && !event.altKey) {
    if (
      keyLower === 's'
      || keyLower === 'f'
      || keyLower === 'g'
      || keyLower === 'd'
      || keyLower === '/'
      || (event.shiftKey && (keyLower === 'k' || keyLower === 'o'))
    ) {
      return 'prevent-browser-default';
    }
  }

  return null;
};

type NavigatorWithKeyboardLock = Navigator & {
  keyboard?: {
    lock?: (keyCodes?: string[]) => Promise<void>;
    unlock?: () => void;
  };
};

/**
 * Requests Chromium's Web Keyboard Lock for reserved keys (`Mod+T`, `Mod+W`,
 * `Mod+N`, `Escape`) when running in fullscreen or installed PWA standalone mode.
 */
export const acquireEditorKeyboardLock = (): (() => void) => {
  const nav: NavigatorWithKeyboardLock | undefined = globalThis.navigator;
  if (!nav?.keyboard?.lock || !globalThis.document) {
    return () => {};
  }

  let locked = false;
  const tryLock = () => {
    locked = true;
    void nav.keyboard?.lock?.(['KeyW', 'KeyT', 'KeyN', 'Escape']).catch(() => {
      locked = false;
    });
  };

  tryLock();
  document.addEventListener('fullscreenchange', tryLock);

  return () => {
    document.removeEventListener('fullscreenchange', tryLock);
    if (locked) {
      nav.keyboard?.unlock?.();
    }
  };
};
