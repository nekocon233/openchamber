import { describe, expect, test } from 'bun:test';

import { orderMobileWorkspaceTabs, shownMobileWorkspaceTabs, storedMobileWorkspaceTabOrder, stripMobileWorkspaceTabs, withReceivedPagesTab } from './mobileWorkspaceTabs';

describe('mobile workspace tabs', () => {
  test('the native app adds the browser before Project knowledge, also to an order saved without it', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { Capacitor: { isNativePlatform: () => true }, location: { protocol: 'https:' } },
    });
    try {
      expect(orderMobileWorkspaceTabs([])).toEqual(['status', 'changes', 'files', 'terminal', 'preview', 'notes']);
      expect(orderMobileWorkspaceTabs(['notes', 'status', 'changes', 'files', 'terminal'])).toEqual(['preview', 'notes', 'status', 'changes', 'files', 'terminal']);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });

  test('hosted mobile omits Work Status and Preview even when they lead a saved order', () => {
    const saved = ['status', 'preview', 'files', 'changes', 'terminal', 'notes'];
    expect(orderMobileWorkspaceTabs(saved)).toEqual(['files', 'changes', 'terminal', 'notes']);
    expect(stripMobileWorkspaceTabs(saved, [], 'status')).toEqual(['files', 'changes', 'terminal', 'notes']);
  });

  test('a saved order keeps its tabs and places tabs it does not name where they go by default', () => {
    expect(orderMobileWorkspaceTabs(['terminal', 'gone', 'changes', 'terminal'])).toEqual(['files', 'terminal', 'changes', 'notes']);
    expect(orderMobileWorkspaceTabs([])).toEqual(['changes', 'files', 'terminal', 'notes']);
  });

  test('a legacy MCP tab drops out of the saved order', () => {
    expect(orderMobileWorkspaceTabs(['mcp', 'files', 'changes', 'terminal', 'notes'])).toEqual(['files', 'changes', 'terminal', 'notes']);
  });

  test('hidden tabs leave the strip, but never all of them', () => {
    expect(shownMobileWorkspaceTabs(['files'], ['changes', 'mcp'])).toEqual(['files', 'terminal', 'notes']);
    expect(shownMobileWorkspaceTabs([], ['changes', 'files', 'terminal', 'notes'])).toEqual(['changes', 'files', 'terminal', 'notes']);
  });

  test('a hidden tab something opened stays in the strip, in its place, while it is open', () => {
    expect(stripMobileWorkspaceTabs([], ['files', 'terminal'], 'files')).toEqual(['changes', 'files', 'notes']);
    expect(stripMobileWorkspaceTabs([], ['files', 'terminal'], 'notes')).toEqual(['changes', 'notes']);
  });

  test('a new extension tab goes last; a saved one keeps its place; one not available now is left out', () => {
    expect(orderMobileWorkspaceTabs([], ['plugin:tasks'])).toEqual(['changes', 'files', 'terminal', 'notes', 'plugin:tasks']);
    const saved = ['plugin:tasks', 'status', 'changes', 'plugin:gone', 'files', 'terminal', 'notes'];
    expect(orderMobileWorkspaceTabs(saved, ['plugin:tasks', 'plugin:config'])).toEqual(['plugin:tasks', 'changes', 'files', 'terminal', 'notes', 'plugin:config']);
    expect(orderMobileWorkspaceTabs(saved)).toEqual(['changes', 'files', 'terminal', 'notes']);
    expect(shownMobileWorkspaceTabs(saved, ['plugin:tasks'], ['plugin:tasks'])).toEqual(['changes', 'files', 'terminal', 'notes']);
  });

  test('a stored order keeps the saved place of an extension that is not available now', () => {
    const previous = ['changes', 'plugin:gone', 'files', 'terminal', 'notes', 'plugin:tasks'];
    expect(storedMobileWorkspaceTabOrder(['plugin:tasks', 'changes', 'files', 'terminal', 'notes'], previous))
      .toEqual(['plugin:tasks', 'changes', 'plugin:gone', 'files', 'terminal', 'notes']);
    // Unavailable tabs that led the saved order stay first, in their saved order.
    expect(storedMobileWorkspaceTabOrder(['notes', 'status', 'changes', 'files', 'terminal'], ['plugin:a', 'plugin:b', 'status', 'changes', 'files', 'terminal', 'notes']))
      .toEqual(['plugin:a', 'plugin:b', 'notes', 'changes', 'files', 'terminal']);
    expect(storedMobileWorkspaceTabOrder(['notes', 'unknown', 'files'], [])).toEqual(['changes', 'terminal', 'notes', 'files']);
  });
});

describe('the shared pages tab', () => {
  test('sits right after Status wherever the user put Status, and first without it', () => {
    expect(withReceivedPagesTab(['changes', 'status', 'files'])).toEqual(['changes', 'status', 'pages', 'files']);
    expect(withReceivedPagesTab(['status', 'changes'])).toEqual(['status', 'pages', 'changes']);
    expect(withReceivedPagesTab(['changes', 'files'])).toEqual(['pages', 'changes', 'files']);
    expect(withReceivedPagesTab(['changes', 'pages', 'status'])).toEqual(['changes', 'status', 'pages']);
  });
});
