import { expect, test } from 'bun:test';
import { remoteModifierKey, sendPasteKeys } from './clipboard-keys.ts';

test('Mac Command paste releases mapped Alt/Super before Ctrl+V and restores held keys', () => {
  const sent: [number, string, boolean | undefined][] = [];
  const key = remoteModifierKey('MetaLeft', true);
  sendPasteKeys({ sendKey: (...event) => sent.push(event) }, false, [key]);
  expect(sent).toEqual([[0xffe9, 'MetaLeft', false], [0xffe3, 'ControlLeft', true], [0x76, 'KeyV', undefined], [0xffe3, 'ControlLeft', false], [0xffe9, 'MetaLeft', true]]);
  expect(remoteModifierKey('MetaRight', true).keysym).toBe(0xffeb);
});

test('terminal paste retains Shift with the same ordered modifier release', () => {
  const sent: [number, string, boolean | undefined][] = [];
  sendPasteKeys({ sendKey: (...event) => sent.push(event) }, true, []);
  expect(sent).toEqual([[0xffe3, 'ControlLeft', true], [0xffe1, 'ShiftLeft', true], [0x76, 'KeyV', undefined], [0xffe1, 'ShiftLeft', false], [0xffe3, 'ControlLeft', false]]);
});


test('preserves Ctrl and Shift for a continuing physical shortcut after paste', () => {
  const held = [remoteModifierKey('ControlRight', false), remoteModifierKey('ShiftLeft', false)];
  const pressed = new Set(held.map((key) => key.keysym));
  const target = { sendKey: (keysym: number, _code: string, down?: boolean) => {
    if (down === true) pressed.add(keysym); else if (down === false) pressed.delete(keysym);
  } };
  sendPasteKeys(target, true, held);
  expect(pressed.has(0xffe4)).toBe(true);
  expect(pressed.has(0xffe1)).toBe(true);
  expect(pressed.has(0xffe3)).toBe(false);
  target.sendKey(0x61, 'KeyA');
  expect(pressed.has(0xffe4)).toBe(true);
});
