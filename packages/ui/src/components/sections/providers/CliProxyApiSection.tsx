import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NumberInput } from '@/components/ui/number-input';
import {
  SettingsSection, SettingsStackedField, SettingsCheckboxRow, SettingsTwoColumn,
  SETTINGS_NUMBER_STEPPER_ROW_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n, type I18nKey } from '@/lib/i18n';
import type { ClaudeConnection } from '@/lib/native-agents/connections';
import { NativeAgentsRequestError } from '@/lib/native-agents/errors';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { openExternalUrl } from '@/lib/url';

const POLL_INTERVAL_MS = 1000;
const DEFAULT_MODEL = { modelID: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', contextWindow: 872000, outputLimit: 128000 };

const failureKey = (error: NativeAgentsRequestError): I18nKey => {
  switch (error.code) {
    case 'CLIPROXYAPI_NOT_REACHABLE': return 'settings.cliproxyapi.notReachable';
    case 'CLIPROXYAPI_MANAGEMENT_DISABLED': return 'settings.cliproxyapi.managementDisabled';
    case 'CLIPROXYAPI_KEY_REJECTED': return 'settings.cliproxyapi.keyRejected';
    case 'CLIPROXYAPI_UNSUPPORTED_TARGET': return 'settings.cliproxyapi.unsupportedTarget';
    case 'CLIPROXYAPI_PORT_IN_USE': return 'settings.cliproxyapi.portInUse';
    case 'CLIPROXYAPI_NOT_INSTALLED': return 'settings.cliproxyapi.notInstalled';
    case 'CLIPROXYAPI_DOWNLOAD_FAILED':
    case 'CLIPROXYAPI_START_FAILED': return 'settings.cliproxyapi.installFailed';
    default: return 'settings.cliproxyapi.failed';
  }
};

/**
 * The CLIProxyAPI gateway is a service OpenChamber runs itself: it downloads
 * the pinned build, generates its config and management key, and starts and
 * stops it here. This section signs a ChatGPT account in through the gateway's
 * own management API and writes the Claude Code connection that points at it.
 */
export const CliProxyApiSection: React.FC<{ onConnectionSaved?: (connection: ClaudeConnection) => void }> = ({ onConnectionSaved }) => {
  const { nativeAgents } = useRuntimeAPIs();
  const { t } = useI18n();
  const [status, setStatus] = React.useState<Awaited<ReturnType<typeof nativeAgents.cliproxyapiStatus>> | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<I18nKey | null>(null);
  const [proxy, setProxy] = React.useState('');
  const [attempt, setAttempt] = React.useState<{ state: string; expiresAt: number } | null>(null);
  const [pollTick, setPollTick] = React.useState(0);
  const [removing, setRemoving] = React.useState<string | null>(null);
  const [connectionName, setConnectionName] = React.useState('CLIProxyAPI');
  const [imported, setImported] = React.useState<{ count: number; skipped: number } | null>(null);
  const [model, setModel] = React.useState({ ...DEFAULT_MODEL, image: true });
  const mounted = React.useRef(true);
  const revision = React.useRef(0);
  const runtimeKey = getRuntimeKey();
  const attemptRef = React.useRef(attempt);
  attemptRef.current = attempt;

  const load = React.useCallback(async () => {
    const request = ++revision.current;
    try {
      const value = await nativeAgents.cliproxyapiStatus();
      if (mounted.current && getRuntimeKey() === runtimeKey && revision.current === request) {
        setStatus(value);
        setProxy((previous) => (previous === '' ? value.upstreamProxy ?? '' : previous));
      }
    } catch (error) {
      if (mounted.current && getRuntimeKey() === runtimeKey && revision.current === request) {
        setNotice(error instanceof NativeAgentsRequestError ? failureKey(error) : 'settings.cliproxyapi.failed');
        setStatus(null);
      }
    } finally {
      if (mounted.current && getRuntimeKey() === runtimeKey && revision.current === request) setLoading(false);
    }
  }, [nativeAgents, runtimeKey]);
  React.useEffect(() => { void load(); }, [load]);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const pending = attemptRef.current;
      // Leaving the page abandons the browser step, so the gateway should stop
      // waiting for it. A build without the cancel route leaves it to expire.
      if (pending) void nativeAgents.cancelCliproxyapiLogin(pending.state).catch(() => undefined);
    };
  }, [nativeAgents]);
  React.useEffect(() => {
    if (attempt === null || Date.now() > attempt.expiresAt) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const result = await nativeAgents.cliproxyapiLoginStatus(attempt.state);
          if (cancelled || !mounted.current || getRuntimeKey() !== runtimeKey) return;
          if (result.status === 'pending') { setPollTick((value) => value + 1); return; }
          setAttempt(null);
          if (result.status === 'connected') await load();
          else setNotice('settings.cliproxyapi.authFailed');
        } catch (error) {
          if (!cancelled && mounted.current && getRuntimeKey() === runtimeKey) {
            setAttempt(null);
            setNotice(error instanceof NativeAgentsRequestError ? failureKey(error) : 'settings.cliproxyapi.failed');
          }
        }
      })();
    }, POLL_INTERVAL_MS);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [attempt, pollTick, nativeAgents, load, runtimeKey]);

  const apply = (value: Awaited<ReturnType<typeof nativeAgents.cliproxyapiStatus>> | null) => {
    if (value !== null) setStatus(value);
  };
  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setNotice(null);
    try {
      await action();
    } catch (error) {
      if (mounted.current && getRuntimeKey() === runtimeKey) {
        setNotice(error instanceof NativeAgentsRequestError ? failureKey(error) : 'settings.cliproxyapi.failed');
      }
    } finally {
      if (mounted.current && getRuntimeKey() === runtimeKey) setBusy(false);
    }
  };
  const startGateway = () => act(async () => { apply(await nativeAgents.startCliproxyapiGateway()); });
  const stopGateway = () => act(async () => { apply(await nativeAgents.stopCliproxyapiGateway()); });
  const saveProxy = () => act(async () => {
    const value = proxy.trim();
    apply(await nativeAgents.setCliproxyapiProxy({ upstreamProxy: value === '' ? null : value }));
  });
  const signIn = () => act(async () => {
    const started = await nativeAgents.beginCliproxyapiLogin();
    if (!mounted.current || getRuntimeKey() !== runtimeKey) return;
    setAttempt({ state: started.state, expiresAt: Date.now() + 9 * 60 * 1000 });
    setPollTick(0);
    await openExternalUrl(started.url);
  });
  const cancelSignIn = () => act(async () => {
    if (attempt === null) return;
    const cancelled = await nativeAgents.cancelCliproxyapiLogin(attempt.state);
    if (!mounted.current || getRuntimeKey() !== runtimeKey) return;
    setAttempt(null);
    setNotice(cancelled ? null : 'settings.cliproxyapi.cancelUnavailable');
  });
  const removeAccount = (name: string) => act(async () => {
    await nativeAgents.removeCliproxyapiAccount(name);
    if (mounted.current && getRuntimeKey() === runtimeKey) setRemoving(null);
    await load();
  });
  const importModels = () => act(async () => {
    setImported(null);
    const result = await nativeAgents.importCliproxyapiModels();
    if (!mounted.current || getRuntimeKey() !== runtimeKey) return;
    setImported({ count: result.imported, skipped: result.skipped });
    onConnectionSaved?.(result.connection);
  });
  const saveConnection = () => act(async () => {
    const saved = await nativeAgents.saveCliproxyapiConnection({
      connectionId: null,
      name: connectionName.trim(),
      models: [{
        id: crypto.randomUUID(), name: model.name, modelID: model.modelID,
        contextWindow: model.contextWindow, outputLimit: model.outputLimit,
        input: { image: model.image, pdf: false }, efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      }],
    });
    if (!mounted.current || getRuntimeKey() !== runtimeKey) return;
    onConnectionSaved?.(saved);
    await load();
  });

  const install = status?.install ?? null;
  const outdated = install !== null && install.prepared && status?.installedVersion !== null && status?.installedVersion !== install.version;
  const gatewayState = install?.supported === false
    ? t('settings.cliproxyapi.unsupportedTarget')
    : status?.restarting
      ? t('settings.cliproxyapi.statusRestarting')
      : status?.ready
        ? t('settings.cliproxyapi.statusRunning')
        : status?.running
          ? t('settings.cliproxyapi.statusStarting')
          : t('settings.cliproxyapi.statusStopped');

  return (
    <SettingsSection title={t('settings.cliproxyapi.title')} settingsItem="providers.cliproxyapi" contentClassName="space-y-4">
      <p className="typography-ui-label text-muted-foreground">{t('settings.cliproxyapi.description')}</p>
      {loading ? <p role="status">{t('common.loading')}</p> : null}
      {notice ? <p role="alert" className="text-[var(--status-error-text)]">{t(notice)}</p> : null}
      {status?.lastError ? <p role="status" className="text-[var(--status-warning-text)]">{status.lastError}</p> : null}
      {status?.ready === true && status.managementEnabled === false ? <p role="status" className="text-[var(--status-warning-text)]">{t('settings.cliproxyapi.managementDisabled')}</p> : null}
      {status?.keyRejected === true ? <p role="status" className="text-[var(--status-warning-text)]">{t('settings.cliproxyapi.keyRejected')}</p> : null}

      <div className="flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-2">
          <span className={`size-2 shrink-0 rounded-full ${status?.ready ? 'bg-[var(--status-success)]' : 'bg-[var(--status-warning)]'}`} />
          <span role="status">{gatewayState}</span>
        </span>
        <span className="text-muted-foreground">
          {install === null ? '' : t('settings.cliproxyapi.installedVersion', { version: install.prepared ? status?.installedVersion ?? install.version : install.version })}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {status?.running === true || status?.enabled === true ? (
          <Button type="button" disabled={busy || status?.restarting === true} onClick={() => void stopGateway()}>{busy ? t('settings.cliproxyapi.statusStopping') : t('settings.cliproxyapi.stop')}</Button>
        ) : (
          <Button type="button" disabled={busy || install?.supported === false} onClick={() => void startGateway()}>
            {busy
              ? t('settings.cliproxyapi.statusStarting')
              : install?.supported !== false && (outdated || install?.prepared === false)
                ? t('settings.cliproxyapi.downloadAndStart')
                : t('settings.cliproxyapi.start')}
          </Button>
        )}
      </div>

      <SettingsStackedField label={t('settings.cliproxyapi.upstreamProxy')} info={t('settings.cliproxyapi.upstreamProxyHint')}>
        <div className="flex flex-wrap items-center gap-2">
          <Input className="h-8" type="url" aria-label={t('settings.cliproxyapi.upstreamProxy')} value={proxy} disabled={busy || status?.restarting === true} onChange={(event) => setProxy(event.target.value)} />
          <Button type="button" variant="outline" disabled={busy || status?.restarting === true} onClick={() => void saveProxy()}>{t('settings.claudeConnections.save')}</Button>
        </div>
      </SettingsStackedField>

      <SettingsSection title={t('settings.cliproxyapi.accounts')} contentClassName="space-y-2">
        {status?.accounts.length === 0 ? <p className="text-muted-foreground">{t('settings.cliproxyapi.noAccounts')}</p> : null}
        {(status?.accounts ?? []).map((account) => (
          <SettingsStackedField
            key={account.name}
            label={account.email ?? account.name}
            info={[account.planType, account.activeUntil].filter((part) => part !== null && part !== '').join(' · ')}
          >
            {removing === account.name ? (
              <div className="flex flex-wrap items-center gap-2">
                <span>{t('settings.cliproxyapi.removeAccountHint')}</span>
                <Button variant="destructive" disabled={busy} onClick={() => void removeAccount(account.name)}>{t('settings.cliproxyapi.remove')}</Button>
                <Button variant="ghost" disabled={busy} onClick={() => setRemoving(null)}>{t('settings.claudeConnections.cancel')}</Button>
              </div>
            ) : (
              <Button variant="ghost" disabled={busy} onClick={() => setRemoving(account.name)}>{t('settings.cliproxyapi.remove')}</Button>
            )}
          </SettingsStackedField>
        ))}
      </SettingsSection>

      <SettingsSection title={t('settings.cliproxyapi.signIn')} contentClassName="space-y-2">
        {attempt === null ? (
          <Button type="button" disabled={busy || status?.managementEnabled !== true} onClick={() => void signIn()}>{t('settings.cliproxyapi.signIn')}</Button>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span role="status">{t('settings.cliproxyapi.pending')}</span>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => void cancelSignIn()}>{t('settings.claudeConnections.cancel')}</Button>
          </div>
        )}
      </SettingsSection>

      <SettingsSection title={t('settings.claudeConnections.connection')} contentClassName="space-y-4">
        <p className="typography-ui-label text-muted-foreground">{t('settings.cliproxyapi.connectionHint')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" disabled={busy || status?.ready !== true} onClick={() => void importModels()}>{t('settings.cliproxyapi.importModels')}</Button>
          {imported === null ? null : (
            <span role="status" className="text-muted-foreground">
              {t('settings.cliproxyapi.imported', { count: imported.count })}
              {imported.skipped === 0 ? null : <span> · {t('settings.cliproxyapi.importSkipped', { count: imported.skipped })}</span>}
            </span>
          )}
        </div>
        <p className="typography-ui-label text-muted-foreground">{t('settings.cliproxyapi.importHint')}</p>
        <SettingsTwoColumn>
          <SettingsStackedField label={t('settings.claudeConnections.name')}>
            <Input className="h-8" aria-label={t('settings.claudeConnections.name')} value={connectionName} disabled={busy} onChange={(event) => setConnectionName(event.target.value)} />
          </SettingsStackedField>
          <SettingsStackedField label={t('settings.claudeConnections.modelID')}>
            <Input className="h-8" aria-label={t('settings.claudeConnections.modelID')} value={model.modelID} disabled={busy} onChange={(event) => setModel({ ...model, modelID: event.target.value })} />
          </SettingsStackedField>
          <SettingsStackedField label={t('settings.claudeConnections.name')}>
            <Input className="h-8" aria-label={t('settings.claudeConnections.name')} value={model.name} disabled={busy} onChange={(event) => setModel({ ...model, name: event.target.value })} />
          </SettingsStackedField>
          <SettingsStackedField label={t('settings.claudeConnections.context')}>
            <div className={SETTINGS_NUMBER_STEPPER_ROW_CLASS}><NumberInput min={1024} max={10_000_000} aria-label={t('settings.claudeConnections.context')} value={model.contextWindow} onValueChange={(contextWindow) => setModel({ ...model, contextWindow })} /></div>
          </SettingsStackedField>
          <SettingsStackedField label={t('settings.claudeConnections.output')}>
            <div className={SETTINGS_NUMBER_STEPPER_ROW_CLASS}><NumberInput min={1} max={1_000_000} aria-label={t('settings.claudeConnections.output')} value={model.outputLimit} onValueChange={(outputLimit) => setModel({ ...model, outputLimit })} /></div>
          </SettingsStackedField>
        </SettingsTwoColumn>
        <SettingsCheckboxRow checked={model.image} onChange={(image) => setModel({ ...model, image })} label={t('settings.claudeConnections.image')} />
        <Button type="button" disabled={busy || status?.ready !== true || connectionName.trim() === '' || model.modelID.trim() === ''} onClick={() => void saveConnection()}>{status?.connection == null ? t('settings.cliproxyapi.createConnection') : t('settings.cliproxyapi.updateConnection')}</Button>
      </SettingsSection>
    </SettingsSection>
  );
};
