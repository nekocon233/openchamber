import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { DesktopSettings } from '@/lib/desktop';

type ProviderState = {
  id: string;
  models: Array<{ id: string; variants?: Record<string, boolean> | Array<{ id: string }> }>;
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
  agents: [];
  currentAgentName: undefined;
  currentProviderId?: string;
  currentModelId?: string;
  currentVariantSelection: { override?: string };
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
  currentVariantSelection: {},
};

const settingsState = {
  showDeletionDialog: true,
  setShowDeletionDialog: () => undefined,
  requestSettingsJump: () => undefined,
};
const selectionState = {
  getSessionModelSelection: () => null,
  getSessionAgentSelection: () => null,
};
const sessionState = { currentSessionId: null } satisfies { currentSessionId: string | null };
let savedSettings: DesktopSettings | null = null;
const updateCalls: Array<Partial<DesktopSettings>> = [];
let saveResult: (() => Promise<{ ok: boolean }>) | undefined;
const SelectChange = React.createContext<(value: string) => void>(() => {});

mock.module('@/stores/useConfigStore', () => ({
  useConfigStore: Object.assign(
    <T,>(selector: (state: ConfigState) => T): T => selector(configState),
    { getState: () => configState },
  ),
  selectIsModelMissingFromCatalog: () => false,
}));
mock.module('@/stores/useUIStore', () => ({
  useUIStore: <T,>(selector: (state: typeof settingsState) => T): T => selector(settingsState),
}));
mock.module('@/sync/selection-store', () => ({
  useSelectionStore: <T,>(selector: (state: typeof selectionState) => T): T => selector(selectionState),
}));
mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: Object.assign(
    <T,>(selector: (state: typeof sessionState) => T): T => selector(sessionState),
    { getState: () => sessionState },
  ),
}));
mock.module('@/stores/useDirectoryStore', () => ({
  useDirectoryStore: <T,>(selector: (state: { currentDirectory: string }) => T): T =>
    selector({ currentDirectory: '/test/project' }),
}));
const runtimeFetchCalls: string[] = [];
const runtimeFetchModule = await import('@/lib/runtime-fetch');
mock.module('@/lib/runtime-fetch', () => ({
  ...runtimeFetchModule,
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
const realI18n = await import('@/lib/i18n');
mock.module('@/lib/i18n', () => ({
  ...realI18n,
  useI18n: () => ({ t: (key: string) => key }),
  getCurrentIntlLocale: () => 'en-US',
}));
mock.module('@/components/chat/mobileControlsUtils', () => ({
  isPrimaryMode: (mode: string | undefined) => mode === 'primary',
}));
mock.module('@/components/sections/agents/ModelSelector', () => ({
  ModelSelector: ({
    providerId,
    modelId,
    onChange,
  }: {
    providerId: string;
    modelId: string;
    onChange: (providerId: string, modelId: string) => void;
  }) => (
    <button
      type="button"
      onClick={() => onChange(providerId, modelId === 'small' ? 'other' : modelId)}
    >
      {providerId}/{modelId}
    </button>
  ),
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
  SettingsSection: ({ description, children }: { description?: React.ReactNode; children: React.ReactNode }) => (
    <section>{description}{children}</section>
  ),
  SettingsFieldRow: ({ children, settingsItem }: { children: React.ReactNode; settingsItem?: string }) => (
    <div data-settings-item={settingsItem}>{children}</div>
  ),
  SettingsCheckboxRow: ({ children, label }: { children?: React.ReactNode; label?: React.ReactNode }) => (
    <div>{label}{children}</div>
  ),
  SETTINGS_CUSTOM_TRIGGER_CLASS: '',
  SETTINGS_HELPER_CLASS: '',
  SETTINGS_SELECT_ROW_TRIGGER_CLASS: '',
  SETTINGS_OPTION_STACK_CLASS: '',
  SettingsChipGroup: () => null,
}));
mock.module('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    disabled,
    children,
  }: {
    value?: string;
    onValueChange?: (value: string) => void;
    disabled?: boolean;
    children: React.ReactNode;
  }) => (
    <SelectChange.Provider value={(next) => onValueChange?.(next)}>
      <div data-select-value={value} data-select-disabled={disabled ? 'true' : undefined}>
        <button type="button" onClick={() => onValueChange?.('medium')}>select-medium</button>
        <button type="button" onClick={() => onValueChange?.('__default__')}>select-default</button>
        {children}
      </div>
    </SelectChange.Provider>
  ),
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
  let configRead: ReturnType<typeof spyOn>;

  beforeEach(() => {
    configRead = spyOn(opencodeModule.opencodeClient, 'getConfig').mockResolvedValue({});
    saveResult = undefined;
    savedSettings = {
      defaultModel: 'sidecar/model',
      defaultVariant: 'high',
    };
    updateCalls.length = 0;
    configState.providers = [{ id: 'sidecar', models: [{ id: 'model', variants: { high: true } }] }];
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
    await act(async () => {
      root.render(<DefaultsSettings />);
      await Promise.resolve();
      await Promise.resolve();
    });
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
    expect(host.querySelector('[data-settings-item="sessions.default-thinking"] [data-select-value]')?.getAttribute('data-select-value')).toBe('high');
    expect(host.querySelector('[data-settings-item="sessions.default-speed"] [data-select-value]')?.getAttribute('data-select-value')).toBe('default');
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

    configState.providers = [{ id: 'sidecar', models: [{ id: 'model', variants: { high: true } }] }];
    await act(async () => {
      root.render(<DefaultsSettings />);
      await Promise.resolve();
    });

    expect(host.textContent).toContain('High');
    expect(updateCalls).toEqual([]);
  });

  test('shows the thinking levels the selected small model offers', async () => {
    savedSettings = {
      defaultModel: 'sidecar/model',
      defaultVariant: 'high',
      smallModelUseDefault: false,
      smallModelOverride: 'sidecar/small',
      smallModelVariant: 'medium',
    };
    configState.providers = [{
      id: 'sidecar',
      models: [
        { id: 'model', variants: { high: true } },
        { id: 'small', variants: [{ id: 'low' }, { id: 'medium' }] },
      ],
    }];

    await act(async () => {
      root.render(<DefaultsSettings />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Medium');
    expect(host.textContent).toContain('Low');
  });

  test('hides the small-model thinking row while the default small model is used', async () => {
    savedSettings = {
      defaultModel: 'sidecar/model',
      defaultVariant: 'high',
      smallModelUseDefault: true,
      smallModelOverride: 'sidecar/small',
      smallModelVariant: 'medium',
    };
    configState.providers = [{
      id: 'sidecar',
      models: [
        { id: 'model', variants: { high: true } },
        { id: 'small', variants: [{ id: 'low' }, { id: 'medium' }] },
      ],
    }];

    await act(async () => {
      root.render(<DefaultsSettings />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).not.toContain('Medium');
    expect(host.textContent).not.toContain('Low');
  });

  test('saves the chosen small-model thinking level and clears it when the model changes', async () => {
    savedSettings = {
      defaultModel: 'sidecar/model',
      defaultVariant: 'high',
      smallModelUseDefault: false,
      smallModelOverride: 'sidecar/small',
    };
    configState.providers = [{
      id: 'sidecar',
      models: [
        { id: 'model', variants: { high: true } },
        { id: 'small', variants: [{ id: 'low' }, { id: 'medium' }] },
      ],
    }];

    await act(async () => {
      root.render(<DefaultsSettings />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const smallSelect = host.querySelector('[data-select-value="__default__"]');
    const selectMedium = smallSelect?.querySelector<HTMLButtonElement>('button');
    expect(selectMedium).toBeTruthy();
    await act(async () => {
      selectMedium?.click();
      await Promise.resolve();
    });
    expect(updateCalls.some((call) => call.smallModelVariant === 'medium')).toBe(true);

    const smallSelectWithValue = host.querySelector('[data-select-value="medium"]');
    const selectDefault = Array.from(smallSelectWithValue?.querySelectorAll<HTMLButtonElement>('button') ?? [])
      .find((button) => button.textContent === 'select-default');
    expect(selectDefault).toBeTruthy();
    await act(async () => {
      selectDefault?.click();
      await Promise.resolve();
    });
    expect(updateCalls.some((call) => call.smallModelVariant === '')).toBe(true);

    const smallModelButton = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'sidecar/small');
    expect(smallModelButton).toBeTruthy();
    await act(async () => {
      smallModelButton?.click();
      await Promise.resolve();
    });
    expect(updateCalls.some((call) => (
      call.smallModelOverride === 'sidecar/other' && call.smallModelVariant === ''
    ))).toBe(true);
  });

  test('shows no thinking picker for a small model without levels', async () => {
    savedSettings = {
      smallModelUseDefault: false,
      smallModelOverride: 'sidecar/small',
    };
    configState.providers = [{ id: 'sidecar', models: [{ id: 'small' }] }];

    await act(async () => {
      root.render(<DefaultsSettings />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.querySelector('[data-select-value="__default__"]')).toBeNull();
  });

  test('saves a thinking level for the walkthrough model and clears it when that model changes', async () => {
    savedSettings = {
      defaultModel: 'sidecar/model',
      defaultVariant: 'high',
      smallModelUseDefault: true,
      walkthroughModelOverride: 'sidecar/small',
    };
    configState.providers = [{
      id: 'sidecar',
      models: [
        { id: 'model', variants: { high: true } },
        { id: 'small', variants: [{ id: 'low' }, { id: 'medium' }] },
        { id: 'other', variants: [{ id: 'low' }] },
      ],
    }];

    await act(async () => {
      root.render(<DefaultsSettings />);
      await Promise.resolve();
      await Promise.resolve();
    });

    // The small model uses its default, so the only unset level picker is the walkthrough's.
    const walkthroughSelect = host.querySelector('[data-select-value="__default__"]');
    expect(walkthroughSelect).toBeTruthy();
    await act(async () => {
      walkthroughSelect?.querySelector<HTMLButtonElement>('button')?.click();
      await Promise.resolve();
    });
    expect(updateCalls.some((call) => call.walkthroughModelVariant === 'medium')).toBe(true);

    const walkthroughModelButton = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'sidecar/small');
    await act(async () => {
      walkthroughModelButton?.click();
      await Promise.resolve();
    });
    expect(updateCalls.some((call) => (
      call.walkthroughModelOverride === 'sidecar/other' && call.walkthroughModelVariant === ''
    ))).toBe(true);
  });
});
