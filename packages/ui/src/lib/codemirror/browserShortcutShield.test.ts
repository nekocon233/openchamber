import { describe, expect, test } from 'bun:test';
import { classifyEditorBrowserShortcut } from './browserShortcutShield';

const keyEvent = (overrides: Partial<Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>>) => ({
  key: '',
  code: '',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...overrides,
});

describe('classifyEditorBrowserShortcut', () => {
  test('classifies F12, Alt+F12, Shift+F12 and F2 chords', () => {
    expect(classifyEditorBrowserShortcut(keyEvent({ key: 'F12', code: 'F12' }), false)).toBe('go-to-definition');
    expect(classifyEditorBrowserShortcut(keyEvent({ key: 'F12', code: 'F12', altKey: true }), false)).toBe('peek-definition');
    expect(classifyEditorBrowserShortcut(keyEvent({ key: 'F12', code: 'F12', shiftKey: true }), false)).toBe('find-references');
    expect(classifyEditorBrowserShortcut(keyEvent({ key: 'F2', code: 'F2' }), false)).toBe('rename-symbol');
    expect(classifyEditorBrowserShortcut(keyEvent({ key: 'F2', code: 'F2', ctrlKey: true }), false)).toBe('change-all-occurrences');
    expect(classifyEditorBrowserShortcut(keyEvent({ key: 'F2', code: 'F2', metaKey: true }), true)).toBe('change-all-occurrences');
  });

  test('intercepts Ctrl+- and Ctrl+Shift+- zoom shortcuts and non-macOS Alt+Left/Right history shortcuts', () => {
    expect(classifyEditorBrowserShortcut(keyEvent({ key: '-', code: 'Minus', ctrlKey: true }), false)).toBe('go-back');
    expect(classifyEditorBrowserShortcut(keyEvent({ key: '_', code: 'Minus', ctrlKey: true, shiftKey: true }), false)).toBe('go-forward');
    expect(classifyEditorBrowserShortcut(keyEvent({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true }), false)).toBe('go-back');
    expect(classifyEditorBrowserShortcut(keyEvent({ key: 'ArrowRight', code: 'ArrowRight', altKey: true }), false)).toBe('go-forward');
    // On macOS, Option+Left/Right is word navigation, not browser history.
    expect(classifyEditorBrowserShortcut(keyEvent({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true }), true)).toBeNull();
  });

  test('shields browser Save, Find, Bookmark and Comment chords inside the editor', () => {
    expect(classifyEditorBrowserShortcut(keyEvent({ key: 'd', code: 'KeyD', ctrlKey: true }), false)).toBe('prevent-browser-default');
    expect(classifyEditorBrowserShortcut(keyEvent({ key: 's', code: 'KeyS', metaKey: true }), true)).toBe('prevent-browser-default');
    expect(classifyEditorBrowserShortcut(keyEvent({ key: 'o', code: 'KeyO', ctrlKey: true, shiftKey: true }), false)).toBe('prevent-browser-default');
  });
});
