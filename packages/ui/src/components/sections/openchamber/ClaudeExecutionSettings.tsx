import * as React from 'react';
import {
  SettingsFieldRow,
  SettingsSection,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SETTINGS_SELECT_SIZE,
} from '@/components/sections/shared/SettingsSection';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import { updateDesktopSettings } from '@/lib/persistence';
import { getRuntimeEndpointGeneration } from '@/lib/runtime-switch';
import { useUIStore } from '@/stores/useUIStore';

export function ClaudeExecutionSettings() {
  const { t } = useI18n();
  const enabled = useUIStore((state) => state.claudeCodeExecution);
  const available = useUIStore((state) => state.claudeCodeExecutionAvailable);
  const [saving, setSaving] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const executor = enabled && available ? 'claude-code' : 'opencode';

  const change = async (value: boolean) => {
    const generation = getRuntimeEndpointGeneration();
    setSaving(true);
    setFailed(false);
    try {
      await updateDesktopSettings({ claudeCodeExecution: value });
      if (generation !== getRuntimeEndpointGeneration()) return;
      setFailed(useUIStore.getState().claudeCodeExecution !== value);
    } catch {
      if (generation === getRuntimeEndpointGeneration()) setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection title={t('settings.chat.execution.title')} divider={false}>
      <SettingsFieldRow
        settingsItem="chat.claude-code-execution"
        label={t('settings.chat.execution.label')}
        info={t('settings.chat.execution.info')}
        description={!available ? t('settings.chat.execution.unavailable') : failed ? t('settings.chat.execution.failed') : undefined}
      >
        <Select
          value={executor}
          disabled={!available || saving}
          onValueChange={(value) => { void change(value === 'claude-code'); }}
        >
          <SelectTrigger
            size={SETTINGS_SELECT_SIZE}
            className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}
            aria-label={t('settings.chat.execution.label')}
          >
            <SelectValue>{executor === 'claude-code' ? 'Claude Code' : 'OpenCode'}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="opencode">OpenCode</SelectItem>
            <SelectItem value="claude-code">Claude Code</SelectItem>
          </SelectContent>
        </Select>
      </SettingsFieldRow>
    </SettingsSection>
  );
}
