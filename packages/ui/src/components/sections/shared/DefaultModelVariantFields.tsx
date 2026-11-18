import { CodexVariantSelect } from '@/components/model-picker/CodexVariantSelect';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import { NATIVE_PROVIDER_CODEX } from '@/lib/native-agents/ids';
import { SettingsFieldRow, SETTINGS_SELECT_ROW_TRIGGER_CLASS } from './SettingsSection';

type Props = {
  scope: 'sessions' | 'projects';
  providerId?: string;
  variants: string[];
  value?: string;
  onChange: (value: string | undefined) => void;
  combination?: boolean;
};

export function DefaultModelVariantFields({ scope, providerId, variants, value, onChange, combination }: Props) {
  const { t } = useI18n();
  const label = t(scope === 'sessions' ? 'settings.openchamber.defaults.field.defaultThinking' : 'settings.projects.page.field.projectThinking');
  const defaultLabel = t(scope === 'sessions' ? 'settings.openchamber.defaults.option.default' : 'settings.projects.page.option.thinkingDefault');
  const codex = providerId === NATIVE_PROVIDER_CODEX && !combination;
  const disabled = combination || !variants.length;
  const selectProps = { variants, variant: value, onChange, className: SETTINGS_SELECT_ROW_TRIGGER_CLASS, disabled };
  const format = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);
  return <>
    <SettingsFieldRow settingsItem={`${scope}.default-thinking`} label={label}>
      {codex ? <CodexVariantSelect field="effort" label={label} {...selectProps} /> : (
        <Select value={value ?? '__default__'} disabled={disabled} onValueChange={(id) => onChange(id === '__default__' ? undefined : id)}>
          <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={label}>
            <SelectValue>{combination ? t('agents.combinations.defaultThinking') : value ? format(value) : defaultLabel}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__default__">{defaultLabel}</SelectItem>
            {variants.map((id) => <SelectItem key={id} value={id}>{format(id)}</SelectItem>)}
          </SelectContent>
        </Select>
      )}
    </SettingsFieldRow>
    {codex && <SettingsFieldRow label={t('chat.modelControls.speed')} settingsItem={`${scope}.default-speed`}>
      <CodexVariantSelect field="speed" {...selectProps} />
    </SettingsFieldRow>}
  </>;
}
