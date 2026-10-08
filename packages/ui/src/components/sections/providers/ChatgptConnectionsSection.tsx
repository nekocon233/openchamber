import React from 'react';
import { Button } from '@/components/ui/button';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { SettingsSection, SettingsStackedField } from '@/components/sections/shared/SettingsSection';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { openExternalUrl } from '@/lib/url';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useConfigStore } from '@/stores/useConfigStore';
import type { ChatgptAccount, ChatgptAccounts, ChatgptAuthorization } from '@/lib/native-agents/connections';

const STATUS_LABELS = {
  connected: 'settings.chatgpt.connected',
  'signed-out': 'settings.chatgpt.signedOut',
  'permission-required': 'settings.chatgpt.permissionRequired',
} satisfies Record<ChatgptAccount['status'], I18nKey>;

export const ChatgptConnectionsSection: React.FC = () => {
  const { nativeAgents } = useRuntimeAPIs();
  const { t } = useI18n();
  const runtimeKey = getRuntimeKey();
  const [accounts, setAccounts] = React.useState<ChatgptAccounts | null>(null);
  const [attempt, setAttempt] = React.useState<ChatgptAuthorization | null>(null);
  const [exchanging, setExchanging] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<I18nKey | null>(null);
  const mounted = React.useRef(true);
  const revision = React.useRef(0);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const current = () => mounted.current && getRuntimeKey() === runtimeKey;
  const load = React.useCallback(async () => {
    const request = ++revision.current;
    const result = await nativeAgents.chatgptAccounts();
    if (mounted.current && getRuntimeKey() === runtimeKey && revision.current === request) setAccounts(result);
  }, [nativeAgents, runtimeKey]);
  React.useEffect(() => { void load().catch(() => { if (mounted.current) setNotice('settings.claudeConnections.failed'); }); }, [load]);
  const refresh = React.useCallback(async () => {
    if (getRuntimeKey() !== runtimeKey) return;
    if (mounted.current) setNotice(null);
    await useConfigStore.getState().refreshNativeProviders();
    if (getRuntimeKey() === runtimeKey) await load();
  }, [load, runtimeKey]);

  React.useEffect(() => {
    if (!attempt) return;
    let disposed = false;
    const deadline = Date.now() + 300_000;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (Date.now() >= deadline) { setNotice('settings.chatgpt.authFailed'); setAttempt(null); return; }
      try {
        const status = await nativeAgents.chatgptAuthorizationStatus(attempt.attemptId);
        if (disposed || getRuntimeKey() !== runtimeKey) return;
        setExchanging(status.status === 'exchanging');
        if (status.status === 'pending' || status.status === 'exchanging') { timer = setTimeout(() => void poll(), 1000); return; }
        if (status.status === 'connected' || status.status === 'permission-required') await refresh();
        else setNotice(status.status === 'cancelled' ? 'settings.chatgpt.cancelled' : 'settings.chatgpt.authFailed');
        if (!disposed && getRuntimeKey() === runtimeKey) setAttempt(null);
      } catch {
        if (!disposed && getRuntimeKey() === runtimeKey) {
          setNotice('settings.claudeConnections.failed');
          timer = setTimeout(() => void poll(), 3000);
        }
      }
    };
    void poll();
    return () => {
      disposed = true; clearTimeout(timer);
      if (getRuntimeKey() === runtimeKey) void nativeAgents.cancelChatgptAuthorization(attempt.attemptId).catch(() => {});
    };
  }, [attempt, nativeAgents, refresh, runtimeKey]);

  const begin = async (accountId: string | null) => {
    setBusy(true); setNotice(null); revision.current += 1;
    try {
      const result = await nativeAgents.beginChatgptAuthorization({ accountId, completionMessage: t('settings.chatgpt.callback') });
      if (!current()) { if (getRuntimeKey() === runtimeKey) await nativeAgents.cancelChatgptAuthorization(result.attemptId); return; }
      setAttempt(result); setExchanging(false);
      await openExternalUrl(result.url);
    } catch { if (current()) setNotice('settings.chatgpt.authFailed'); }
    finally { if (current()) setBusy(false); }
  };
  const signOut = async (id: string) => {
    setBusy(true); setNotice(null); revision.current += 1;
    try {
      const result = await nativeAgents.signOutChatgpt(id);
      await refresh();
      if (current() && !result.revoked) setNotice('settings.chatgpt.revocationUnconfirmed');
    } catch { if (current()) setNotice('settings.claudeConnections.failed'); }
    finally { if (current()) setBusy(false); }
  };
  const welcome = accounts?.accounts.find((account) => account.status === 'connected' && !account.welcomed);
  const acknowledge = async () => {
    if (!welcome || busy) return;
    setBusy(true);
    try { await nativeAgents.acknowledgeChatgptPlan(welcome.id); await load(); }
    catch { if (current()) setNotice('settings.claudeConnections.failed'); }
    finally { if (current()) setBusy(false); }
  };
  const addAccountButton = (
    <Button className="normal-case" variant="outline" disabled={!accounts?.localLogin || busy} onClick={() => void begin(null)}>
      <ProviderLogo providerId="openai" className="size-4" />{t('settings.chatgpt.signIn')}
    </Button>
  );
  return (
    <SettingsSection title={t('settings.chatgpt.title')} settingsItem="providers.chatgpt-plan" contentClassName="space-y-4">
      <p className="typography-meta text-muted-foreground">{t('settings.chatgpt.description')}</p>
      {accounts === null ? <p role="status">{t('common.loading')}</p> : null}
      {notice ? <p role="alert" className="text-[var(--status-error-text)]">{t(notice)}</p> : null}
      {accounts?.localLogin === false ? <p className="typography-meta text-muted-foreground">{t('settings.chatgpt.localOnly')}</p> : null}
      {accounts?.accounts.map((account) => (
        <SettingsStackedField key={account.id} label={<span className="break-all">{account.label}</span>} description={t(STATUS_LABELS[account.status])} controlClassName="flex-wrap">
          {account.status !== 'connected' ? <Button className="normal-case" variant="outline" disabled={!accounts.localLogin || busy || Boolean(attempt)} onClick={() => void begin(account.id)}>{t('settings.chatgpt.signIn')}</Button> : null}
          {account.status !== 'signed-out' ? <Button variant="ghost" disabled={busy || Boolean(attempt)} onClick={() => void signOut(account.id)}>{t('settings.chatgpt.signOut')}</Button> : null}
          {account.catalogUnavailable ? <p role="status" className="typography-meta text-muted-foreground">{t('settings.chatgpt.modelsUnavailable')}</p> : null}
        </SettingsStackedField>
      ))}
      {attempt ? <div className="space-y-2">
        <p role="status">{t(exchanging ? 'settings.chatgpt.exchanging' : 'settings.chatgpt.pending')}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void openExternalUrl(attempt.url)}>{t('settings.chatgpt.openBrowser')}</Button>
          <Button variant="ghost" disabled={exchanging} onClick={() => { void nativeAgents.cancelChatgptAuthorization(attempt.attemptId).then((cancelled) => { if (current()) { if (cancelled) setAttempt(null); else setExchanging(true); } }).catch(() => { if (current()) setNotice('settings.claudeConnections.failed'); }); }}>{t('settings.claudeConnections.cancel')}</Button>
        </div>
      </div> : accounts && accounts.accounts.length > 0 ? (
        <SettingsStackedField label={t('settings.chatgpt.addAccount')}>
          {addAccountButton}
        </SettingsStackedField>
      ) : addAccountButton}
      <div className="flex flex-wrap gap-2">
        <Button variant="link" onClick={() => void openExternalUrl('https://chatgpt.com/settings/usage')}>{t('settings.chatgpt.manageUsage')}</Button>
        <Button variant="ghost" disabled={busy || Boolean(attempt)} onClick={() => { void refresh().catch(() => { if (current()) setNotice('settings.claudeConnections.failed'); }); }}>{t('settings.claudeConnections.retry')}</Button>
      </div>
      <Dialog open={Boolean(welcome)} onOpenChange={(open) => { if (!open) void acknowledge(); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('settings.chatgpt.usingPlan')}</DialogTitle><DialogDescription>{t('settings.chatgpt.welcome')}</DialogDescription></DialogHeader>
          <DialogFooter><Button disabled={busy} onClick={() => void acknowledge()}>{t('settings.chatgpt.gotIt')}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
};
