import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NumberInput } from '@/components/ui/number-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SettingsSection, SettingsStackedField, SettingsCheckboxRow, SettingsTwoColumn,
  SETTINGS_SELECT_SIZE, SETTINGS_SELECT_TRIGGER_CLASS, SETTINGS_NUMBER_STEPPER_ROW_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import {
  claudeConnectionWriteSchema, type ClaudeConnection, type ClaudeConnectionWrite, type ClaudeConnectionModel,
} from '@/lib/native-agents/connections';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useConfigStore } from '@/stores/useConfigStore';

const newModel = (): ClaudeConnectionModel => ({
  id: crypto.randomUUID(), name: '', modelID: '', contextWindow: 200_000, outputLimit: 32_000,
  input: { image: false, pdf: false }, efforts: [],
});
const newConnection = (kimi: boolean): ClaudeConnectionWrite => ({
  name: kimi ? 'Kimi Coding Plan' : '',
  baseURL: kimi ? 'https://api.kimi.ai/coding/' : '',
  auth: 'api-key',
  models: [kimi ? {
    ...newModel(), name: 'Kimi', modelID: 'kimi-for-coding', contextWindow: 1_048_576,
    efforts: ['low', 'high', 'max'],
  } : newModel()],
});

export const ClaudeConnectionsPage: React.FC = () => {
  const { nativeAgents } = useRuntimeAPIs();
  const { t } = useI18n();
  const [connections, setConnections] = React.useState<ClaudeConnection[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(false);
  const [invalid, setInvalid] = React.useState(false);
  const [draft, setDraft] = React.useState<ClaudeConnectionWrite | null>(null);
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
      const values = await nativeAgents.listClaudeConnections();
      if (mounted.current && getRuntimeKey() === runtimeKey && revision.current === request) setConnections(values);
    } catch {
      if (mounted.current && getRuntimeKey() === runtimeKey && revision.current === request) setError(true);
    } finally {
      if (mounted.current && getRuntimeKey() === runtimeKey && revision.current === request) setLoading(false);
    }
  }, [nativeAgents, runtimeKey]);
  React.useEffect(() => { void load(); }, [load]);

  const refreshModels = async () => {
    if (getRuntimeKey() === runtimeKey) await useConfigStore.getState().refreshNativeProviders();
  };
  const save = async () => {
    const parsed = claudeConnectionWriteSchema.safeParse(draft);
    if (!parsed.success || (!editing && !parsed.data.apiKey)) { setInvalid(true); return; }
    revision.current += 1;
    setLoading(false);
    setBusy(true);
    setError(false);
    try {
      const saved = await nativeAgents.saveClaudeConnection(editing, parsed.data);
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
      await nativeAgents.deleteClaudeConnection(id);
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
  const updateModel = (id: string, patch: Partial<ClaudeConnectionModel>) => {
    setDraft((value) => value && ({ ...value, models: value.models.map((model) => model.id === id ? { ...model, ...patch } : model) }));
  };
  const begin = (kimi: boolean) => {
    setDraft(newConnection(kimi)); setEditing(null); setInvalid(false); setDeleting(null);
  };
  return (
    <SettingsPageLayout title={t('settings.claudeConnections.title')} description={t('settings.claudeConnections.description')}>
      <SettingsSection title={t('settings.claudeConnections.connections')} divider={false} settingsItem="providers.claude-connections" contentClassName="space-y-4">
        {loading ? <p role="status">{t('common.loading')}</p> : null}
        {error ? <p role="alert" className="text-[var(--status-error-text)]">{t('settings.claudeConnections.failed')} <Button variant="link" disabled={busy} onClick={() => void load()}>{t('settings.claudeConnections.retry')}</Button></p> : null}
        {connections.map((connection) => (
          <SettingsStackedField key={connection.id} label={connection.name} info={connection.baseURL}>
            {deleting === connection.id ? (
              <div className="space-y-2">
                <p>{t('settings.claudeConnections.deleteHint')}</p>
                <div className="flex gap-2">
                  <Button variant="destructive" disabled={busy} onClick={() => void remove(connection.id)}>{t('settings.claudeConnections.delete')}</Button>
                  <Button variant="ghost" disabled={busy} onClick={() => setDeleting(null)}>{t('settings.claudeConnections.cancel')}</Button>
                </div>
              </div>
            ) : <>
              <Button variant="outline" disabled={busy || draft !== null} onClick={() => {
                setDeleting(null);
                setEditing(connection.id);
                setDraft({ name: connection.name, baseURL: connection.baseURL, auth: connection.auth, models: connection.models });
                setInvalid(false);
              }}>{t('settings.claudeConnections.edit')}</Button>
              <Button variant="ghost" disabled={busy || draft !== null} onClick={() => setDeleting(connection.id)}>{t('settings.claudeConnections.delete')}</Button>
            </>}
          </SettingsStackedField>
        ))}
        {!draft ? <div className="flex flex-wrap gap-2">
          <Button disabled={busy || loading} onClick={() => begin(true)}>{t('settings.claudeConnections.addKimi')}</Button>
          <Button variant="outline" disabled={busy || loading} onClick={() => begin(false)}>{t('settings.claudeConnections.addCustom')}</Button>
        </div> : null}
      </SettingsSection>
      {draft ? <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <fieldset disabled={busy}>
          <SettingsSection title={t('settings.claudeConnections.connection')} contentClassName="space-y-4">
            <SettingsTwoColumn>
              <SettingsStackedField label={t('settings.claudeConnections.name')}><Input className="h-8" required maxLength={120} aria-label={t('settings.claudeConnections.name')} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></SettingsStackedField>
              <SettingsStackedField label={t('settings.claudeConnections.url')}><Input className="h-8" required type="url" aria-label={t('settings.claudeConnections.url')} value={draft.baseURL} onChange={(event) => setDraft({ ...draft, baseURL: event.target.value })} /></SettingsStackedField>
              <SettingsStackedField label={t('settings.claudeConnections.auth')}>
                <Select value={draft.auth} onValueChange={(value) => { if (value === 'api-key' || value === 'bearer') setDraft({ ...draft, auth: value }); }}>
                  <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_TRIGGER_CLASS} aria-label={t('settings.claudeConnections.auth')}><SelectValue>{draft.auth === 'api-key' ? 'x-api-key' : 'Bearer'}</SelectValue></SelectTrigger>
                  <SelectContent><SelectItem value="api-key">x-api-key</SelectItem><SelectItem value="bearer">Bearer</SelectItem></SelectContent>
                </Select>
              </SettingsStackedField>
              <SettingsStackedField label={t('settings.claudeConnections.key')} info={editing ? t('settings.claudeConnections.keepKey') : undefined}>
                <Input className="h-8" type="password" autoComplete="new-password" required={!editing} aria-label={t('settings.claudeConnections.key')} value={draft.apiKey ?? ''} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value || undefined })} />
              </SettingsStackedField>
            </SettingsTwoColumn>
          </SettingsSection>
          {draft.models.map((model, index) => <SettingsSection key={model.id} title={t('settings.claudeConnections.model', { number: index + 1 })} contentClassName="space-y-4">
            <SettingsTwoColumn>
              <SettingsStackedField label={t('settings.claudeConnections.name')}><Input className="h-8" required aria-label={t('settings.claudeConnections.name')} value={model.name} onChange={(event) => updateModel(model.id, { name: event.target.value })} /></SettingsStackedField>
              <SettingsStackedField label={t('settings.claudeConnections.modelID')}><Input className="h-8" required aria-label={t('settings.claudeConnections.modelID')} value={model.modelID} onChange={(event) => updateModel(model.id, { modelID: event.target.value })} /></SettingsStackedField>
              <SettingsStackedField label={t('settings.claudeConnections.context')}><div className={SETTINGS_NUMBER_STEPPER_ROW_CLASS}><NumberInput min={1024} max={10_000_000} aria-label={t('settings.claudeConnections.context')} value={model.contextWindow} onValueChange={(contextWindow) => updateModel(model.id, { contextWindow })} /></div></SettingsStackedField>
              <SettingsStackedField label={t('settings.claudeConnections.output')}><div className={SETTINGS_NUMBER_STEPPER_ROW_CLASS}><NumberInput min={1} max={1_000_000} aria-label={t('settings.claudeConnections.output')} value={model.outputLimit} onValueChange={(outputLimit) => updateModel(model.id, { outputLimit })} /></div></SettingsStackedField>
            </SettingsTwoColumn>
            <SettingsCheckboxRow checked={model.input.image} onChange={(image) => updateModel(model.id, { input: { ...model.input, image } })} label={t('settings.claudeConnections.image')} />
            <SettingsCheckboxRow checked={model.input.pdf} onChange={(pdf) => updateModel(model.id, { input: { ...model.input, pdf } })} label={t('settings.claudeConnections.pdf')} />
            <SettingsStackedField label={t('settings.claudeConnections.efforts')} info={t('settings.claudeConnections.effortsHint')} controlClassName="flex-wrap">
              {(['low', 'medium', 'high', 'xhigh', 'max'] as const).map((level) => <Button key={level} type="button" variant="chip" aria-pressed={model.efforts.includes(level)} onClick={() => updateModel(model.id, { efforts: model.efforts.includes(level) ? model.efforts.filter((item) => item !== level) : [...model.efforts, level] })}>{level}</Button>)}
            </SettingsStackedField>
            {draft.models.length > 1 ? <Button type="button" variant="ghost" onClick={() => setDraft({ ...draft, models: draft.models.filter((item) => item.id !== model.id) })}>{t('settings.claudeConnections.removeModel')}</Button> : null}
          </SettingsSection>)}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={draft.models.length >= 50} onClick={() => setDraft({ ...draft, models: [...draft.models, newModel()] })}>{t('settings.claudeConnections.addModel')}</Button>
            <Button type="submit">{busy ? t('common.loading') : t('settings.claudeConnections.save')}</Button>
            <Button type="button" variant="ghost" onClick={() => { setDraft(null); setInvalid(false); }}>{t('settings.claudeConnections.cancel')}</Button>
          </div>
          {invalid ? <p role="alert" className="text-[var(--status-error-text)]">{t('settings.claudeConnections.invalid')}</p> : null}
        </fieldset>
      </form> : null}
    </SettingsPageLayout>
  );
};
