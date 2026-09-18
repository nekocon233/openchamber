import React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SettingsFieldRow, SettingsSection } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { updateDesktopSettings } from '@/lib/persistence';
import { fetchPortForwardState, stopPortForward, type PortForwardState } from '@/lib/browser/portForward';

/**
 * Where a forwarded dev server is published.
 *
 * OpenChamber cannot work the hostname out for itself: which names resolve,
 * which of them the tunnel routes back here, and which a certificate covers are
 * all decided outside this process. So the user supplies one template and the
 * server only builds hostnames from it.
 *
 * The server stays authoritative about whether a template was accepted. Rather
 * than duplicating its rules here — which would drift — the field saves, reads
 * back what is actually in force, and says so when the two differ.
 */
export const PortForwardSettings: React.FC = () => {
  const { t } = useI18n();
  const [state, setState] = React.useState<PortForwardState | null>(null);
  const [value, setValue] = React.useState('');
  const [isSaving, setIsSaving] = React.useState(false);
  const [rejected, setRejected] = React.useState(false);
  const [stopping, setStopping] = React.useState<ReadonlySet<number>>(() => new Set());

  const load = React.useCallback(async (): Promise<PortForwardState> => {
    const next = await fetchPortForwardState();
    setState(next);
    return next;
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    void fetchPortForwardState().then((next) => {
      if (cancelled) return;
      setState(next);
      setValue(next.kind === 'ready' ? next.template : '');
    });
    return () => { cancelled = true; };
  }, []);

  const handleSave = React.useCallback(async () => {
    // Matches the server's own normalisation, which is the whole of what the
    // client may assume about a template it has not had accepted yet.
    const submitted = value.trim().toLowerCase();
    setIsSaving(true);
    setRejected(false);
    try {
      await updateDesktopSettings({ portForwardHostTemplate: submitted || null });
      const next = await load();
      const accepted = submitted
        ? next.kind === 'ready' && next.template === submitted
        : next.kind !== 'ready';
      setRejected(!accepted);
      if (next.kind === 'ready') setValue(next.template);
    } finally {
      setIsSaving(false);
    }
  }, [load, value]);

  const handleStop = React.useCallback(async (port: number) => {
    setStopping((current) => new Set(current).add(port));
    try {
      await stopPortForward(port);
      await load();
    } catch {
      // The list below is re-read either way; a failed stop simply stays listed.
      await load();
    } finally {
      setStopping((current) => {
        const next = new Set(current);
        next.delete(port);
        return next;
      });
    }
  }, [load]);

  const forwards = state?.kind === 'ready' ? state.forwards : [];
  const templateError = state?.kind === 'unconfigured' ? state.templateError : null;

  return (
    <SettingsSection
      title={t('settings.openchamber.portForward.title')}
      info={t('settings.openchamber.portForward.info')}
    >
      <div className="space-y-3">
        <SettingsFieldRow
          settingsItem="general.port-forward-template"
          label={t('settings.openchamber.portForward.field.template')}
          info={t('settings.openchamber.portForward.field.templateInfo')}
          alignEnd={false}
          controlClassName="@xl:w-[20rem]"
        >
          <Input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={t('settings.openchamber.portForward.field.templatePlaceholder')}
            disabled={isSaving}
            className="h-8 min-w-0 flex-1 font-mono text-xs"
            aria-label={t('settings.openchamber.portForward.field.template')}
          />
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={isSaving}
            onClick={() => void handleSave()}
          >
            {isSaving ? t('settings.common.actions.saving') : t('settings.common.actions.saveChanges')}
          </Button>
        </SettingsFieldRow>

        {rejected || templateError ? (
          <p className="typography-meta text-[var(--status-error)]">
            {templateError ?? t('settings.openchamber.portForward.rejected')}
          </p>
        ) : null}

        {state?.kind === 'unavailable' ? (
          <p className="typography-meta text-muted-foreground">
            {t('settings.openchamber.portForward.unavailable')}
          </p>
        ) : null}

        <div className="space-y-1" data-settings-item="general.port-forward-active">
          <p className="typography-meta text-muted-foreground">
            {t('settings.openchamber.portForward.active')}
          </p>
          {forwards.length === 0 ? (
            <p className="typography-meta text-muted-foreground">
              {t('settings.openchamber.portForward.activeEmpty')}
            </p>
          ) : (
            forwards.map((forward) => (
              <div key={forward.port} className="flex items-center justify-between gap-2 py-0.5">
                <span className="min-w-0 truncate font-mono text-[13px]">{forward.origin}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={stopping.has(forward.port)}
                  onClick={() => void handleStop(forward.port)}
                  className="!font-normal text-muted-foreground hover:text-foreground"
                  aria-label={t('settings.openchamber.portForward.stopAria', { port: forward.port })}
                >
                  {t('settings.openchamber.portForward.stop')}
                </Button>
              </div>
            ))
          )}
        </div>

        {/* Stays visible: this is what a forward costs, not an explanation of it. */}
        <p className="typography-meta text-muted-foreground">
          {t('settings.openchamber.portForward.warning')}
        </p>
      </div>
    </SettingsSection>
  );
};
