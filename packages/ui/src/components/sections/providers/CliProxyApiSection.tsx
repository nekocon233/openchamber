import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { NumberInput } from '@/components/ui/number-input';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import {
  SettingsSection, SettingsStackedField, SettingsFieldRow, SettingsCheckboxRow, SettingsTwoColumn,
  SETTINGS_NUMBER_STEPPER_ROW_CLASS, SETTINGS_CONTROL_CLUSTER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n, type I18nKey } from '@/lib/i18n';
import type { CliproxyapiStatus, CliproxyapiOAuthProvider } from '@/lib/native-agents/connections';
import { NativeAgentsRequestError } from '@/lib/native-agents/errors';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { openExternalUrl } from '@/lib/url';
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';

const POLL_INTERVAL_MS = 1000;
const LOGIN_PROVIDERS: CliproxyapiOAuthProvider[] = ['codex', 'antigravity', 'claude'];
const DEFAULT_MODEL = { modelID: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', contextWindow: 872000, outputLimit: 128000 };

const failureKey = (error: NativeAgentsRequestError): I18nKey => {
  switch (error.code) {
    case 'enterprise_mode': return 'settings.providers.enterpriseMode';
    case 'CLIPROXYAPI_NOT_REACHABLE': return 'settings.cliproxyapi.notReachable';
    case 'CLIPROXYAPI_MANAGEMENT_DISABLED': return 'settings.cliproxyapi.managementDisabled';
    case 'CLIPROXYAPI_KEY_REJECTED': return 'settings.cliproxyapi.keyRejected';
    case 'CLIPROXYAPI_UNSUPPORTED_TARGET': return 'settings.cliproxyapi.unsupportedTarget';
    case 'CLIPROXYAPI_PORT_IN_USE': return 'settings.cliproxyapi.portInUse';
    case 'CLIPROXYAPI_NOT_INSTALLED': return 'settings.cliproxyapi.notInstalled';
    case 'CLIPROXYAPI_DOWNLOAD_FAILED':
    case 'CLIPROXYAPI_START_FAILED': return 'settings.cliproxyapi.installFailed';
    case 'CLIPROXYAPI_LOGIN_CALLBACK_INVALID': return 'settings.cliproxyapi.callbackInvalid';
    case 'CLIPROXYAPI_LOGIN_CALLBACK_MISMATCH': return 'settings.cliproxyapi.callbackMismatch';
    case 'CLIPROXYAPI_LOGIN_CALLBACK_REJECTED': return 'settings.cliproxyapi.callbackRejected';
    default: return 'settings.cliproxyapi.failed';
  }
};

/** The gateway's own explanation, shown under the translated failure line. */
type Notice = { key: I18nKey; detail: string | null };
const failedNotice: Notice = { key: 'settings.cliproxyapi.failed', detail: null };
const noticeOf = (error: NativeAgentsRequestError): Notice => ({
  key: failureKey(error),
  detail: error.code === 'CLIPROXYAPI_LOGIN_CALLBACK_REJECTED' ? error.message : null,
});

/**
 * The ChatGPT sign-in row of the Claude Code connection list. The CLIProxyAPI
 * gateway behind it is a service OpenChamber runs itself, and this row keeps
 * that out of the way: the button brings the gateway up (downloading the
 * pinned build on first use), starts the browser sign-in through the gateway's
 * management API, accepts a pasted callback address for browsers that cannot
 * reach it, and writes the Claude Code connection on success. The signed-in
 * accounts sit under the row, and the gateway's own state and settings stay
 * behind an advanced disclosure that only appears when something is wrong.
 */
export const CliProxyApiSection: React.FC<{ onConnectionsChanged?: () => Promise<void> }> = ({ onConnectionsChanged }) => {
  const { nativeAgents } = useRuntimeAPIs();
  const { t } = useI18n();
  const enterpriseMode = useEnterpriseMode();
  const [status, setStatus] = React.useState<Awaited<ReturnType<typeof nativeAgents.cliproxyapiStatus>> | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<Notice | null>(null);
  const [callbackUrl, setCallbackUrl] = React.useState('');
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const [settingUp, setSettingUp] = React.useState<CliproxyapiOAuthProvider | null>(null);
  const [proxy, setProxy] = React.useState('');
  const [attempt, setAttempt] = React.useState<{ state: string; expiresAt: number; provider: CliproxyapiOAuthProvider } | null>(null);
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
  const connectionsChangedRef = React.useRef(onConnectionsChanged);
  connectionsChangedRef.current = onConnectionsChanged;

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
        setNotice(error instanceof NativeAgentsRequestError ? noticeOf(error) : failedNotice);
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
      if (pending && getRuntimeKey() === runtimeKey) void nativeAgents.cancelCliproxyapiLogin(pending.state).catch(() => undefined);
    };
  }, [nativeAgents, runtimeKey]);
  React.useEffect(() => {
    if (attempt === null) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          if (Date.now() > attempt.expiresAt) {
            setAttempt(null);
            setNotice({ key: 'settings.cliproxyapi.authFailed', detail: null });
            await nativeAgents.cancelCliproxyapiLogin(attempt.state).catch(() => undefined);
            return;
          }
          const result = await nativeAgents.cliproxyapiLoginStatus(attempt.state);
          if (cancelled || !mounted.current || getRuntimeKey() !== runtimeKey) return;
          if (result.status === 'pending') { setPollTick((value) => value + 1); return; }
          if (result.status === 'connected') {
            await load();
            if (cancelled || !mounted.current || getRuntimeKey() !== runtimeKey) return;
            // The click that finished the sign-in also writes the connection so
            // the models show up in the picker. A failure here is a notice, not
            // a failed sign-in: the account is already stored.
            try {
              const connected = await nativeAgents.importCliproxyapiModels();
              if (!cancelled && mounted.current && getRuntimeKey() === runtimeKey) {
                setImported({ count: connected.imported, skipped: connected.skipped });
                await connectionsChangedRef.current?.();
                await load();
              }
            } catch (error) {
              if (!cancelled && mounted.current && getRuntimeKey() === runtimeKey) {
                setNotice(error instanceof NativeAgentsRequestError ? noticeOf(error) : failedNotice);
              }
            }
          } else setNotice({ key: 'settings.cliproxyapi.authFailed', detail: result.message });
          if (!cancelled && mounted.current && getRuntimeKey() === runtimeKey) setAttempt(null);
        } catch (error) {
          if (!cancelled && mounted.current && getRuntimeKey() === runtimeKey) {
            setAttempt(null);
            setNotice(error instanceof NativeAgentsRequestError ? noticeOf(error) : failedNotice);
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
        setNotice(error instanceof NativeAgentsRequestError ? noticeOf(error) : failedNotice);
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
  const signIn = (provider: CliproxyapiOAuthProvider) => act(async () => {
    // The gateway is an implementation detail of this button: bring it up
    // (downloading the pinned build on first use) before the browser step.
    setSettingUp(provider);
    try {
      apply(await nativeAgents.startCliproxyapiGateway());
      if (!mounted.current || getRuntimeKey() !== runtimeKey) return;
      const started = await nativeAgents.beginCliproxyapiLogin(provider);
      if (!mounted.current || getRuntimeKey() !== runtimeKey) return;
      setCallbackUrl('');
      setAttempt({ state: started.state, expiresAt: Date.now() + 9 * 60 * 1000, provider });
      setPollTick(0);
      await openExternalUrl(started.url);
    } finally {
      if (mounted.current && getRuntimeKey() === runtimeKey) setSettingUp(null);
    }
  });
  const cancelSignIn = () => act(async () => {
    if (attempt === null) return;
    const cancelled = await nativeAgents.cancelCliproxyapiLogin(attempt.state);
    if (!mounted.current || getRuntimeKey() !== runtimeKey) return;
    setAttempt(null);
    setNotice(cancelled ? null : { key: 'settings.cliproxyapi.cancelUnavailable', detail: null });
  });
  const submitCallback = () => act(async () => {
    if (attempt === null) return;
    try {
      await nativeAgents.submitCliproxyapiLoginCallback(attempt.state, callbackUrl.trim());
    } catch (error) {
      // The gateway no longer knows this attempt, so nothing is left to poll:
      // its status answers `wait` for an unknown state until the attempt expires.
      if (error instanceof NativeAgentsRequestError && error.code === 'CLIPROXYAPI_LOGIN_CALLBACK_REJECTED'
        && mounted.current && getRuntimeKey() === runtimeKey) setAttempt(null);
      throw error;
    }
    if (!mounted.current || getRuntimeKey() !== runtimeKey) return;
    setCallbackUrl('');
    setPollTick((value) => value + 1);
  });
  const removeAccount = (name: string) => act(async () => {
    try {
      await nativeAgents.removeCliproxyapiAccount(name);
    } finally {
      // The credential may already be gone when model reconciliation fails.
      // Re-read both views without publishing into a different runtime.
      if (mounted.current && getRuntimeKey() === runtimeKey) {
        setRemoving(null);
        await load();
        if (mounted.current && getRuntimeKey() === runtimeKey) await onConnectionsChanged?.();
      }
    }
  });
  const importModels = () => act(async () => {
    setImported(null);
    const result = await nativeAgents.importCliproxyapiModels();
    if (!mounted.current || getRuntimeKey() !== runtimeKey) return;
    setImported({ count: result.imported, skipped: result.skipped });
    await onConnectionsChanged?.();
  });
  const saveConnection = () => act(async () => {
    await nativeAgents.saveCliproxyapiConnection({
      connectionId: null,
      name: connectionName.trim(),
      models: [{
        id: crypto.randomUUID(), name: model.name, modelID: model.modelID,
        contextWindow: model.contextWindow, outputLimit: model.outputLimit,
        input: { image: model.image, pdf: false }, efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      }],
    });
    if (!mounted.current || getRuntimeKey() !== runtimeKey) return;
    await onConnectionsChanged?.();
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
  // The gateway manages itself through the sign-in button, so its controls
  // stay hidden until something is wrong and a person has to look.
  const gatewayTrouble = status !== null && (
    install?.supported === false
    || status.lastError !== null
    || status.keyRejected === true
    || (status.ready && status.managementEnabled === false)
  );
  // The first account shares the row with the gateway's name: signed in means
  // the row shows who, and only signing out brings the sign-in button back.
  const accounts = status?.accounts ?? [];
  const primaryAccounts = LOGIN_PROVIDERS.flatMap((provider) => {
    const account = accounts.find((candidate) => candidate.provider === provider);
    return account ? [account] : [];
  });
  const others = accounts.filter((account) => !primaryAccounts.includes(account));
  const gatewayName = status?.connection?.name ?? 'CLIProxyAPI';
  const accountInfo = (account: CliproxyapiStatus['accounts'][number]) => [account.planType, account.activeUntil].filter((part) => part !== null && part !== '').join(' · ');

  return (
    <>
      {LOGIN_PROVIDERS.filter((provider) => provider === 'codex' || status?.loginProviders.includes(provider)).map((provider) => {
        const primary = primaryAccounts.find((account) => account.provider === provider) ?? null;
        const label = provider === 'codex' ? gatewayName : provider === 'claude' ? 'Claude' : 'Antigravity';
        const settingsItem = provider === 'codex' ? 'providers.cliproxyapi' : `providers.cliproxyapi-${provider}`;
        return primary !== null && removing === primary.name ? (
        <SettingsStackedField key={provider} label={label} settingsItem={settingsItem}>
          <div className="space-y-2">
            <p>{t('settings.cliproxyapi.removeAccountHint')}</p>
            <div className="flex gap-2">
              <Button variant="destructive" disabled={busy} onClick={() => void removeAccount(primary.name)}>{t('settings.cliproxyapi.remove')}</Button>
              <Button variant="ghost" disabled={busy} onClick={() => setRemoving(null)}>{t('settings.claudeConnections.cancel')}</Button>
            </div>
          </div>
        </SettingsStackedField>
      ) : (
        <SettingsFieldRow key={provider} label={label} settingsItem={settingsItem}
          alignEnd={false} controlClassName={`${SETTINGS_CONTROL_CLUSTER_CLASS} @xl:flex-1`}
          info={provider === 'antigravity' ? t('settings.cliproxyapi.antigravityHint') : provider === 'claude' ? t('settings.cliproxyapi.claudeHint') : undefined}>
          {attempt?.provider === provider ? (
            <span className="flex flex-wrap items-center gap-2">
              <span role="status">{t('settings.cliproxyapi.pending')}</span>
              <Button type="button" variant="ghost" disabled={busy} onClick={() => void cancelSignIn()}>{t('settings.claudeConnections.cancel')}</Button>
            </span>
          ) : primary === null ? (
            <Button type="button" disabled={enterpriseMode || busy || attempt !== null || status === null || install?.supported === false} onClick={() => void signIn(provider)}>
              {settingUp === provider ? t('settings.cliproxyapi.settingUp') : t(provider === 'codex' ? 'settings.cliproxyapi.signIn' : provider === 'claude' ? 'settings.cliproxyapi.claudeSignIn' : 'settings.cliproxyapi.antigravitySignIn')}
            </Button>
          ) : (
            <>
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-muted-foreground" dir="auto">{primary.email ?? primary.name}</span>
                {accountInfo(primary) === '' ? null : <SettingsInfoHint>{accountInfo(primary)}</SettingsInfoHint>}
              </span>
              <Button type="button" variant="ghost" disabled={busy} onClick={() => setRemoving(primary.name)}>{t('settings.cliproxyapi.remove')}</Button>
            </>
          )}
        </SettingsFieldRow>
      ); })}
      {status?.loginProviders.includes('claude') ? ['opus', 'sonnet'].map((family) => {
        const route = family === 'opus' ? status.opusFailover : status.sonnetFailover;
        if (!route) return null;
        const model = family === 'opus' ? 'Opus' : 'Sonnet';
        return <SettingsCheckboxRow key={family} settingsItem={`providers.cliproxyapi-${family}`} checked={route.enabled}
          disabled={enterpriseMode || busy || attempt !== null}
          label={t('settings.cliproxyapi.familyFailover', { model })} ariaLabel={t('settings.cliproxyapi.familyFailover', { model })}
          info={t('settings.cliproxyapi.familyHint', { model })}
          description={route.enabled && !route.ready ? t('settings.cliproxyapi.familyWaiting', { model }) : undefined}
          onChange={(enabled) => { void act(async () => {
            const value = await (family === 'opus' ? nativeAgents.setCliproxyapiOpusRoute(enabled) : nativeAgents.setCliproxyapiSonnetRoute(enabled));
            if (!mounted.current || getRuntimeKey() !== runtimeKey) return;
            apply(value);
            await connectionsChangedRef.current?.();
          }); }} />;
      }) : null}
      <div className="space-y-2 ps-6">
        {enterpriseMode ? <p role="status" className="typography-meta text-muted-foreground">{t('settings.providers.enterpriseMode')}</p> : null}
        {loading ? <p role="status">{t('common.loading')}</p> : null}
        {notice ? (
          <p role="alert" className="text-[var(--status-error-text)]">
            {t(notice.key)}
            {notice.detail === null ? null : <span className="block break-words">{notice.detail}</span>}
          </p>
        ) : null}
        {status?.lastError ? <p role="status" className="text-[var(--status-warning-text)]">{status.lastError}</p> : null}
        {status?.ready === true && status.managementEnabled === false ? <p role="status" className="text-[var(--status-warning-text)]">{t('settings.cliproxyapi.managementDisabled')}</p> : null}
        {status?.keyRejected === true ? <p role="status" className="text-[var(--status-warning-text)]">{t('settings.cliproxyapi.keyRejected')}</p> : null}
        {install?.supported === false ? <p role="status" className="text-[var(--status-warning-text)]">{t('settings.cliproxyapi.unsupportedTarget')}</p> : null}
        {others.map((account) => (
          <SettingsFieldRow
            key={account.name}
            label={account.email ?? account.name}
            info={accountInfo(account)}
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
          </SettingsFieldRow>
        ))}
        {attempt === null ? null : (
          <div className="space-y-3">
            <p className="typography-ui-label text-muted-foreground">{t('settings.cliproxyapi.callbackHint')}</p>
            <SettingsStackedField label={t('settings.cliproxyapi.callbackUrl')}>
              <div className="flex flex-wrap items-center gap-2">
                <Input className="h-8" type="url" aria-label={t('settings.cliproxyapi.callbackUrl')} value={callbackUrl} disabled={busy} onChange={(event) => setCallbackUrl(event.target.value)} />
                <Button type="button" variant="outline" disabled={enterpriseMode || busy || callbackUrl.trim() === ''} onClick={() => void submitCallback()}>{t('settings.cliproxyapi.callbackSubmit')}</Button>
              </div>
            </SettingsStackedField>
          </div>
        )}
        {imported === null ? null : (
          <p role="status" className="text-muted-foreground">
            {t('settings.cliproxyapi.imported', { count: imported.count })}
            {imported.skipped === 0 ? null : <span> · {t('settings.cliproxyapi.importSkipped', { count: imported.skipped })}</span>}
          </p>
        )}

        {gatewayTrouble ? (
          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <CollapsibleTrigger className="w-fit gap-1 rounded-md px-1 py-0.5 typography-ui-label text-muted-foreground hover:bg-transparent hover:text-foreground">
              {t('settings.cliproxyapi.advanced')}
              <Icon name={advancedOpen ? 'arrow-up-s' : 'arrow-down-s'} className="size-3.5" />
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-4 pt-3">
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

              <SettingsSection title={t('settings.claudeConnections.connection')} contentClassName="space-y-4">
                <p className="typography-ui-label text-muted-foreground">{t('settings.cliproxyapi.connectionHint')}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" disabled={enterpriseMode || busy || status?.ready !== true} onClick={() => void importModels()}>{t('settings.cliproxyapi.importModels')}</Button>
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
                <Button type="button" disabled={enterpriseMode || busy || status?.ready !== true || connectionName.trim() === '' || model.modelID.trim() === ''} onClick={() => void saveConnection()}>{status?.connection == null ? t('settings.cliproxyapi.createConnection') : t('settings.cliproxyapi.updateConnection')}</Button>
              </SettingsSection>
            </CollapsibleContent>
          </Collapsible>
        ) : null}
      </div>
    </>
  );
};
