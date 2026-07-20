import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/fonts'
import './index.css'
import App from './App.tsx'
import { SessionAuthGate } from './components/auth/SessionAuthGate'
import { ThemeSystemProvider } from './contexts/ThemeSystemContext'
import { ThemeProvider } from './components/providers/ThemeProvider'
import './lib/debug'
import { syncDesktopSettings, initializeAppearancePreferences } from './lib/persistence'
import { startAppearanceAutoSave } from './lib/appearanceAutoSave'
import { applyPersistedDirectoryPreferences } from './lib/directoryPersistence'
import { startTypographyWatcher } from './lib/typographyWatcher'
import { startModelPrefsAutoSave } from './lib/modelPrefsAutoSave'
import { initializeLocale, I18nProvider } from './lib/i18n'
import type { RuntimeAPIs } from './lib/api/types'
import { getPWADisplayMode } from './lib/pwa'
import { useSessionUIStore } from './sync/session-ui-store'

declare global {
  interface Window {
    __OPENCHAMBER_RUNTIME_APIS__?: RuntimeAPIs;
  }
}

const runtimeAPIs = (typeof window !== 'undefined' && window.__OPENCHAMBER_RUNTIME_APIS__) || (() => {
  throw new Error('Runtime APIs not provided for legacy UI entrypoint.');
})();

const shouldRestorePrimaryNavigation = typeof window !== 'undefined' && (
  window.__OPENCHAMBER_ELECTRON__?.windowRole === 'main'
  || getPWADisplayMode() !== 'browser'
);

if (shouldRestorePrimaryNavigation) {
  // Restore before React mounts so the automatic draft startup cannot replace
  // the primary surface's last real conversation. Secondary windows stay fresh.
  useSessionUIStore.getState().restoreForRuntimeSwitch();
}

initializeLocale();

// Initialize settings asynchronously — the app renders with defaults first
// and hydrates once persisted preferences are applied. Users with non-default
// themes may briefly see default appearance on cold start; accepted trade-off
// for faster time-to-first-paint.
void initializeAppearancePreferences().then(() => {
  void Promise.all([
    syncDesktopSettings(),
    applyPersistedDirectoryPreferences(),
  ]).catch((err) => {
    console.error('[main] settings init failed:', err);
  });

  // Start watchers regardless of whether secondary settings succeed.
  startAppearanceAutoSave();
  startModelPrefsAutoSave();
  startTypographyWatcher();
}).catch((err) => {
  console.error('[main] appearance init failed:', err);
});


const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <I18nProvider>
      <ThemeSystemProvider>
        <ThemeProvider>
          <SessionAuthGate>
            <App apis={runtimeAPIs} />
          </SessionAuthGate>
        </ThemeProvider>
      </ThemeSystemProvider>
    </I18nProvider>
  </StrictMode>,
);
