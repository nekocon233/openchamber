import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NumberInput } from '@/components/ui/number-input';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SettingsSection, SettingsStackedField, SettingsFieldRow, SettingsCheckboxRow, SettingsTwoColumn,
  SETTINGS_NUMBER_STEPPER_ROW_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import {
  codexConnectionWriteSchema, type CodexConnection, type CodexConnectionWrite, type CodexConnectionModel,
} from '@/lib/native-agents/connections';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useConfigStore } from '@/stores/useConfigStore';

const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

const newModel = (): CodexConnectionModel => ({
  id: crypto.randomUUID(), name: '', modelID: '', contextWindow: 272_000, outputLimit: 128_000,
  input: { image: false, pdf: false }, efforts: [],
});
const newConnection = (): CodexConnectionWrite => ({
  kind: 'openai-responses', name: '', baseURL: '', models: [newModel()],
});

export const CodexConnectionsPage: React.FC<{ titleLeading?: React.ReactNode }> = ({ titleLeading }) => {
  const { nativeAgents } = useRuntimeAPIs();
  const { t } = useI18n();
  const [connections, setConnections] = React.useState<CodexConnection[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(false);
  const [invalid, setInvalid] = React.useState(false);
  const [draft, setDraft] = React.useState<CodexConnectionWrite | null>(null);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState<string | null>(null);
  const mounted = React.useRef(true);
  const revision = React.useRef(0);
  const runtimeKey = getRuntimeKey();
  React.useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const current = () => mounted.current && getRuntimeKey() === runtimeKey;
  const load = React.useCallback(async () => {
    const request = ++revision.current;
    setLoading(true);
    setError(false);
    try {
      const values = await nativeAgents.listCodexConnections();
      if (mounted.current && getRuntimeKey() === runtimeKey && revision.current === request) setConnections(values);
    } catch {
      if (mounted.current && getRuntimeKey() === runtimeKey && revision.current === request) setError(true);
    } finally {
      if (mounted.current && getRuntimeKey() === runtimeKey && revision.current === request) setLoading(false);
    }
  }, [nativeAgents, runtimeKey]);
  React.useEffect(() => { void load(); }, [load]);

  // A saved connection changes the model catalog; the app-server restarts on
  // the server side, so the picker has to be re-read to see its models.
  const refreshModels = async () => {
    if (getRuntimeKey() !== runtimeKey) return;
    await useConfigStore.getState().refreshNativeProviders();
  };
  const save = async () => {
    const parsed = codexConnectionWriteSchema.safeParse(draft);
    if (!parsed.success || (!editing && !parsed.data.apiKey)) { setInvalid(true); return; }
    revision.current += 1;
    setLoading(false);
    setBusy(true);
    setError(false);
    try {
      const saved = await nativeAgents.saveCodexConnection(editing, parsed.data);
      if (current()) {
        setConnections((values) => [...values.filter((value) => value.id !== saved.id), saved]);
        setDraft(null);
        setInvalid(false);
      }
      await refreshModels();
    } catch {
      if (current()) setError(true);
    } finally {
      if (current()) setBusy(false);
    }
  };
  const remove = async (id: string) => {
    revision.current += 1;
    setLoading(false);
    setBusy(true);
    setError(false);
    try {
      await nativeAgents.deleteCodexConnection(id);
      if (current()) {
        setConnections((values) => values.filter((value) => value.id !== id));
        setDeleting(null);
      }
      await refreshModels();
    } catch {
      if (current()) setError(true);
    } finally {
      if (current()) setBusy(false);
    }
  };
  const updateModel = (id: string, patch: Partial<CodexConnectionModel>) => {
    setDraft((value) => value && ({ ...value, models: value.models.map((model) => model.id === id ? { ...model, ...patch } : model) }));
  };
  const begin = () => {
    setDraft(newConnection()); setEditing(null); setInvalid(false); setDeleting(null);
  };
  return (
    <SettingsPageLayout title={t('settings.codexConnections.title')} titleLeading={titleLeading} description={t('settings.codexConnections.description')}>
      <SettingsSection title={t('settings.codexConnections.connections')} divider={false} settingsItem="providers.codex-connections" contentClassName="space-y-4">
        {loading ? <p role="status">{t('common.loading')}</p> : null}
        {error ? <p role="alert" className="text-[var(--status-error-text)]">{t('settings.codexConnections.failed')} <Button variant="link" disabled={busy} onClick={() => void load()}>{t('settings.codexConnections.retry')}</Button></p> : null}
        {!loading && !error && connections.length === 0 ? <p className="text-muted-foreground">{t('settings.codexConnections.empty')}</p> : null}
        {connections.map((connection) => (
          deleting === connection.id ? (
            <SettingsStackedField key={connection.id} label={connection.name} info={connection.baseURL}>
              <div className="space-y-2">
                <p>{t('settings.codexConnections.deleteHint')}</p>
                <div className="flex gap-2">
                  <Button variant="destructive" disabled={busy} onClick={() => void remove(connection.id)}>{t('settings.codexConnections.delete')}</Button>
                  <Button variant="ghost" disabled={busy} onClick={() => setDeleting(null)}>{t('settings.codexConnections.cancel')}</Button>
                </div>
              </div>
            </SettingsStackedField>
          ) : (
            <SettingsFieldRow key={connection.id} label={connection.name} info={connection.baseURL}>
              <Button variant="outline" disabled={busy || draft !== null} onClick={() => {
                setDeleting(null);
                setEditing(connection.id);
                setDraft({ kind: 'openai-responses', name: connection.name, baseURL: connection.baseURL, models: connection.models });
                setInvalid(false);
              }}>{t('settings.codexConnections.edit')}</Button>
              <Button variant="ghost" disabled={busy || draft !== null} onClick={() => setDeleting(connection.id)}>{t('settings.codexConnections.delete')}</Button>
            </SettingsFieldRow>
          )
        ))}
        {!draft ? <Button disabled={busy || loading} onClick={begin}>{t('settings.codexConnections.addCustom')}</Button> : null}
      </SettingsSection>
      {draft ? <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <fieldset disabled={busy}>
          <SettingsSection title={t('settings.codexConnections.connection')} contentClassName="space-y-4">
            <SettingsTwoColumn>
              <SettingsStackedField label={t('settings.codexConnections.name')}><Input className="h-8" required maxLength={120} aria-label={t('settings.codexConnections.name')} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></SettingsStackedField>
              <SettingsStackedField label={t('settings.codexConnections.url')} info={t('settings.codexConnections.urlHint')}><Input className="h-8" required type="url" aria-label={t('settings.codexConnections.url')} value={draft.baseURL} onChange={(event) => setDraft({ ...draft, baseURL: event.target.value })} /></SettingsStackedField>
              <SettingsStackedField label={t('settings.codexConnections.key')} info={editing ? t('settings.codexConnections.keepKey') : undefined}>
                <Input className="h-8" type="password" autoComplete="new-password" required={!editing} aria-label={t('settings.codexConnections.key')} value={draft.apiKey ?? ''} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value || undefined })} />
              </SettingsStackedField>
            </SettingsTwoColumn>
          </SettingsSection>
          {draft.models.map((model, index) => <SettingsSection key={model.id} title={t('settings.codexConnections.model', { number: index + 1 })} contentClassName="space-y-4">
            <SettingsTwoColumn>
              <SettingsStackedField label={t('settings.codexConnections.name')}><Input className="h-8" required aria-label={t('settings.codexConnections.name')} value={model.name} onChange={(event) => updateModel(model.id, { name: event.target.value })} /></SettingsStackedField>
              <SettingsStackedField label={t('settings.codexConnections.modelID')}><Input className="h-8" required aria-label={t('settings.codexConnections.modelID')} value={model.modelID} onChange={(event) => updateModel(model.id, { modelID: event.target.value })} /></SettingsStackedField>
              <SettingsStackedField label={t('settings.codexConnections.context')}><div className={SETTINGS_NUMBER_STEPPER_ROW_CLASS}><NumberInput min={1024} max={10_000_000} aria-label={t('settings.codexConnections.context')} value={model.contextWindow} onValueChange={(contextWindow) => updateModel(model.id, { contextWindow })} /></div></SettingsStackedField>
              <SettingsStackedField label={t('settings.codexConnections.output')}><div className={SETTINGS_NUMBER_STEPPER_ROW_CLASS}><NumberInput min={1} max={1_000_000} aria-label={t('settings.codexConnections.output')} value={model.outputLimit} onValueChange={(outputLimit) => updateModel(model.id, { outputLimit })} /></div></SettingsStackedField>
            </SettingsTwoColumn>
            <SettingsCheckboxRow checked={model.input.image} onChange={(image) => updateModel(model.id, { input: { ...model.input, image } })} label={t('settings.codexConnections.image')} />
            <SettingsStackedField label={t('settings.codexConnections.efforts')} info={t('settings.codexConnections.effortsHint')} controlClassName="flex-wrap">
              {CODEX_EFFORTS.map((level) => <Button key={level} type="button" variant="chip" aria-pressed={model.efforts.includes(level)} onClick={() => updateModel(model.id, { efforts: model.efforts.includes(level) ? model.efforts.filter((item) => item !== level) : [...model.efforts, level] })}>{level}</Button>)}
            </SettingsStackedField>
            {draft.models.length > 1 ? <Button type="button" variant="ghost" onClick={() => setDraft({ ...draft, models: draft.models.filter((item) => item.id !== model.id) })}>{t('settings.codexConnections.removeModel')}</Button> : null}
          </SettingsSection>)}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={draft.models.length >= 50} onClick={() => setDraft({ ...draft, models: [...draft.models, newModel()] })}>{t('settings.codexConnections.addModel')}</Button>
            <Button type="submit">{busy ? t('common.loading') : t('settings.codexConnections.save')}</Button>
            <Button type="button" variant="ghost" onClick={() => { setDraft(null); setInvalid(false); }}>{t('settings.codexConnections.cancel')}</Button>
          </div>
          {invalid ? <p role="alert" className="text-[var(--status-error-text)]">{t('settings.codexConnections.invalid')}</p> : null}
        </fieldset>
      </form> : null}
    </SettingsPageLayout>
  );
};
