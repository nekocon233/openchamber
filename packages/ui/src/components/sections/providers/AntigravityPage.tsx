import React from 'react';

import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';

type Status = 'loading' | 'missing' | 'unauthenticated' | 'ready' | 'error';
type StatusState = { status: Status; diagnostic: string | null };

export function AntigravityPage({ titleLeading }: { titleLeading?: React.ReactNode }) {
  const { nativeAgents } = useRuntimeAPIs();
  const { t } = useI18n();
  const runtimeKey = getRuntimeKey();
  const mounted = React.useRef(true);
  const reads = React.useRef(0);
  const [state, setState] = React.useState<StatusState>({ status: 'loading', diagnostic: null });

  const load = React.useCallback(async () => {
    const request = ++reads.current;
    const current = () => mounted.current && getRuntimeKey() === runtimeKey && reads.current === request;
    setState({ status: 'loading', diagnostic: null });
    try {
      const capabilities = await nativeAgents.capabilities();
      if (!current()) return;
      const backend = capabilities.backends.antigravity;
      if (!backend) {
        setState({ status: 'error', diagnostic: null });
        return;
      }
      if (!backend.cli) {
        setState({ status: 'missing', diagnostic: null });
        return;
      }

      const catalog = await nativeAgents.catalog();
      if (!current()) return;
      const partition = catalog.backends.antigravity;
      if (!partition) {
        setState({ status: 'error', diagnostic: null });
        return;
      }
      if (partition.status === 'error') {
        setState({
          status: partition.reason === 'unauthenticated' ? 'unauthenticated' : 'error',
          diagnostic: partition.message,
        });
        return;
      }
      setState(partition.models.length > 0
        ? { status: 'ready', diagnostic: null }
        : { status: 'error', diagnostic: null });
    } catch (error) {
      if (current()) {
        setState({
          status: 'error',
          diagnostic: error instanceof Error && error.message ? error.message : null,
        });
      }
    }
  }, [nativeAgents, runtimeKey]);

  React.useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      reads.current += 1;
    };
  }, [load]);

  const message = state.status === 'loading' ? t('common.loading')
    : state.status === 'missing' ? t('settings.antigravity.status.missing')
      : state.status === 'unauthenticated' ? t('settings.antigravity.status.unauthenticated')
        : state.status === 'ready' ? t('settings.antigravity.status.ready')
          : t('settings.antigravity.status.error');

  return (
    <SettingsPageLayout
      title={t('settings.antigravity.title')}
      titleLeading={titleLeading}
      description={t('settings.antigravity.description')}
      showSaveStatus={false}
    >
      <SettingsSection settingsItem="providers.antigravity" divider={false} contentClassName="space-y-3">
        <p className="text-sm text-foreground" role={state.status === 'error' ? 'alert' : 'status'}>{message}</p>
        {state.diagnostic ? (
          <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground" dir="auto">{state.diagnostic}</p>
        ) : null}
        <Button variant="outline" disabled={state.status === 'loading'} onClick={() => void load()}>
          {t('settings.antigravity.reload')}
        </Button>
      </SettingsSection>
    </SettingsPageLayout>
  );
}
