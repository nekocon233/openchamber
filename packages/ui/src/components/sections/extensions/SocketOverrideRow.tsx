import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { SETTINGS_ICON_BUTTON_CLASS } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { setGuestServiceSocketPath } from '@/lib/guests/service';
import type { InstalledGuest } from '@/lib/guests/types';
import { useI18n } from '@/lib/i18n';
import type { PublicSocketBinding } from '@openchamber/sdk';

export const SocketOverrideRow: React.FC<{
  guest: InstalledGuest;
  binding: PublicSocketBinding;
  busy: boolean;
  onSaved: () => Promise<void>;
}> = ({ guest, binding, busy, onSaved }) => {
  const { t } = useI18n();
  const [value, setValue] = React.useState(binding.override ?? binding.resolved ?? '');
  const [saving, setSaving] = React.useState(false);
  const [editing, setEditing] = React.useState(!binding.resolved);

  React.useEffect(() => {
    setValue(binding.override ?? binding.resolved ?? '');
    if (!binding.resolved) {
      setEditing(true);
    }
  }, [binding.id, binding.override, binding.resolved]);

  const save = async (next: string | null) => {
    setSaving(true);
    const ok = await setGuestServiceSocketPath(guest.id, binding.id, next);
    setSaving(false);
    if (!ok) {
      toast.error(t('settings.extensions.toast.socketSaveFailed'));
      return;
    }
    toast.success(t('settings.extensions.toast.socketSaved', { name: guest.name }));
    setEditing(false);
    await onSaved();
  };

  const cancel = () => {
    setValue(binding.override ?? binding.resolved ?? '');
    if (binding.resolved) {
      setEditing(false);
    }
  };

  return (
    <div className="space-y-1">
      {editing ? (
        <div className="flex min-w-0 items-center gap-1">
          <Input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={t('settings.extensions.service.socket.path', { id: binding.id })}
            aria-label={t('settings.extensions.service.socket.path.aria', { id: binding.id })}
            className="h-8 min-w-0 flex-1 rounded-md px-3"
            disabled={busy || saving}
            autoFocus
          />
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={busy || saving}
            aria-label={t('settings.extensions.service.socket.save.aria', { id: binding.id })}
            onClick={() => void save(value.trim() || null)}
          >
            {t('settings.extensions.service.socket.save')}
          </Button>
          {binding.override ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={busy || saving}
              aria-label={t('settings.extensions.service.socket.clear.aria', { id: binding.id })}
              onClick={() => void save(null)}
            >
              {t('settings.extensions.service.socket.clear')}
            </Button>
          ) : null}
          {binding.resolved ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={busy || saving}
              aria-label={t('settings.extensions.service.socket.cancel.aria', { id: binding.id })}
              onClick={cancel}
            >
              {t('settings.extensions.service.socket.cancel')}
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="flex min-w-0 items-center gap-1">
          <div className="typography-meta min-w-0 flex-1 truncate text-muted-foreground">
            {binding.resolved
              ? t('settings.extensions.service.socket.resolved', { path: binding.resolved })
              : t('settings.extensions.service.socket.unresolved')}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={SETTINGS_ICON_BUTTON_CLASS}
            disabled={busy || saving}
            aria-label={t('settings.extensions.service.socket.edit.aria', { id: binding.id })}
            onClick={() => setEditing(true)}
          >
            <Icon name="pencil" className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
};
