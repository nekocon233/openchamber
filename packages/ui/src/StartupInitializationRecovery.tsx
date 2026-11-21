import React from 'react';
import { Button } from '@/components/ui/button';
import { useConfigStore } from '@/stores/useConfigStore';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useI18n } from '@/lib/i18n';
import { fetchStartupDiagnostics, getInitRecoveryDescriptionKey, type StartupDiagnostics } from '@/lib/startupDiagnostics';
import { fetchConnectedServerVersion, isServerBeforeOpenCode2 } from '@/lib/serverCompatibility';
import { OutdatedServerNotice } from '@/components/update/OutdatedServerNotice';

export const StartupInitializationRecovery: React.FC<{
  onRetry: () => void;
  isRetrying: boolean;
}> = ({ onRetry, isRetrying }) => {
  const { t } = useI18n();
  const [diagnostics, setDiagnostics] = React.useState<StartupDiagnostics | null>(null);

  React.useEffect(() => {
    const controller = new AbortController();
    const runtimeKey = getRuntimeKey();
    const timeout = setTimeout(() => controller.abort(), 5000);
    void fetchStartupDiagnostics(controller.signal).then((result) => {
      if (!controller.signal.aborted && getRuntimeKey() === runtimeKey) {
        setDiagnostics(result);
      }
    }).catch(() => {
      // Keep generic recovery when the server cannot supply current diagnostics.
    }).finally(() => clearTimeout(timeout));
    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, []);

  // A server before 2.0 answers this app's requests with its web page, which
  // surfaces as an unrelated load failure. Its own version says why.
  const [outdatedServerVersion, setOutdatedServerVersion] = React.useState<string | null>(null);
  React.useEffect(() => {
    const controller = new AbortController();
    const runtimeKey = getRuntimeKey();
    const timeout = setTimeout(() => controller.abort(), 5000);
    void fetchConnectedServerVersion(controller.signal).then((version) => {
      if (controller.signal.aborted || getRuntimeKey() !== runtimeKey) return;
      setOutdatedServerVersion(version && isServerBeforeOpenCode2(version) ? version : null);
    }).catch(() => undefined).finally(() => clearTimeout(timeout));
    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, []);

  const failure = useConfigStore((s) => s.lastInitFailure);
  // Server diagnostics outrank the client's guess: they prove the server answered.
  const failureMessage = diagnostics ? null : failure?.message ?? null;

  if (outdatedServerVersion) {
    return (
      <div className="flex h-full flex-col items-center overflow-y-auto bg-background px-6 py-6 text-foreground">
        <div className="my-auto flex w-full max-w-xl shrink-0 flex-col items-center gap-4 text-center">
          <OutdatedServerNotice version={outdatedServerVersion} />
          <Button type="button" variant="outline" onClick={onRetry} disabled={isRetrying}>
            {isRetrying ? t('startup.initRecovery.retrying') : t('startup.initRecovery.retry')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center overflow-y-auto bg-background px-6 py-6 text-foreground">
      <div className="my-auto flex w-full max-w-xl shrink-0 flex-col items-center gap-4 text-center">
        <div className="flex flex-col gap-2">
          <h1 className="typography-h1 text-foreground">{t('startup.initRecovery.title')}</h1>
          <p className="typography-markdown text-muted-foreground">{t(getInitRecoveryDescriptionKey(diagnostics, failure))}</p>
        </div>
        {failureMessage && (
          <dl className="w-full min-w-0 text-start" aria-live="polite">
            <dt className="typography-meta text-muted-foreground">{t('startup.initRecovery.lastError')}</dt>
            <dd className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-[var(--surface-muted)] px-3 py-2 font-mono typography-meta text-muted-foreground">{failureMessage}</dd>
          </dl>
        )}
        {diagnostics && (
          <dl className="w-full min-w-0 space-y-3 text-start" aria-live="polite">
            {diagnostics.binary && (
              <div>
                <dt className="typography-meta text-muted-foreground">{t('startup.initRecovery.binary')}</dt>
                <dd className="break-all font-mono typography-meta">{diagnostics.binary}</dd>
              </div>
            )}
            {diagnostics.error && (
              <div>
                <dt className="typography-meta text-muted-foreground">{t('startup.initRecovery.error')}</dt>
                <dd className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words font-mono typography-meta text-[var(--status-error)]">{diagnostics.error}</dd>
              </div>
            )}
          </dl>
        )}
        <Button type="button" onClick={onRetry} disabled={isRetrying}>
          {isRetrying ? t('startup.initRecovery.retrying') : t('startup.initRecovery.retry')}
        </Button>
      </div>
    </div>
  );
};
