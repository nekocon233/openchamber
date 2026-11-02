import React from 'react';

import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import type { DeepseekSetupStatus } from '@/lib/native-agents/deepseek';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useConfigStore } from '@/stores/useConfigStore';
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';

type Status = 'loading' | 'unavailable' | 'blocked' | 'missing' | 'ready' | 'error';
const setupRunning = (setup: DeepseekSetupStatus) => setup.state === 'installing';

export function DeepseekHarnessPage({ titleLeading }: { titleLeading?: React.ReactNode }) {
  const { nativeAgents } = useRuntimeAPIs();
  const { t } = useI18n();
  const enterpriseMode = useEnterpriseMode();
  const [status, setStatus] = React.useState<Status>('loading');
  const [diagnostic, setDiagnostic] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState(false);
  const [setup, setSetup] = React.useState<DeepseekSetupStatus>({ state: 'idle' });
  const mounted = React.useRef(true);
  const reads = React.useRef(0);
  const runtimeKey = getRuntimeKey();
  const current = React.useCallback(() => mounted.current && getRuntimeKey() === runtimeKey, [runtimeKey]);

  const load = React.useCallback(async () => {
    const request = ++reads.current;
    setStatus('loading');
    setFailure(false);
    setDiagnostic(null);
    if (enterpriseMode) { setStatus('blocked'); return; }
    try {
      const capabilities = await nativeAgents.capabilities();
      if (!current() || request !== reads.current) return;
      const backend = capabilities.backends.deepseek;
      if (!backend || backend.blockedByEnterprise) {
        setStatus(!backend ? 'unavailable' : 'blocked');
        return;
      }
      const setupState = await nativeAgents.deepseekSetupStatus();
      if (!current() || request !== reads.current) return;
      setSetup(setupState);
      if (!backend.cli) {
        setStatus('missing');
        return;
      }
      const catalog = await nativeAgents.catalog();
      if (!current() || request !== reads.current) return;
      const partition = catalog.backends.deepseek;
      if (!partition) {
        setStatus('error');
        return;
      }
      if (partition.status !== 'ok') {
        setStatus('error');
        setDiagnostic(partition.message);
        return;
      }
      setStatus('ready');
    } catch {
      if (current() && request === reads.current) setStatus('error');
    }
  }, [nativeAgents, current, enterpriseMode]);

  React.useEffect(() => {
    mounted.current = true;
    setBusy(false);
    setSetup({ state: 'idle' });
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
        if (next.state === 'ready') {
          await load();
          if (current()) void useConfigStore.getState().refreshNativeProviders();
        }
      }, () => {
        if (!controller.signal.aborted && current() && request === reads.current) setFailure(true);
      });
    }, 2000);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [setup, nativeAgents, current, load, enterpriseMode]);

  const startSetup = async () => {
    reads.current += 1;
    setBusy(true);
    setFailure(false);
    try {
      const next = await nativeAgents.setupDeepseek();
      if (!current()) return;
      setSetup(next);
      if (next.state === 'ready') await load();
    } catch {
      if (current()) setFailure(true);
    } finally { if (current()) setBusy(false); }
  };

  const message = setupRunning(setup) && status !== 'blocked' ? t('settings.deepseekHarness.installing')
    : status === 'loading' ? t('common.loading')
      : status === 'blocked' ? t('settings.deepseekHarness.enterprise')
        : status === 'missing' ? t('settings.deepseekHarness.missing')
          : status === 'ready' ? t('settings.deepseekHarness.ready')
            : status === 'unavailable' ? t('common.unavailable')
              : status === 'error' ? t('settings.deepseekHarness.loadFailed') : null;
  const setupError = setup.state === 'error' && status === 'missing'
    ? setup.code === 'NATIVE_DEEPSEEK_NODE_MISSING' ? t('settings.deepseekHarness.nodeMissing')
      : setup.code === 'NATIVE_DEEPSEEK_NPM_MISSING' ? t('settings.deepseekHarness.npmMissing')
        : t('settings.deepseekHarness.setupFailed')
    : null;
  return (
    <SettingsPageLayout title="DeepSeek Harness" titleLeading={titleLeading} description={t('settings.deepseekHarness.description')}>
      <SettingsSection settingsItem="providers.deepseek-harness" divider={false} contentClassName="space-y-3">
        {message ? <p className="text-sm text-foreground" role={status === 'error' ? 'alert' : 'status'}>{message}</p> : null}
        {setupError ? <p role="alert" className="text-sm text-[var(--status-error-text)]">{setupError}</p> : null}
        {failure ? <p role="alert" className="text-sm text-[var(--status-error-text)]">{t('settings.deepseekHarness.setupStatusFailed')}</p> : null}
        {diagnostic ? <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground" dir="auto">{diagnostic}</p> : null}
        <div className="flex flex-wrap gap-2">
          {status === 'missing' ? <Button disabled={busy || setupRunning(setup)} onClick={() => void startSetup()}>{t('settings.deepseekHarness.setup')}</Button> : null}
          <Button variant="outline" disabled={busy || status === 'loading'} onClick={() => void load()}>{t('settings.deepseekHarness.reload')}</Button>
        </div>
      </SettingsSection>
    </SettingsPageLayout>
  );
}
