import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NumberInput } from '@/components/ui/number-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  SettingsSection, SettingsStackedField, SettingsCheckboxRow, SettingsTwoColumn,
  SETTINGS_SELECT_TRIGGER_CLASS, SETTINGS_NUMBER_STEPPER_ROW_CLASS,
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
    case 'CLIPROXYAPI_LOCAL_LOGIN_REQUIRED': return 'settings.cliproxyapi.localOnly';
    case 'CLIPROXYAPI_NOT_CONFIGURED':
    case 'CLIPROXYAPI_MANAGEMENT_DISABLED': return 'settings.cliproxyapi.managementDisabled';
    case 'CLIPROXYAPI_NOT_REACHABLE': return 'settings.cliproxyapi.notReachable';
    case 'CLIPROXYAPI_KEY_REJECTED': return 'settings.cliproxyapi.keyRejected';
    case 'CLIPROXYAPI_CLIENT_KEY_UNKNOWN': return 'settings.cliproxyapi.clientKeyUnknown';
    default: return 'settings.cliproxyapi.failed';
  }
};

/**
 * The local CLIProxyAPI gateway manages its own ChatGPT/Codex accounts. This
 * section signs one in through the gateway's management API and writes the
 * Claude Code connection that points at it, so nobody has to copy a key by hand.
 */
export const CliProxyApiSection: React.FC<{ onConnectionSaved?: (connection: ClaudeConnection) => void }> = ({ onConnectionSaved }) => {
  const { nativeAgents } = useRuntimeAPIs();
  const { t } = useI18n();
  const [status, setStatus] = React.useState<Awaited<ReturnType<typeof nativeAgents.cliproxyapiStatus>> | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<I18nKey | null>(null);
  const [baseURL, setBaseURL] = React.useState('');
  const [managementKey, setManagementKey] = React.useState('');
  const [attempt, setAttempt] = React.useState<{ state: string; expiresAt: number } | null>(null);
  const [pollTick, setPollTick] = React.useState(0);
  const [removing, setRemoving] = React.useState<string | null>(null);
  const [connectionName, setConnectionName] = React.useState('CLIProxyAPI');
  const [model, setModel] = React.useState({ ...DEFAULT_MODEL, image: true });
  const [keySource, setKeySource] = React.useState<'added' | 'existing' | 'typed'>('added');
  const [keyIndex, setKeyIndex] = React.useState(0);
  const [typedKey, setTypedKey] = React.useState('');
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
        setBaseURL((previous) => (previous === '' ? value.baseURL : previous));
      }
    } catch (error) {
      if (mounted.current && getRuntimeKey() === runtimeKey && revision.current === request) { setNotice(error instanceof NativeAgentsRequestError ? failureKey(error) : 'settings.cliproxyapi.failed'); setStatus(null); }
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
          if (cancelled || !(mounted.current && getRuntimeKey() === runtimeKey)) return;
          if (result.status === 'pending') { setPollTick((value) => value + 1); return; }
          setAttempt(null);
          if (result.status === 'connected') await load();
          else setNotice('settings.cliproxyapi.authFailed');
        } catch (error) {
          if (!cancelled && mounted.current && getRuntimeKey() === runtimeKey) { setAttempt(null); setNotice(error instanceof NativeAgentsRequestError ? failureKey(error) : 'settings.cliproxyapi.failed'); }
        }
      })();
    }, POLL_INTERVAL_MS);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [attempt, pollTick, nativeAgents, load, runtimeKey]);

  const local = status?.localLogin === true;
  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setNotice(null);
    try {
      await action();
    } catch (error) {
      if (mounted.current && getRuntimeKey() === runtimeKey) setNotice(error instanceof NativeAgentsRequestError ? failureKey(error) : 'settings.cliproxyapi.failed');
    } finally {
      if (mounted.current && getRuntimeKey() === runtimeKey) setBusy(false);
    }
  };
  const saveGateway = () => act(async () => {
    if (baseURL.trim() === '' || managementKey.trim() === '') { setNotice('settings.claudeConnections.invalid'); return; }
    await nativeAgents.saveCliproxyapiKey({ baseURL: baseURL.trim(), managementKey: managementKey.trim() });
    setManagementKey('');
    await load();
  });
  const forgetGateway = () => act(async () => {
    await nativeAgents.forgetCliproxyapiKey();
    setManagementKey('');
    await load();
  });
  const signIn = () => act(async () => {
    const started = await nativeAgents.beginCliproxyapiLogin();
    if (!(mounted.current && getRuntimeKey() === runtimeKey)) return;
    setAttempt({ state: started.state, expiresAt: started.expiresAt });
    setPollTick(0);
    await openExternalUrl(started.url);
  });
  const cancelSignIn = () => act(async () => {
    if (attempt === null) return;
    const cancelled = await nativeAgents.cancelCliproxyapiLogin(attempt.state);
    if (!(mounted.current && getRuntimeKey() === runtimeKey)) return;
    setAttempt(null);
    setNotice(cancelled ? null : 'settings.cliproxyapi.cancelUnavailable');
  });
  const removeAccount = (name: string) => act(async () => {
    await nativeAgents.removeCliproxyapiAccount(name);
    if (mounted.current && getRuntimeKey() === runtimeKey) setRemoving(null);
    await load();
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
      clientKey: keySource === 'typed'
        ? { source: 'typed', value: typedKey }
        : keySource === 'existing' ? { source: 'existing', index: keyIndex } : { source: 'added' },
    });
    if (!(mounted.current && getRuntimeKey() === runtimeKey)) return;
    onConnectionSaved?.(saved);
    await load();
  });

  const gatewayStatus = !status || !status.reachable
    ? t('settings.cliproxyapi.notReachable')
    : !status.managementEnabled
      ? t('settings.cliproxyapi.managementDisabled')
      : status.keyRejected
        ? t('settings.cliproxyapi.keyRejected')
        : null;

  return (
    <SettingsSection title={t('settings.cliproxyapi.title')} settingsItem="providers.cliproxyapi" contentClassName="space-y-4">
      <p className="typography-ui-label text-muted-foreground">{t('settings.cliproxyapi.description')}</p>
      {loading ? <p role="status">{t('common.loading')}</p> : null}
      {notice ? <p role="alert" className="text-[var(--status-error-text)]">{t(notice)}</p> : null}
      {gatewayStatus ? <p role="status" className="text-[var(--status-warning-text)]">{gatewayStatus}</p> : null}
      {!local && status !== null ? <p role="status" className="text-muted-foreground">{t('settings.cliproxyapi.localOnly')}</p> : null}

      <SettingsTwoColumn>
        <SettingsStackedField label={t('settings.cliproxyapi.baseURL')}>
          <Input className="h-8" type="url" aria-label={t('settings.cliproxyapi.baseURL')} value={baseURL} disabled={!local || busy} onChange={(event) => setBaseURL(event.target.value)} />
        </SettingsStackedField>
        <SettingsStackedField label={t('settings.cliproxyapi.managementKey')} info={t('settings.cliproxyapi.managementKeyHint')}>
          <Input className="h-8" type="password" autoComplete="new-password" aria-label={t('settings.cliproxyapi.managementKey')} value={managementKey} disabled={!local || busy} onChange={(event) => setManagementKey(event.target.value)} />
        </SettingsStackedField>
      </SettingsTwoColumn>
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={!local || busy} onClick={() => void saveGateway()}>{t('settings.claudeConnections.save')}</Button>
        <Button type="button" variant="ghost" disabled={!local || busy || status?.configured !== true} onClick={() => void forgetGateway()}>{t('settings.cliproxyapi.forget')}</Button>
      </div>

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
              <Button variant="ghost" disabled={!local || busy} onClick={() => setRemoving(account.name)}>{t('settings.cliproxyapi.remove')}</Button>
            )}
          </SettingsStackedField>
        ))}
      </SettingsSection>

      <SettingsSection title={t('settings.cliproxyapi.signIn')} contentClassName="space-y-2">
        {attempt === null ? (
          <Button type="button" disabled={!local || busy || status?.managementEnabled !== true} onClick={() => void signIn()}>{t('settings.cliproxyapi.signIn')}</Button>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span role="status">{t('settings.cliproxyapi.pending')}</span>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => void cancelSignIn()}>{t('settings.claudeConnections.cancel')}</Button>
          </div>
        )}
      </SettingsSection>

      <SettingsSection title={t('settings.claudeConnections.connection')} contentClassName="space-y-4">
        <p className="typography-ui-label text-muted-foreground">{t('settings.cliproxyapi.connectionHint')}</p>
        <SettingsTwoColumn>
          <SettingsStackedField label={t('settings.claudeConnections.name')}>
            <Input className="h-8" aria-label={t('settings.claudeConnections.name')} value={connectionName} disabled={!local || busy} onChange={(event) => setConnectionName(event.target.value)} />
          </SettingsStackedField>
          <SettingsStackedField label={t('settings.claudeConnections.modelID')}>
            <Input className="h-8" aria-label={t('settings.claudeConnections.modelID')} value={model.modelID} disabled={!local || busy} onChange={(event) => setModel({ ...model, modelID: event.target.value })} />
          </SettingsStackedField>
          <SettingsStackedField label={t('settings.claudeConnections.name')}>
            <Input className="h-8" aria-label={t('settings.claudeConnections.name')} value={model.name} disabled={!local || busy} onChange={(event) => setModel({ ...model, name: event.target.value })} />
          </SettingsStackedField>
          <SettingsStackedField label={t('settings.claudeConnections.context')}>
            <div className={SETTINGS_NUMBER_STEPPER_ROW_CLASS}><NumberInput min={1024} max={10_000_000} aria-label={t('settings.claudeConnections.context')} value={model.contextWindow} onValueChange={(contextWindow) => setModel({ ...model, contextWindow })} /></div>
          </SettingsStackedField>
          <SettingsStackedField label={t('settings.claudeConnections.output')}>
            <div className={SETTINGS_NUMBER_STEPPER_ROW_CLASS}><NumberInput min={1} max={1_000_000} aria-label={t('settings.claudeConnections.output')} value={model.outputLimit} onValueChange={(outputLimit) => setModel({ ...model, outputLimit })} /></div>
          </SettingsStackedField>
          <SettingsStackedField label={t('settings.cliproxyapi.clientKey')}>
            <Select value={keySource} onValueChange={(value) => { if (value === 'added' || value === 'existing' || value === 'typed') setKeySource(value); }}>
              <SelectTrigger className={SETTINGS_SELECT_TRIGGER_CLASS} aria-label={t('settings.cliproxyapi.clientKey')}>
                <SelectValue>{t(keySource === 'added' ? 'settings.cliproxyapi.clientKeyAdded' : keySource === 'existing' ? 'settings.cliproxyapi.clientKeyExisting' : 'settings.cliproxyapi.clientKeyTyped')}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="added">{t('settings.cliproxyapi.clientKeyAdded')}</SelectItem>
                <SelectItem value="existing">{t('settings.cliproxyapi.clientKeyExisting')}</SelectItem>
                <SelectItem value="typed">{t('settings.cliproxyapi.clientKeyTyped')}</SelectItem>
              </SelectContent>
            </Select>
          </SettingsStackedField>
        </SettingsTwoColumn>
        {keySource === 'existing' ? (
          <SettingsStackedField label={t('settings.cliproxyapi.clientKeyExisting')}>
            <Select value={String(Math.min(keyIndex, Math.max(0, (status?.clientKeys.length ?? 1) - 1)))} onValueChange={(value) => setKeyIndex(Number(value))}>
              <SelectTrigger className={SETTINGS_SELECT_TRIGGER_CLASS} aria-label={t('settings.cliproxyapi.clientKeyExisting')}>
                <SelectValue>{status?.clientKeys[Math.min(keyIndex, Math.max(0, status.clientKeys.length - 1))]?.hint ?? ''}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {(status?.clientKeys ?? []).map((key, index) => <SelectItem key={`${key.hint}-${index}`} value={String(index)}>{`…${key.hint}`}</SelectItem>)}
              </SelectContent>
            </Select>
          </SettingsStackedField>
        ) : null}
        {keySource === 'typed' ? (
          <SettingsStackedField label={t('settings.cliproxyapi.clientKeyTyped')}>
            <Input className="h-8" type="password" autoComplete="new-password" aria-label={t('settings.cliproxyapi.clientKeyTyped')} value={typedKey} disabled={!local || busy} onChange={(event) => setTypedKey(event.target.value)} />
          </SettingsStackedField>
        ) : null}
        <SettingsCheckboxRow checked={model.image} onChange={(image) => setModel({ ...model, image })} label={t('settings.claudeConnections.image')} />
        <Button type="button" disabled={!local || busy || status?.managementEnabled !== true || connectionName.trim() === '' || model.modelID.trim() === ''} onClick={() => void saveConnection()}>{t('settings.cliproxyapi.createConnection')}</Button>
      </SettingsSection>
    </SettingsSection>
  );
};
