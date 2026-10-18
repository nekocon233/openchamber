import React from 'react';

import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection, SettingsStackedField } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { deepseekConfigurationWriteSchema, type DeepseekConfiguration, type DeepseekConfigurationWrite, type DeepseekSetupStatus } from '@/lib/native-agents/deepseek';
import { NativeAgentsRequestError } from '@/lib/native-agents/errors';
import { reportSettingsSaveState } from '@/lib/persistence';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useConfigStore } from '@/stores/useConfigStore';
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';

type Status = 'loading' | 'unavailable' | 'blocked' | 'missing' | 'ready' | 'error';
type Failure = 'loadFailed' | 'saveFailed' | 'conflict' | 'credentialFailed' | 'invalid' | 'setupStatusFailed' | null;
const setupRunning = (setup: DeepseekSetupStatus) => setup.state === 'installing' || setup.state === 'configuring';

export function DeepseekHarnessPage({ titleLeading }: { titleLeading?: React.ReactNode }) {
  const { nativeAgents } = useRuntimeAPIs();
  const { t } = useI18n();
  const enterpriseMode = useEnterpriseMode();
  const [status, setStatus] = React.useState<Status>('loading');
  const [configuration, setConfiguration] = React.useState<DeepseekConfiguration | null>(null);
  const [baseURL, setBaseURL] = React.useState('');
  const [modelIDs, setModelIDs] = React.useState('');
  const [apiKey, setApiKey] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState<Failure>(null);
  const [setup, setSetup] = React.useState<DeepseekSetupStatus>({ state: 'idle' });
  const mounted = React.useRef(true);
  const reads = React.useRef(0);
  const runtimeKey = getRuntimeKey();
  const current = React.useCallback(() => mounted.current && getRuntimeKey() === runtimeKey, [runtimeKey]);

  const load = React.useCallback(async () => {
    const request = ++reads.current;
    setStatus('loading');
    setFailure(null);
    if (enterpriseMode) { setStatus('blocked'); setConfiguration(null); setApiKey(''); return; }
    try {
      const capabilities = await nativeAgents.capabilities();
      if (!current() || request !== reads.current) return;
      const backend = capabilities.backends.deepseek;
      if (!backend || backend.blockedByEnterprise) {
        setConfiguration(null);
        setStatus(!backend ? 'unavailable' : 'blocked');
        return;
      }
      const setupState = await nativeAgents.deepseekSetupStatus();
      if (!current() || request !== reads.current) return;
      setSetup(setupState);
      if (!backend.cli || setupRunning(setupState)) {
        setConfiguration(null);
        setStatus('missing');
        return;
      }
      const config = await nativeAgents.deepseekConfiguration();
      if (!current() || request !== reads.current) return;
      setConfiguration(config);
      setBaseURL(config.baseURL ?? '');
      setModelIDs(config.modelIDs.join(', '));
      setApiKey('');
      setStatus('ready');
    } catch {
      if (current() && request === reads.current) { setStatus('error'); setFailure('loadFailed'); }
    }
  }, [nativeAgents, current, enterpriseMode]);

  React.useEffect(() => {
    mounted.current = true;
    setBusy(false);
    setSetup({ state: 'idle' });
    setConfiguration(null);
    setApiKey('');
    void load();
    return () => { mounted.current = false; reads.current += 1; };
  }, [load]);

  React.useEffect(() => {
    if (!setupRunning(setup) || enterpriseMode) return;
    const controller = new AbortController();
    const request = reads.current;
    const timer = window.setTimeout(() => {
      void nativeAgents.deepseekSetupStatus({ signal: controller.signal }).then(async (next) => {
        if (controller.signal.aborted || !current() || request !== reads.current) return;
        setSetup(next);
        if (!setupRunning(next)) {
          await load();
          if (current()) void useConfigStore.getState().refreshNativeProviders();
        }
      }, () => {
        if (!controller.signal.aborted && current() && request === reads.current) setFailure('setupStatusFailed');
      });
    }, 2000);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [setup, nativeAgents, current, load, enterpriseMode]);

  const startSetup = async () => {
    reads.current += 1;
    setBusy(true);
    setFailure(null);
    try {
      const next = await nativeAgents.setupDeepseek();
      if (!current()) return;
      setSetup(next);
      if (!setupRunning(next)) await load();
    } catch {
      if (current()) setFailure('setupStatusFailed');
    } finally { if (current()) setBusy(false); }
  };

  const save = async () => {
    if (!configuration) return;
    const draft: DeepseekConfigurationWrite = {
      revision: configuration.revision, baseURL: baseURL.trim() || null,
      modelIDs: modelIDs.split(',').map((id) => id.trim()),
    };
    if (apiKey.trim()) draft.apiKey = apiKey.trim();
    const parsed = deepseekConfigurationWriteSchema.safeParse(draft);
    if (!parsed.success || (!configuration.credential.configured && !parsed.data.apiKey)) { setFailure('invalid'); return; }
    reads.current += 1;
    setBusy(true);
    setFailure(null);
    reportSettingsSaveState('saving');
    try {
      const result = await nativeAgents.saveDeepseekConfiguration(parsed.data);
      if (getRuntimeKey() !== runtimeKey) return;
      reportSettingsSaveState(result.status === 'saved' ? 'saved' : 'error');
      void useConfigStore.getState().refreshNativeProviders();
      if (!current()) return;
      setConfiguration(result.configuration);
      setBaseURL(result.configuration.baseURL ?? '');
      setModelIDs(result.configuration.modelIDs.join(', '));
      if (result.status === 'credential-error') {
        setFailure('credentialFailed');
      } else {
        setApiKey('');
      }
    } catch (error) {
      if (getRuntimeKey() === runtimeKey) reportSettingsSaveState('error');
      if (current()) {
        setFailure(error instanceof NativeAgentsRequestError && error.code === 'NATIVE_DEEPSEEK_SETTINGS_CONFLICT' ? 'conflict' : 'saveFailed');
      }
    } finally { if (current()) setBusy(false); }
  };

  const message = setupRunning(setup) && status !== 'blocked' ? t(setup.state === 'installing' ? 'settings.deepseekHarness.installing' : 'settings.deepseekHarness.configuring')
    : setup.state === 'needs-key' && status === 'ready' && !configuration?.credential.configured ? t('settings.deepseekHarness.needsKey')
      : status === 'loading' ? t('common.loading')
    : status === 'blocked' ? t('settings.deepseekHarness.enterprise')
      : status === 'missing' ? t('settings.deepseekHarness.missing')
        : status === 'ready' ? t('settings.deepseekHarness.ready')
          : status === 'unavailable' ? t('common.unavailable') : null;
  const setupError = setup.state === 'error' && !(status === 'ready' && configuration?.credential.configured)
    ? setup.code === 'NATIVE_DEEPSEEK_NODE_MISSING' ? t('settings.deepseekHarness.nodeMissing')
      : setup.code === 'NATIVE_DEEPSEEK_NPM_MISSING' ? t('settings.deepseekHarness.npmMissing')
        : t('settings.deepseekHarness.setupFailed')
    : null;
  return (
    <SettingsPageLayout title="DeepSeek Harness" titleLeading={titleLeading} description={t('settings.deepseekHarness.description')} showSaveStatus>
      <SettingsSection settingsItem="providers.deepseek-harness" divider={false} contentClassName="space-y-3">
        {message ? <p className="text-sm text-foreground" role="status">{message}</p> : null}
        {setupError ? <p role="alert" className="text-sm text-[var(--status-error-text)]">{setupError}</p> : null}
        {failure ? <p role="alert" className="text-sm text-[var(--status-error-text)]">{t(`settings.deepseekHarness.${failure}`)}</p> : null}
        {status !== 'loading' && status !== 'blocked' && status !== 'unavailable' ? <div className="flex flex-wrap gap-2">
          <Button disabled={busy || setupRunning(setup)} onClick={() => void startSetup()}>{t('settings.deepseekHarness.setup')}</Button>
          <Button variant="outline" disabled={busy} onClick={() => void load()}>{t('settings.deepseekHarness.reload')}</Button>
        </div> : null}
      </SettingsSection>
      {status === 'ready' && configuration ? <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <fieldset disabled={busy || setupRunning(setup) || !configuration.writable}>
          <SettingsSection title={t('settings.deepseekHarness.configuration')} contentClassName="space-y-4">
            {!configuration.writable ? <p role="status" className="text-sm text-muted-foreground">{t('settings.deepseekHarness.readOnly')}</p> : null}
            <SettingsStackedField label={t('settings.deepseekHarness.baseURL')} info={t('settings.deepseekHarness.baseURLHint')}>
              <Input type="url" dir="ltr" maxLength={2048} aria-label={t('settings.deepseekHarness.baseURL')} placeholder={t('settings.deepseekHarness.baseURLPlaceholder')} value={baseURL} onChange={(event) => setBaseURL(event.target.value)} />
            </SettingsStackedField>
            <SettingsStackedField label={t('settings.deepseekHarness.key')} info={t(configuration.credential.writable ? 'settings.deepseekHarness.keyHint' : 'settings.deepseekHarness.keyReadOnly')}>
              <Input type="password" dir="ltr" autoComplete="new-password" maxLength={8192} disabled={!configuration.credential.writable} required={!configuration.credential.configured} aria-label={t('settings.deepseekHarness.key')} placeholder={configuration.credential.configured ? t('settings.deepseekHarness.keyHint') : undefined} value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
            </SettingsStackedField>
            <SettingsStackedField label={t('settings.deepseekHarness.models')} info={t('settings.deepseekHarness.modelsHint')}>
              <Input dir="ltr" required spellCheck={false} aria-label={t('settings.deepseekHarness.models')} value={modelIDs} onChange={(event) => setModelIDs(event.target.value)} />
            </SettingsStackedField>
            <Button type="submit">{busy ? t('common.loading') : t('settings.deepseekHarness.save')}</Button>
          </SettingsSection>
        </fieldset>
      </form> : null}
    </SettingsPageLayout>
  );
}
