import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { messages } from './i18n.ts';
import {
  SOFT_KEYBOARD_SENTINEL,
  XK_BACKSPACE,
  XK_CONTROL_L,
  XK_ESCAPE,
  XK_RETURN,
  XK_TAB,
  bindSoftKeyboardInput,
  diffSoftKeyboardValue,
  specialKeyToKeysym,
  textToKeysyms,
} from './soft-keyboard.ts';

describe('remote desktop soft keyboard', () => {
  test('maps sentinel deletions, ASCII, newlines, and Unicode text to X11 keysyms', () => {
    expect(diffSoftKeyboardValue(SOFT_KEYBOARD_SENTINEL)).toEqual([]);
    expect(diffSoftKeyboardValue('')).toEqual([XK_BACKSPACE]);
    expect(diffSoftKeyboardValue(`${SOFT_KEYBOARD_SENTINEL}Az/`)).toEqual([0x41, 0x7a, 0x2f]);
    expect(diffSoftKeyboardValue(`${SOFT_KEYBOARD_SENTINEL}a\nb\t`)).toEqual([0x61, XK_RETURN, 0x62, XK_TAB]);
    expect(textToKeysyms('你')).toEqual([0x01004f60]);
    expect(specialKeyToKeysym('Escape')).toBe(XK_ESCAPE);
  });

  test('streams IME composition only on commit and sends control chords cleanly', async () => {
    const dom = new Window();
    const prevDoc = globalThis.document;
    const prevEvent = globalThis.Event;
    const prevKeyboardEvent = globalThis.KeyboardEvent;
    Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.document });
    Object.defineProperty(globalThis, 'Event', { configurable: true, value: dom.Event });
    Object.defineProperty(globalThis, 'KeyboardEvent', { configurable: true, value: dom.KeyboardEvent });
    try {
      const input = document.createElement('textarea');
      document.body.append(input);
      const sent: Array<{ keysym: number; code?: string | null; down?: boolean }> = [];
      let retainFocus = false;
      let dismissed = 0;
      const unbind = bindSoftKeyboardInput(input, {
        isConnected: () => true,
        sendKey: (keysym, code, down) => sent.push({ keysym, code, down }),
        onDismiss: () => { dismissed += 1; },
        shouldRetainFocus: () => retainFocus,
      });

      input.dispatchEvent(new Event('compositionstart'));
      input.value = `${SOFT_KEYBOARD_SENTINEL}ni`;
      input.dispatchEvent(new Event('input'));
      expect(sent).toEqual([]);

      input.value = `${SOFT_KEYBOARD_SENTINEL}你`;
      input.dispatchEvent(new Event('compositionend'));
      expect(sent).toEqual([{ keysym: 0x01004f60, code: null, down: undefined }]);
      expect(input.value).toBe(SOFT_KEYBOARD_SENTINEL);

      sent.length = 0;
      input.value = '';
      input.dispatchEvent(new Event('input'));
      expect(sent).toEqual([{ keysym: XK_BACKSPACE, code: null, down: undefined }]);
      expect(input.value).toBe(SOFT_KEYBOARD_SENTINEL);

      sent.length = 0;
      const ctrlC = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, cancelable: true });
      input.dispatchEvent(ctrlC);
      expect(sent).toEqual([
        { keysym: XK_CONTROL_L, code: 'ControlLeft', down: true },
        { keysym: 0x63, code: null, down: undefined },
        { keysym: XK_CONTROL_L, code: 'ControlLeft', down: false },
      ]);

      input.focus();
      retainFocus = true;
      input.blur();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(dismissed).toBe(0);

      input.focus();
      retainFocus = false;
      input.blur();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(dismissed).toBe(1);

      unbind();
    } finally {
      Object.defineProperty(globalThis, 'document', { configurable: true, value: prevDoc });
      Object.defineProperty(globalThis, 'Event', { configurable: true, value: prevEvent });
      Object.defineProperty(globalThis, 'KeyboardEvent', { configurable: true, value: prevKeyboardEvent });
      dom.close();
    }
  });

  test('provides localized touch header labels across all 15 panel locales', () => {
    for (const [locale, dict] of Object.entries(messages)) {
      for (const key of ['panView', 'fitView', 'showKeyboard', 'hideKeyboard'] as const) {
        expect(dict[key].length).toBeGreaterThan(0);
        expect(dict[key].length).toBeLessThanOrEqual(60);
        if (locale !== 'en') {
          expect(dict[key]).not.toBe(messages.en[key]);
        }
      }
    }
  });
});
