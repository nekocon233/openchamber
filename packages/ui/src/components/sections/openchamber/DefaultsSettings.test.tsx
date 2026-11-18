import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { DesktopSettings } from '@/lib/desktop';

type ProviderState = {
  id: string;
  models: Array<{ id: string; variants?: Array<{ id: string }> }>;
};

type ConfigState = {
  providers: ProviderState[];
  nativeAgentCombinations: [];
  setSettingsDefaultAgentCombinationId: () => void;
  modelsMetadata: Map<string, never>;
  setProvider: () => void;
  setModel: () => void;
  setAgent: () => void;
  setCurrentVariant: () => void;
  setCurrentVariantOverride: () => void;
  setSettingsDefaultModel: () => void;
  setSettingsDefaultVariant: () => void;
  setSettingsDefaultAgent: () => void;
  selectionSource: 'auto';
  agentSelectionSource: 'auto';
  agents: Array<{ name: string; model?: { providerID: string; id: string } }>;
  currentAgentName: string | undefined;
};

const configState: ConfigState = {
  providers: [],
  nativeAgentCombinations: [],
  setSettingsDefaultAgentCombinationId: () => undefined,
  modelsMetadata: new Map<string, never>(),
  setProvider: () => undefined,
  setModel: () => undefined,
  setAgent: () => undefined,
  setCurrentVariant: () => undefined,
  setCurrentVariantOverride: () => undefined,
  setSettingsDefaultModel: () => undefined,
  setSettingsDefaultVariant: () => undefined,
  setSettingsDefaultAgent: () => undefined,
  selectionSource: 'auto',
  agentSelectionSource: 'auto',
  agents: [],
  currentAgentName: undefined,
};

const settingsState = {
  showDeletionDialog: false,
  setShowDeletionDialog: () => undefined,
};

const selectionState = {
  getSessionModelSelection: () => undefined,
  getSessionAgentSelection: () => undefined,
};

const sessionState = { currentSessionId: null } satisfies { currentSessionId: string | null };
let savedSettings: DesktopSettings | null = null;
const updateCalls: Array<Partial<DesktopSettings>> = [];
let saveResult: (() => Promise<{ ok: boolean }>) | undefined;
const SelectChange = React.createContext<(value: string) => void>(() => {});

mock.module('@/stores/useConfigStore', () => ({
  useConfigStore: Object.assign(<T,>(selector: (state: ConfigState) => T): T => selector(configState), { getState: () => configState }),
}));
mock.module('@/stores/useUIStore', () => ({
  useUIStore: <T,>(selector: (state: typeof settingsState) => T): T => selector(settingsState),
}));
mock.module('@/sync/selection-store', () => ({
  useSelectionStore: <T,>(selector: (state: typeof selectionState) => T): T => selector(selectionState),
}));
mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: Object.assign(<T,>(selector: (state: typeof sessionState) => T): T => selector(sessionState), { getState: () => sessionState }),
}));
mock.module('@/stores/useDirectoryStore', () => ({
  useDirectoryStore: <T,>(selector: (state: { currentDirectory: string }) => T): T =>
    selector({ currentDirectory: '/test/project' }),
}));
const runtimeFetchCalls: string[] = [];
const realRuntimeFetch = await import('@/lib/runtime-fetch');
mock.module('@/lib/runtime-fetch', () => ({
  ...realRuntimeFetch,
  runtimeFetch: async (url: string) => {
    runtimeFetchCalls.push(url);
    return new Response(JSON.stringify({ authenticatedProviders: [] }), {
      headers: { 'Content-Type': 'application/json' },
    });
  },
}));
const persistenceModule = await import('@/lib/persistence');
mock.module('@/lib/persistence', () => ({
  ...persistenceModule,
  loadDesktopSettings: async () => savedSettings,
  updateDesktopSettings: async (changes: Partial<DesktopSettings>) => {
    updateCalls.push(changes);
    return saveResult ? saveResult() : { ok: true };
  },
  reportSettingsSaveState: () => {},
}));
const opencodeModule = await import('@/lib/opencode/client');
const configRead = spyOn(opencodeModule.opencodeClient, 'getConfig').mockResolvedValue({});
const realI18n = await import('@/lib/i18n');
mock.module('@/lib/i18n', () => ({
  ...realI18n,
  useI18n: () => ({ t: (key: string) => key }),
}));
mock.module('@/components/chat/mobileControlsUtils', () => ({
  isPrimaryMode: (mode: string | undefined) => mode === 'primary',
}));
mock.module('@/components/sections/agents/ModelSelector', () => ({
  ModelSelector: () => <button type="button">model</button>,
}));
mock.module('@/components/sections/commands/AgentSelector', () => ({
  AgentSelector: () => <button type="button">agent</button>,
}));
mock.module('@/components/sections/shared/SettingsInfoHint', () => ({
  SettingsInfoHint: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
// The permission row reads the routing and UI stores; it has no bearing on the defaults under test.
mock.module('@/components/sections/openchamber/PermissionDefaultModeField', () => ({
  PermissionDefaultModeField: () => null,
}));
mock.module('@/components/sections/shared/SettingsSection', () => ({
  SettingsSection: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  SettingsFieldRow: ({ children, settingsItem }: { children: React.ReactNode; settingsItem?: string }) => <div data-settings-item={settingsItem}>{children}</div>,
  SettingsCheckboxRow: ({ children, label }: { children?: React.ReactNode; label?: React.ReactNode }) => (
    <div>{label}{children}</div>
  ),
  SettingsInset: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SettingsGroupTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  SETTINGS_CUSTOM_TRIGGER_CLASS: '',
  SETTINGS_SELECT_ROW_TRIGGER_CLASS: '',
  SETTINGS_OPTION_STACK_CLASS: '',
  SETTINGS_FIELDS_STACK_CLASS: '',
}));
mock.module('@/components/ui/select', () => ({
  Select: ({ children, onValueChange }: { children: React.ReactNode; onValueChange: (value: string) => void }) => <SelectChange.Provider value={onValueChange}>{children}</SelectChange.Provider>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children, value, disabled }: { children: React.ReactNode; value: string; disabled?: boolean }) => {
    const change = React.useContext(SelectChange);
    return <button type="button" data-value={value} disabled={disabled} onClick={() => change(value)}>{children}</button>;
  },
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

const { DefaultsSettings } = await import('./DefaultsSettings');

describe('DefaultsSettings', () => {
  let windowInstance: Window;
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    saveResult = undefined;
    savedSettings = {
      defaultModel: 'sidecar/model',
      defaultVariant: 'high',
    };
    updateCalls.length = 0;
    configState.providers = [{ id: 'sidecar', models: [{ id: 'model', variants: [{ id: 'high' }] }] }];
    windowInstance = new Window({ url: 'http://localhost/' });
    // SAFETY: the test installs a happy-dom Window for the component and restores the original global afterward.
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      navigator: windowInstance.navigator,
      Node: windowInstance.Node,
      Element: windowInstance.Element,
      HTMLElement: windowInstance.HTMLElement,
      Event: windowInstance.Event,
      MouseEvent: windowInstance.MouseEvent,
      MutationObserver: windowInstance.MutationObserver,
      getComputedStyle: windowInstance.getComputedStyle.bind(windowInstance),
      requestAnimationFrame: windowInstance.requestAnimationFrame.bind(windowInstance),
      cancelAnimationFrame: windowInstance.cancelAnimationFrame.bind(windowInstance),
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    configRead.mockRestore();
    await act(async () => root.unmount());
    windowInstance.close();
  });

  test('asks the small-model route for providers in the current directory', async () => {
    runtimeFetchCalls.length = 0;

    await act(async () => {
      root.render(<DefaultsSettings />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(runtimeFetchCalls.some((url) =>
      url.startsWith('/api/small-model') && url.includes(`directory=${encodeURIComponent('/test/project')}`))).toBe(true);
  });

  test('saves both Codex fields together and restores the last acknowledged pair after a refused write', async () => {
    savedSettings = { defaultModel: 'codex-native/sol', defaultVariant: 'default-ultrafast' };
    configState.providers = [{ id: 'codex-native', models: [{ id: 'sol', variants: ['default', 'high', 'default-ultrafast', 'high-ultrafast'].map((id) => ({ id })) }] }];
    await act(async () => root.render(<DefaultsSettings />));
    const pick = (field: string, id: string) => act(async () => {
      const option = host.querySelector<HTMLButtonElement>(`[data-settings-item="sessions.default-${field}"] [data-value="${id}"]`);
      if (!option || option.disabled) throw new Error(`Missing ${field} option ${id}`);
      option.click();
    });
    await pick('speed', 'default');
    expect(updateCalls.at(-1)).toEqual({ defaultModel: 'codex-native/sol', defaultVariant: 'default', defaultAgentCombinationId: '' });
    const pending: Array<(result: { ok: boolean }) => void> = [];
    saveResult = () => new Promise((resolve) => pending.push(resolve));
    await pick('thinking', 'high');
    await pick('speed', 'ultrafast');
    expect(updateCalls.slice(-2).map((patch) => patch.defaultVariant)).toEqual(['high', 'high-ultrafast']);
    await act(async () => { pending[0]({ ok: true }); pending[1]({ ok: false }); });
    expect(host.textContent).toContain('codex-native/sol (High)');
  });

  test('retains a saved model variant while the model disappears and returns', async () => {
    await act(async () => {
      root.render(<DefaultsSettings />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('High');

    configState.providers = [];
    await act(async () => {
      root.render(<DefaultsSettings />);
      await Promise.resolve();
    });

    expect(host.textContent).toContain('High');
    expect(updateCalls).toEqual([]);

    configState.providers = [{ id: 'sidecar', models: [{ id: 'model', variants: [{ id: 'high' }] }] }];
    await act(async () => {
      root.render(<DefaultsSettings />);
      await Promise.resolve();
    });

    expect(host.textContent).toContain('sidecar/model');
    expect(host.textContent).toContain('High');
    expect(updateCalls).toEqual([]);
  });
});
