import * as React from 'react';
import { Button } from '@/components/ui/button';
import { SettingsControlGroup, SettingsFieldRow } from '@/components/sections/shared/SettingsSection';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useSettingsDirectory } from '@/hooks/useSettingsDirectory';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { getRuntimeKey, getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import type { NativeMemoryStatus } from '@/lib/native-agents/memory-schemas';
import { useAgentMemoryStore } from '@/stores/useAgentMemoryStore';

export const NativeMemorySettings: React.FC<{ refreshRevision: number }> = ({ refreshRevision }) => {
  const { t } = useI18n();
  const { nativeAgents } = useRuntimeAPIs();
  const directory = useSettingsDirectory() ?? undefined;
  const runtimeKey = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeKey, getRuntimeKey);
  const [data, setData] = React.useState<NativeMemoryStatus | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const requestRevision = React.useRef(0);
  const instanceId = React.useId();

  const run = React.useCallback(async (operation?: () => Promise<void>) => {
    const revision = ++requestRevision.current;
    const generation = getRuntimeEndpointGeneration();
    const current = () => requestRevision.current === revision && generation === getRuntimeEndpointGeneration();
    setBusy(true);
    try {
      if (operation) await operation();
      if (!current()) return;
      const result = await nativeAgents.memoryStatus(directory);
      if (current()) {
        setData((previous) => ({
          ...result,
          progress: result.progressUnavailable ? previous?.progress ?? [] : result.progress,
          sources: result.sourcesUnavailable ? previous?.sources ?? [] : result.sources,
        }));
        setError(result.progressUnavailable || result.sourcesUnavailable ? t('common.unavailable') : null);
      }
    } catch (caught) {
      if (current()) setError(caught instanceof Error ? caught.message : t('nativeMemory.unavailable'));
    } finally { if (current()) setBusy(false); }
  }, [nativeAgents, directory, t]);

  React.useEffect(() => {
    setData(null);
    setError(null);
    if (nativeAgents.supported) void run();
    return () => { requestRevision.current += 1; };
  }, [nativeAgents.supported, run, runtimeKey, refreshRevision]);

  if (!nativeAgents.supported) return null;
  return (
    <SettingsControlGroup title={t('nativeMemory.title')} settingsItem="general.native-memory-sharing">
      <p className="typography-meta text-muted-foreground">{t('nativeMemory.hint')}</p>
      {error ? <p role="alert" className="typography-meta text-[var(--status-error)]">{error}</p> : null}
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void run()}>{t('nativeMemory.refresh')}</Button>
      {data?.backends.map((connection) => {
        const name = connection.backend === 'claude' ? 'Claude Code' : 'Codex';
        if (connection.status === 'unavailable') return <SettingsFieldRow key={connection.backend} label={name}><span className="typography-meta text-muted-foreground">{t('common.unavailable')}</span></SettingsFieldRow>;
        const status = connection.ready ? 'nativeMemory.ready' : connection.installed ? 'nativeMemory.waiting' : 'nativeMemory.notConnected';
        return (
          <SettingsFieldRow key={connection.backend} label={name} info={t(status)}>
            <div className="flex flex-col gap-2 items-start">
              <span className="typography-meta text-muted-foreground">{t(status)}</span>
              {connection.reviewRequired ? <p className="typography-meta text-muted-foreground">{t('nativeMemory.review')}</p> : null}
              <Button variant="outline" size="sm" disabled={busy || !data.canManage || (!connection.installed && !data.enabled)}
                onClick={() => void run(async () => {
                  if (connection.installed) await nativeAgents.disconnectMemory(connection.backend);
                  else await nativeAgents.connectMemory(connection.backend);
                })}>
                {t(connection.installed ? 'nativeMemory.disconnect' : 'nativeMemory.connect')}
              </Button>
            </div>
          </SettingsFieldRow>
        );
      })}
      {data && !data.canManage ? <p className="typography-meta text-muted-foreground">{t('nativeMemory.hostOnly')}</p> : null}
      {data?.enabled && data.sources.map((source) => (
        <SettingsFieldRow key={source.id} label={source.name}>
          <Button variant="outline" size="sm" disabled={busy || !directory} onClick={() => void run(async () => {
            if (!directory) return;
            const generation = getRuntimeEndpointGeneration();
            await nativeAgents.importMemory(source.id, directory);
            if (generation === getRuntimeEndpointGeneration()) await useAgentMemoryStore.getState().refresh();
          })}>{t('nativeMemory.import')}</Button>
        </SettingsFieldRow>
      ))}
      {data?.enabled ? <div className="space-y-2" aria-labelledby={`${instanceId}-progress`}>
        <h4 id={`${instanceId}-progress`} className="typography-ui-label">{t('nativeMemory.progress')}</h4>
        {data.progress.length === 0 ? <p className="typography-meta text-muted-foreground">{t(data.progressUnavailable ? 'common.unavailable' : 'nativeMemory.empty')}</p> : null}
        {data.progress.slice(0, 5).map((entry) => (
          <div key={`${entry.backend}:${entry.sessionId}`} className="space-y-1">
            <div className="typography-micro text-muted-foreground">{entry.backend === 'claude' ? 'Claude Code' : 'Codex'} · {t(entry.status === 'interrupted' ? 'nativeMemory.interrupted' : 'nativeMemory.ended')} · <time dateTime={new Date(entry.observedAt).toISOString()}>{new Date(entry.observedAt).toLocaleString(getCurrentIntlLocale())}</time></div>
            <pre className="typography-meta whitespace-pre-wrap break-words max-h-32 overflow-auto">{entry.summary}</pre>
          </div>
        ))}
      </div> : null}
    </SettingsControlGroup>
  );
};
