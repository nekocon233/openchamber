import React from 'react';
import { CommandItem } from '@/components/ui/command';
import type { Session } from '@/lib/opencode/model';
import { type ShortcutActionId } from '@/lib/shortcuts';
import { Icon } from "@/components/icon/Icon";
import { SessionRunningIndicator } from '@/components/session/SessionRunningIndicator';
import { matchSegments, type MatchRange } from '@/lib/search/matchSegments';
import { MatchHighlight } from './MatchHighlight';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useResolvedSessionStatusType } from '@/sync/sync-context';

export type CommandEntry = {
  id: string;
  title: string;
  icon: React.ReactNode;
  shortcutId?: ShortcutActionId;
  searchText: string;
  detail?: string;
  keywords?: string;
  secondary?: boolean;
  onSelect: () => void;
};

const LRM = '\u200E';

export const Matched: React.FC<{ text: string; ranges: ReadonlyArray<MatchRange> }> = ({ text, ranges }) => (
  ranges.length > 0 ? <MatchHighlight segments={matchSegments(text, ranges)} /> : <>{text}</>
);

export const LeadingTruncated: React.FC<{ text: string; ranges: ReadonlyArray<MatchRange>; className?: string }> = ({ text, ranges, className }) => (
  <span
    className={cn('oc-ui-start-align min-w-0 truncate text-muted-foreground', className)}
    style={{ direction: 'rtl' }}
    title={text}
  >
    {LRM}<Matched text={text} ranges={ranges} />{LRM}
  </span>
);

type SessionResultItemProps = {
  session: Session;
  title: string;
  ranges: ReadonlyArray<MatchRange>;
  branch: string | null;
  projectLabel: string | null;
  onSelect: (session: Session) => void;
};

export const SessionResultItem: React.FC<SessionResultItemProps> = ({ session, title, ranges, branch, projectLabel, onSelect }) => {
  const { t } = useI18n();
  const statusType = useResolvedSessionStatusType(session.id);
  const isRunning = statusType === 'busy' || statusType === 'retry';

  return (
    <CommandItem
      value={`session:${session.id}`}
      onSelect={() => onSelect(session)}
    >
      {isRunning ? (
        <SessionRunningIndicator
          label={t('sessions.sidebar.session.status.active')}
          className="me-2 size-4"
        />
      ) : (
        <Icon name="chat-ai-3" className="me-2 h-4 w-4" />
      )}
      <span dir="auto" className="min-w-0 flex-1 truncate oc-ui-start-align"><Matched text={title} ranges={ranges} /></span>
      {projectLabel ? (
        <span dir="auto" className="max-w-[180px] shrink-0 truncate text-muted-foreground typography-meta">{projectLabel}</span>
      ) : null}
      {branch ? (
        <span className="inline-flex max-w-[160px] shrink-0 items-center gap-1 text-muted-foreground typography-meta">
          <Icon name="git-branch" className="h-3 w-3" />
          <span dir="ltr" className="truncate">{branch}</span>
        </span>
      ) : null}
    </CommandItem>
  );
};
