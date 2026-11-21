import React from 'react';

import { InlineDictationButton } from '@/components/dictation/InlineDictationButton';
import { useEmojiPicker } from '@/components/emoji/useEmojiPicker';
import { clearChatDraft, createChatDraftIdentity, readChatDraft } from '@/lib/chatDraftPersistence';
import { isIMECompositionEvent } from '@/lib/ime';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { KNOWLEDGE_ICON_BUTTON_CLASS } from './knowledgeRowStyle';
import { useWorkspaceChildKey } from '@/hooks/useWorkspaceViewState';
import { workspaceViewKey } from '@/stores/useWorkspaceViewStateStore';
import { useWorkspaceDraft } from '@/hooks/useWorkspaceDraft';
import { useWorkspaceDraftStore, type PendingWorkspaceInput } from '@/stores/useWorkspaceDraftStore';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';

const NO_PENDING_INPUTS: PendingWorkspaceInput[] = [];

const COUNTER_THRESHOLD = 0.8;

type KnowledgeDraftKind = 'note' | 'todo' | 'plan';

export const KnowledgeComposer: React.FC<{
  placeholder: string;
  addLabel: string;
  maxLength: number;
  projectPath: string;
  draftKind: KnowledgeDraftKind;
  multiline?: boolean;
  dictation?: boolean;
  disabled?: boolean;
  onSubmit: (text: string) => Promise<boolean> | boolean;
  extraActions?: React.ReactNode;
}> = ({ placeholder, addLabel, maxLength, multiline = false, dictation = true, disabled = false, onSubmit, extraActions, projectPath, draftKind }) => {
  const { t } = useI18n();
  const runtime = getRuntimeKey();
  const scopedOwner = useWorkspaceChildKey('new', draftKind);
  const owner = scopedOwner ?? workspaceViewKey(runtime, projectPath, 'knowledge', draftKind);
  React.useLayoutEffect(() => {
    if (!owner) return;
    const identity = createChatDraftIdentity(runtime, projectPath, `knowledge:${draftKind}`);
    if (!identity) return;
    const legacy = readChatDraft(identity).text;
    if (!legacy) return;
    const store = useWorkspaceDraftStore.getState();
    const current = store.drafts[owner]?.value;
    if (!current) store.write(owner, legacy, '');
    else if (current !== legacy && !store.pendingInputs[owner]?.some((item) => item.value === legacy)) store.stageInput(owner, legacy);
    clearChatDraft(identity);
  }, [draftKind, owner, projectPath, runtime]);
  const input = useWorkspaceDraft(owner);
  const { value: text, setValue: setText } = input;
  const fieldRef = React.useRef<HTMLTextAreaElement>(null);
  const emojiPicker = useEmojiPicker(fieldRef);
  const isMobile = useUIStore((state) => state.isMobile);
  const [submitting, setSubmitting] = React.useState(false);
  const submittingRef = React.useRef(false);
  const [submissionId, setSubmissionId] = React.useState<string | null>(null);
  const pending = useWorkspaceDraftStore(state => owner ? state.pendingInputs[owner] ?? NO_PENDING_INPUTS : NO_PENDING_INPUTS);
  const recoverable = pending.filter(item => item.id !== submissionId);
  React.useEffect(() => {
    if (owner && !submittingRef.current && !text && recoverable[0]) useWorkspaceDraftStore.getState().restoreInput(owner, recoverable[0].id);
  }, [owner, recoverable, text]);

  const normalize = React.useCallback((value: string) => (
    (multiline ? value : value.replace(/\r?\n/g, ' ')).slice(0, maxLength)
  ), [maxLength, multiline]);

  const submit = React.useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || submittingRef.current) return;
    // Cleared at once so the next entry can be typed while this one saves; a
    // failed add puts the text back unless something new was typed meanwhile.
    submittingRef.current = true;
    const ticket = owner ? useWorkspaceDraftStore.getState().stageInput(owner, text) : null;
    setSubmissionId(ticket);
    if (!owner) setText('');
    setSubmitting(true);
    try {
      const saved = await onSubmit(trimmed);
      if (owner && ticket) {
        const store = useWorkspaceDraftStore.getState();
        if (saved) store.confirmInput(owner, ticket);
        else if (!store.drafts[owner]?.value) store.restoreInput(owner, ticket);
      } else if (!saved) setText(current => current.trim() ? current : text);
    } catch {
      if (owner && ticket && !useWorkspaceDraftStore.getState().drafts[owner]?.value) useWorkspaceDraftStore.getState().restoreInput(owner, ticket);
      else if (!owner) setText(current => current.trim() ? current : text);
    } finally {
      submittingRef.current = false;
      setSubmissionId(null);
      setSubmitting(false);
    }
  }, [onSubmit, owner, setText, text]);

  const showCounter = text.length >= maxLength * COUNTER_THRESHOLD;
  const blocked = disabled || submitting;
  const canSend = !blocked && text.trim().length > 0;

  return (
    <>
    <div
      className={cn(
        'flex items-end gap-1 py-1 pe-1',
        isMobile ? 'border-b border-edge-muted ps-1' : 'oc-surface-elevated oc-raised oc-field rounded-lg bg-[var(--surface-elevated)] ps-3',
        disabled && 'opacity-50',
      )}
    >
      <textarea
        ref={fieldRef}
        rows={1}
        value={text}
        onChange={(event) => setText(normalize(event.target.value))}
        onKeyDown={(event) => {
          if (isIMECompositionEvent(event)) return;
          if (event.key !== 'Enter') return;
          const modified = event.ctrlKey || event.metaKey;
          const submits = !multiline || modified || (!isMobile && !event.shiftKey);
          if (submits) {
            event.preventDefault();
            void submit();
          }
        }}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={multiline}
        autoComplete="off"
        className={cn(
          isMobile ? 'typography-meta' : 'typography-markdown md:typography-ui-label',
          'block min-h-6 w-full min-w-0 resize-none field-sizing-content bg-transparent py-0.5 text-foreground outline-none placeholder:text-muted-foreground',
          multiline ? 'max-h-[calc(12lh+0.25rem)]' : 'max-h-[calc(6lh+0.25rem)]',
          'focus-visible:outline-none disabled:cursor-not-allowed',
        )}
      />
      {emojiPicker}
      {showCounter ? (
        <span className="flex h-6 flex-shrink-0 items-center typography-micro text-muted-foreground" dir="auto">
          {text.length}/{maxLength}
        </span>
      ) : null}
      {dictation ? (
        <InlineDictationButton
          onTranscript={(spoken) => {
            setText((current) => normalize(current.trim() ? `${current.trimEnd()} ${spoken}` : spoken));
          }}
          disabled={disabled}
          buttonClassName={KNOWLEDGE_ICON_BUTTON_CLASS}
        />
      ) : null}
      {extraActions}
      <button
        type="button"
        onClick={() => void submit()}
        disabled={!canSend}
        className={cn(
          'inline-flex h-6 flex-shrink-0 items-center rounded-md px-1.5 typography-ui-label font-medium transition-colors',
          'focus-visible:outline-none disabled:cursor-not-allowed',
          canSend ? 'text-[var(--primary-text)] hover:bg-interactive-hover' : 'text-muted-foreground opacity-50',
        )}
        aria-label={addLabel}
      >
        {t('rightSidebar.contextNotesTodo.composer.add')}
      </button>
    </div>
    {owner && recoverable.map(item => (
      <Button key={item.id} variant="ghost" size="sm" className="max-w-full justify-start text-start"
        title={t('workspaceRestore.restoreInput')} aria-label={t('workspaceRestore.restoreInput')}
        onClick={() => useWorkspaceDraftStore.getState().restoreInput(owner, item.id)}>
        <span className="truncate">{item.value}</span>
      </Button>
    ))}
    </>
  );
};
