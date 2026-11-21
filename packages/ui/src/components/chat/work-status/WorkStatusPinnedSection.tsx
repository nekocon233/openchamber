import React from 'react';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';
import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { useDirectorySync, useSession } from '@/sync/sync-context';
import { opencodeClient } from '@/lib/opencode/client';
import type { Part } from '@/lib/opencode/model';
import { readMessageFocusInFlight, requestMessageFocus, subscribeMessageFocusStatus } from '@/lib/router/messageFocus';
import { useMobileAppActions } from '@/apps/mobileAppContext';
import { getContextObligatoryMessages } from '@/lib/contextObligatoryMessages';
import { setContextObligatoryMessage } from '@/sync/session-actions';
import { WorkStatusRow, WorkStatusSection } from './WorkStatusPrimitives';
import { useReportWorkStatusPresence } from './presenceContext';
import type { State } from '@/sync/types';

type Props = {
  sessionId: string | null;
  directory: string | null;
};


const firstText = (parts: readonly Part[] | undefined): string | null => {
  const text = (parts ?? []).find(
    (part): part is Extract<Part, { type: 'text' }> => part.type === 'text',
  )?.text;
  if (!text) return null;
  const plain = text
    .replace(/^\s*(`{3,}|~{3,})[^\n]*$/gm, '')
    .replace(/^\s*(>\s*)+/gm, '')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/(\*\*|__|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain || null;
};

export const WorkStatusPinnedSection: React.FC<Props> = ({ sessionId, directory }) => {
  const { t } = useI18n();
  const session = useSession(sessionId ?? '', directory ?? undefined);
  const entries = React.useMemo(() => getContextObligatoryMessages(session), [session]);
  const loadedTexts = useDirectorySync(useShallow((state: State) => entries.map((entry) => firstText(state.part[entry.id]))));
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const [fetched, setFetched] = React.useState<{ key: string; texts: ReadonlyMap<string, string | null> }>(
    () => ({ key: '', texts: new Map() }),
  );
  const fetchKey = `${sessionId ?? ''}\u0000${directory ?? ''}`;
  const fetchedTexts = fetched.key === fetchKey ? fetched.texts : null;
  const unresolvedIds = entries
    .filter((entry, index) => loadedTexts[index] === null && !fetchedTexts?.has(entry.id))
    .map((entry) => entry.id);
  const unresolvedKey = unresolvedIds.join(' ');
  React.useEffect(() => {
    if (!sessionId || !unresolvedKey) return;
    let cancelled = false;
    const ids = unresolvedKey.split(' ');
    void Promise.all(ids.map((id) => opencodeClient.getSessionMessage(sessionId, id, directory)
      .then((message) => firstText(message.parts))
      .catch(() => null)))
      .then((texts) => {
        if (cancelled) return;
        setFetched((current) => {
          const next = new Map(current.key === fetchKey ? current.texts : []);
          ids.forEach((id, index) => next.set(id, texts[index]));
          return { key: fetchKey, texts: next };
        });
      });
    return () => {
      cancelled = true;
    };
  }, [directory, fetchKey, sessionId, unresolvedKey]);

  const pinned = React.useMemo(
    () => entries.map((entry, index) => ({ id: entry.id, text: loadedTexts[index] ?? fetchedTexts?.get(entry.id) ?? null })),
    [entries, fetchedTexts, loadedTexts],
  );

  const handleUnpin = React.useCallback(async (messageId: string) => {
    if (!sessionId || busyId) return;
    setBusyId(messageId);
    try {
      await setContextObligatoryMessage(
        sessionId,
        directory,
        { id: messageId, createdAt: 0, role: 'user' },
        false,
      );
    } catch {
      toast.error(t('chat.workStatus.pinned.unpinFailed'));
    } finally {
      setBusyId((current) => (current === messageId ? null : current));
    }
  }, [busyId, directory, sessionId, t]);

  const mobileActions = useMobileAppActions();
  const handleReveal = React.useCallback((messageId: string) => {
    if (!sessionId) return;
    mobileActions?.closeWorkStatusSheet();
    requestMessageFocus(sessionId, messageId);
  }, [mobileActions, sessionId]);

  const inFlightId = React.useSyncExternalStore(
    subscribeMessageFocusStatus,
    () => readMessageFocusInFlight(sessionId),
    () => null,
  );

  useReportWorkStatusPresence('pinned', pinned.length > 0);

  if (pinned.length === 0) return null;

  return (
    <WorkStatusSection title={t('chat.workStatus.section.pinned')} icon="pushpin">
      {pinned.map((entry) => (
        <WorkStatusRow
          key={entry.id}
          leading={(
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="pointer-events-auto inline-flex shrink-0">
                  <button
                    type="button"
                    disabled={busyId === entry.id}
                    aria-label={t('chat.workStatus.pinned.unpin')}
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleUnpin(entry.id);
                    }}
                    className="shrink-0 rounded p-0.5 transition-opacity hover:opacity-70 disabled:opacity-40"
                  >
                    <Icon name="pushpin-2-fill" className="size-[13px]" style={{ color: 'var(--primary)' }} />
                  </button>
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>{t('chat.workStatus.pinned.unpin')}</TooltipContent>
            </Tooltip>
          )}
          muted
          label={entry.text ?? t('chat.workStatus.pinned.unavailable')}
          labelDir={entry.text ? 'auto' : undefined}
          value={inFlightId === entry.id
            ? <Icon name="loader-4" className="size-[13px] animate-spin text-muted-foreground" aria-hidden />
            : undefined}
          onClick={() => handleReveal(entry.id)}
          ariaLabel={t('chat.workStatus.pinned.reveal')}
        />
      ))}
    </WorkStatusSection>
  );
};
