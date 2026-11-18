export const SOFT_KEYBOARD_SENTINEL = ' ';

export const XK_BACKSPACE = 0xff08;
export const XK_TAB = 0xff09;
export const XK_RETURN = 0xff0d;
export const XK_ESCAPE = 0xff1b;
const XK_HOME = 0xff50;
const XK_LEFT = 0xff51;
const XK_UP = 0xff52;
const XK_RIGHT = 0xff53;
const XK_DOWN = 0xff54;
const XK_PAGE_UP = 0xff55;
const XK_PAGE_DOWN = 0xff56;
const XK_END = 0xff57;
export const XK_CONTROL_L = 0xffe3;
const XK_DELETE = 0xffff;

const SPECIAL_KEYS = {
  Enter: XK_RETURN,
  Backspace: XK_BACKSPACE,
  Tab: XK_TAB,
  Escape: XK_ESCAPE,
  Delete: XK_DELETE,
  ArrowLeft: XK_LEFT,
  ArrowUp: XK_UP,
  ArrowRight: XK_RIGHT,
  ArrowDown: XK_DOWN,
  Home: XK_HOME,
  End: XK_END,
  PageUp: XK_PAGE_UP,
  PageDown: XK_PAGE_DOWN,
} as const satisfies Record<string, number>;

const isSpecialKeyName = (key: string): key is keyof typeof SPECIAL_KEYS => Object.hasOwn(SPECIAL_KEYS, key);

export const specialKeyToKeysym = (key: string): number | null => (isSpecialKeyName(key) ? SPECIAL_KEYS[key] : null);

const unicodeCodePointToKeysym = (codePoint: number): number | null => {
  if (codePoint === 0x0a || codePoint === 0x0d) return XK_RETURN;
  if (codePoint === 0x09) return XK_TAB;
  if (codePoint < 0x20) return null;
  if (codePoint <= 0xff) return codePoint;
  return 0x01000000 | codePoint;
};

export const textToKeysyms = (text: string): number[] => {
  const output: number[] = [];
  for (const char of Array.from(text)) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) continue;
    const keysym = unicodeCodePointToKeysym(codePoint);
    if (keysym !== null) output.push(keysym);
  }
  return output;
};

export const diffSoftKeyboardValue = (value: string): number[] => {
  if (value === SOFT_KEYBOARD_SENTINEL) return [];
  if (value.length === 0) return [XK_BACKSPACE];
  const inserted = value.startsWith(SOFT_KEYBOARD_SENTINEL)
    ? value.slice(SOFT_KEYBOARD_SENTINEL.length)
    : value;
  return textToKeysyms(inserted);
};

export const resetSoftKeyboardBuffer = (input: HTMLTextAreaElement): void => {
  input.value = SOFT_KEYBOARD_SENTINEL;
  try {
    input.setSelectionRange(SOFT_KEYBOARD_SENTINEL.length, SOFT_KEYBOARD_SENTINEL.length);
  } catch {
    // Hidden or detached fields in non-browser test runners may refuse selection updates.
  }
};

export const bindSoftKeyboardInput = (
  input: HTMLTextAreaElement,
  handlers: {
    isConnected: () => boolean;
    sendKey: (keysym: number, code?: string | null, down?: boolean) => void;
    onDismiss: () => void;
    shouldRetainFocus: () => boolean;
  },
): (() => void) => {
  let composing = false;
  let blurTimer: ReturnType<typeof setTimeout> | null = null;
  resetSoftKeyboardBuffer(input);

  const flush = () => {
    const keys = diffSoftKeyboardValue(input.value);
    resetSoftKeyboardBuffer(input);
    if (!handlers.isConnected()) return;
    for (const keysym of keys) {
      handlers.sendKey(keysym, null);
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (composing || event.isComposing || event.key === 'Unidentified' || event.keyCode === 229) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
      const lower = event.key.toLowerCase();
      if (lower === 'v') return;
      if (lower.length === 1 && lower >= 'a' && lower <= 'z') {
        event.preventDefault();
        resetSoftKeyboardBuffer(input);
        if (!handlers.isConnected()) return;
        handlers.sendKey(XK_CONTROL_L, 'ControlLeft', true);
        handlers.sendKey(lower.charCodeAt(0), null);
        handlers.sendKey(XK_CONTROL_L, 'ControlLeft', false);
        return;
      }
    }
    const special = specialKeyToKeysym(event.key);
    if (special === null) return;
    event.preventDefault();
    resetSoftKeyboardBuffer(input);
    if (handlers.isConnected()) {
      handlers.sendKey(special, null);
    }
  };

  const onCompositionStart = () => {
    composing = true;
  };

  const onCompositionEnd = () => {
    composing = false;
    flush();
  };

  const onInput = () => {
    if (composing) return;
    flush();
  };

  const onBlur = () => {
    if (blurTimer) clearTimeout(blurTimer);
    blurTimer = setTimeout(() => {
      blurTimer = null;
      if (document.activeElement !== input && !handlers.shouldRetainFocus()) {
        handlers.onDismiss();
      }
    }, 80);
  };

  const onFocus = () => {
    if (blurTimer) {
      clearTimeout(blurTimer);
      blurTimer = null;
    }
    resetSoftKeyboardBuffer(input);
  };

  input.addEventListener('keydown', onKeyDown);
  input.addEventListener('compositionstart', onCompositionStart);
  input.addEventListener('compositionend', onCompositionEnd);
  input.addEventListener('input', onInput);
  input.addEventListener('blur', onBlur);
  input.addEventListener('focus', onFocus);

  return () => {
    if (blurTimer) clearTimeout(blurTimer);
    input.removeEventListener('keydown', onKeyDown);
    input.removeEventListener('compositionstart', onCompositionStart);
    input.removeEventListener('compositionend', onCompositionEnd);
    input.removeEventListener('input', onInput);
    input.removeEventListener('blur', onBlur);
    input.removeEventListener('focus', onFocus);
  };
};
