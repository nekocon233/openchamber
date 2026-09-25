import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { NativeCodexCommandResult } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';

export type CodexCommandOutputState = {
  command: string;
  output: Extract<NativeCodexCommandResult, { kind: 'output' }>;
};

export function CodexCommandOutput({ value, onClose, onCommand }: {
  value: CodexCommandOutputState | null;
  onClose: () => void;
  onCommand: (text: string) => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog open={value !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-xl" aria-describedby={undefined}>
        <DialogHeader><DialogTitle>Codex /{value?.command}</DialogTitle></DialogHeader>
        <div className="max-h-[60dvh] space-y-4 overflow-y-auto">
          {value?.output.notices.map((notice, index) => <p key={index} className="whitespace-pre-wrap break-words text-sm text-[var(--status-warning-text)]">{notice}</p>)}
          {value?.output.entries.map((entry, index) => (
            <div key={`${entry.label}:${index}`}>
              {entry.command
                ? <Button variant="ghost" size="sm" className="max-w-full justify-start" title={entry.label} onClick={() => { if (entry.command) onCommand(entry.command); }}><span className="truncate">{entry.label}</span></Button>
                : <p className="font-medium text-sm">{entry.label}</p>}
              <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{entry.detail}</p>
            </div>
          ))}
          {value?.output.entries.length === 0 && value.output.notices.length === 0
            ? <p className="text-sm text-muted-foreground">{t('chat.codexCommand.empty')}</p>
            : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
