import React from 'react';
import { SettingsSection, SettingsFieldRow, SETTINGS_FIELDS_STACK_CLASS } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeAgentModelPicker } from '@/components/model-picker/NativeAgentModelPicker';
import { useConfigStore } from '@/stores/useConfigStore';
import { nativeAgentCombinationSchema, type NativeAgentModel, type NativeAgentCombination } from '@/lib/native-agents/combinations';
import { loadDesktopSettings, updateDesktopSettings } from '@/lib/persistence';
import { useI18n } from '@/lib/i18n';
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { getRuntimeKey } from '@/lib/runtime-switch';

type Draft = { id: string; name: string; main: NativeAgentModel | null; subagent: NativeAgentModel | null; execution: NativeAgentModel | null };
const fresh = (): Draft => ({ id: crypto.randomUUID(), name: '', main: null, subagent: null, execution: null });
export const AgentCombinationsSettings = () => {
  const { t } = useI18n();
  const entries = useConfigStore((state) => state.nativeAgentCombinations);
  const enterprise = useEnterpriseMode();
  const { nativeAgents } = useRuntimeAPIs();
  const runtimeKey = getRuntimeKey();
  const [supported, setSupported] = React.useState(false);
  const blocked = enterprise || isVSCodeRuntime() || !supported;
  const [draft, setDraft] = React.useState<Draft>(fresh);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const generation = React.useRef(0);
  React.useEffect(() => {
    generation.current += 1; setBusy(false); setError(null); setDraft(fresh());
    return () => { generation.current += 1; };
  }, [runtimeKey]);
  React.useEffect(() => {
    let active = true;
    setSupported(false);
    if (nativeAgents.supported) void nativeAgents.capabilities().then((caps) => { if (active) setSupported(caps.agentCombinations === true); }).catch(() => {});
    return () => { active = false; };
  }, [nativeAgents, runtimeKey, enterprise]);
  React.useEffect(() => {
    let active = true;
    const ticket = generation.current;
    void loadDesktopSettings().then((settings) => {
      if (!active || generation.current !== ticket || getRuntimeKey() !== runtimeKey) return;
      if (settings?.nativeAgentCombinations) useConfigStore.setState({ nativeAgentCombinations: settings.nativeAgentCombinations });
    }).catch(() => { if (active && generation.current === ticket) setError(t('agents.combinations.loadFailed')); });
    return () => { active = false; };
  }, [t, runtimeKey]);
  const persist = async (next: NativeAgentCombination[]) => {
    const ticket = ++generation.current;
    const targetRuntime = runtimeKey;
    setBusy(true); setError(null);
    try {
      await updateDesktopSettings({ nativeAgentCombinations: next });
      if (generation.current !== ticket || getRuntimeKey() !== targetRuntime) return;
      useConfigStore.setState({ nativeAgentCombinations: next });
      setDraft(fresh());
    } catch { if (generation.current === ticket && getRuntimeKey() === targetRuntime) setError(t('agents.combinations.saveFailed')); }
    finally { if (generation.current === ticket) setBusy(false); }
  };
  const parsed = nativeAgentCombinationSchema.safeParse(draft);
  return <SettingsSection title={t('agents.combinations.title')} settingsItem="sessions.agent-combinations">
    {blocked ? <p role="status" className="typography-meta text-muted-foreground">{t('agents.combinations.unavailable')}</p> : null}
    <div className={SETTINGS_FIELDS_STACK_CLASS}>
      <div className="flex flex-wrap gap-2">{entries.map((entry) => <Button type="button" key={entry.id} size="sm" disabled={busy || blocked} variant={draft.id === entry.id ? 'secondary' : 'ghost'} onClick={() => setDraft(entry)}>{entry.name}</Button>)}
        <Button type="button" size="sm" variant="outline" disabled={busy || blocked} onClick={() => setDraft(fresh())}>{t('agents.combinations.new')}</Button>
      </div>
      <SettingsFieldRow label={t('agents.combinations.name')}><Input aria-label={t('agents.combinations.name')} value={draft.name} disabled={busy || blocked} className="max-w-72" onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></SettingsFieldRow>
      <SettingsFieldRow label={t('agents.combinations.main')}><NativeAgentModelPicker label={t('agents.combinations.main')} value={draft.main} disabled={busy || blocked} onChange={(main) => setDraft({ ...draft, main })} /></SettingsFieldRow>
      <SettingsFieldRow label={t('agents.combinations.subagent')}><NativeAgentModelPicker label={t('agents.combinations.subagent')} value={draft.subagent} nullable disabled={busy || blocked} onChange={(subagent) => setDraft({ ...draft, subagent })} /></SettingsFieldRow>
      <SettingsFieldRow label={t('agents.combinations.execution')}><NativeAgentModelPicker label={t('agents.combinations.execution')} value={draft.execution} disabled={busy || blocked} onChange={(execution) => setDraft({ ...draft, execution })} /></SettingsFieldRow>
      <div className="flex gap-2">
        <Button type="button" size="sm" disabled={busy || blocked || !parsed.success} onClick={() => { if (parsed.success) void persist(entries.some((entry) => entry.id === draft.id) ? entries.map((entry) => entry.id === draft.id ? parsed.data : entry) : [...entries, parsed.data]); }}>{t('agents.combinations.save')}</Button>
        {entries.some((entry) => entry.id === draft.id) ? <Button type="button" size="sm" variant="destructive" disabled={busy || blocked} onClick={() => void persist(entries.filter((entry) => entry.id !== draft.id))}>{t('agents.combinations.delete')}</Button> : null}
      </div>
      {error ? <p role="alert" className="typography-meta text-destructive">{error}</p> : null}
    </div>
  </SettingsSection>;
};
