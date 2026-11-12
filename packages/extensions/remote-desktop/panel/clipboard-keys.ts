type Key = { keysym: number; code: string };
type KeyTarget = { sendKey: (keysym: number, code: string, down?: boolean) => void };

/** noVNC maps Mac CommandLeft to Alt_L and CommandRight to Super_L. */
export const remoteModifierKey = (code: string, mac: boolean): Key => {
  if (code === 'ControlLeft' || code === 'ControlRight') return { code, keysym: code === 'ControlLeft' ? 0xffe3 : 0xffe4 };
  if (code === 'ShiftLeft' || code === 'ShiftRight') return { code, keysym: code === 'ShiftLeft' ? 0xffe1 : 0xffe2 };
  if (code === 'AltLeft' || code === 'AltRight') return { code, keysym: mac ? (code === 'AltLeft' ? 0xff7e : 0xfe03) : code === 'AltLeft' ? 0xffe9 : 0xffea };
  return { code, keysym: mac ? (code === 'MetaRight' ? 0xffeb : 0xffe9) : code === 'MetaRight' ? 0xffec : 0xffeb };
};

export const sendPasteKeys = (target: KeyTarget, shift: boolean, heldModifiers: readonly Key[]): void => {
  for (const key of heldModifiers) target.sendKey(key.keysym, key.code, false);
  target.sendKey(0xffe3, 'ControlLeft', true);
  if (shift) target.sendKey(0xffe1, 'ShiftLeft', true);
  target.sendKey(0x76, 'KeyV');
  if (shift) target.sendKey(0xffe1, 'ShiftLeft', false);
  target.sendKey(0xffe3, 'ControlLeft', false);
  for (const key of heldModifiers) target.sendKey(key.keysym, key.code, true);
};
