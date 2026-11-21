import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { MOBILE_HEADER_BUTTON_CLASS } from '@/components/ui/mobileHeader';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useMultiRunTitle } from '@/lib/multirun/useMultiRuns';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useUIStore } from '@/stores/useUIStore';
import { useGitStore, useIsGitRepo } from '@/stores/useGitStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSession } from '@/sync/sync-context';

import { SpaceAccessButton } from '@/components/session/spaces/SpaceAccessButton';

import { MobileSessionSwitcher } from './MobileSessionSwitcher';

export const MobileHeader: React.FC<{
  onOpenSessions: () => void;
  onOpenWorkspace: () => void;
  onOpenWorkStatus: () => void;
  workStatusOpen: boolean;
  compactTitle?: boolean;
}> = ({ onOpenSessions, onOpenWorkspace, onOpenWorkStatus, workStatusOpen, compactTitle = false }) => {
  const { t } = useI18n();
  const [switcherOpen, setSwitcherOpen] = React.useState(false);
  const titleRef = React.useRef<HTMLButtonElement>(null);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSessionDirectory = useSessionUIStore(
    React.useCallback((state) => (currentSessionId ? state.getDirectoryForSession(currentSessionId) : null), [currentSessionId]),
  );
  const effectiveDirectory = currentSessionDirectory || currentDirectory;
  const currentSession = useSession(currentSessionId, effectiveDirectory || undefined);
  const isGitRepo = useIsGitRepo(effectiveDirectory || null);
  const hasUncommittedChanges = useGitStore((state) => {
    if (!effectiveDirectory || isGitRepo !== true) return false;
    const status = state.directories.get(effectiveDirectory)?.status;
    return Boolean(status && !status.isClean);
  });

  const runOverviewKey = useUIStore((state) => state.runOverviewKey);
  const runTitle = useMultiRunTitle(runOverviewKey);
  const sessionTitle = currentSession?.title?.trim();
  const primaryLabel = (runOverviewKey ? runTitle : null)
    || sessionTitle
    || (currentSessionId ? t('mobile.sessions.untitled') : t('sessions.switcher.draftTitle'));

  React.useEffect(() => {
    setSwitcherOpen(false);
  }, [currentSessionId, effectiveDirectory]);

  const handleOpenSessions = React.useCallback(() => {
    setSwitcherOpen(false);
    onOpenSessions();
  }, [onOpenSessions]);

  const toggleSwitcher = React.useCallback(() => {
    setSwitcherOpen((current) => !current);
  }, []);

  return (
    <>
      <header
        className="oc-mobile-header relative z-30 flex shrink-0 items-center gap-1 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80"
        style={{ paddingTop: 'var(--oc-safe-area-top, 0px)' }}
      >
        <div className="flex h-[var(--oc-header-height,56px)] w-full items-center gap-1 px-2">
          <button
            type="button"
            className={MOBILE_HEADER_BUTTON_CLASS}
            aria-label={t('mobile.sessions.openSheetAria')}
            onClick={handleOpenSessions}
            style={{ touchAction: 'manipulation' }}
          >
            <Icon name="list-unordered" className="size-5" />
          </button>

          <button
            ref={titleRef}
            type="button"
            className={cn(
              'flex min-w-0 items-center rounded-lg px-2 py-1.5 text-start transition-colors active:bg-interactive-active focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              compactTitle ? 'shrink' : 'flex-1',
            )}
            aria-label={t('sessions.switcher.openAria')}
            aria-haspopup="dialog"
            aria-expanded={switcherOpen}
            onClick={toggleSwitcher}
            style={{ touchAction: 'manipulation' }}
          >
            <span className="flex min-w-0 items-center gap-1">
              <span dir="auto" className="block min-w-0 truncate oc-ui-start-align typography-ui-label font-medium text-foreground">{primaryLabel}</span>
              <Icon
                name="arrow-down-s"
                className={cn(
                  'size-4 shrink-0 text-muted-foreground transition-transform duration-150',
                  switcherOpen && 'rotate-180',
                )}
              />
            </span>
          </button>

          {compactTitle ? <div className="min-w-0 flex-1" /> : null}

          <SpaceAccessButton
            directory={effectiveDirectory}
            className={MOBILE_HEADER_BUTTON_CLASS}
            iconClassName="size-5"
          />

          <button
            type="button"
            className={MOBILE_HEADER_BUTTON_CLASS}
            aria-label={hasUncommittedChanges
              ? t('mobile.header.openWorkspaceWithChangesAria')
              : t('mobile.header.openWorkspaceAria')}
            onClick={() => {
              setSwitcherOpen(false);
              onOpenWorkspace();
            }}
            style={{ touchAction: 'manipulation' }}
          >
            <Icon name="pencil-ruler-2" className="size-5" />
            {hasUncommittedChanges ? (
              <span
                className="absolute inset-e-1.5 top-1.5 size-2.5 rounded-full border-2 border-[var(--background)] bg-[var(--status-warning)]"
                aria-hidden
              />
            ) : null}
          </button>

          {runOverviewKey ? null : (
            <Button
              variant="ghost"
              size="icon"
              className="size-10 shrink-0 rounded-full text-muted-foreground touch-manipulation aria-pressed:bg-interactive-selection aria-pressed:text-interactive-selection-foreground"
              data-mobile-work-status-trigger=""
              aria-label={t('mobile.header.metadata.openWorkStatusAria')}
              aria-haspopup="dialog"
              aria-expanded={workStatusOpen}
              aria-pressed={workStatusOpen}
              onClick={() => {
                setSwitcherOpen(false);
                onOpenWorkStatus();
              }}
            >
              <Icon name="list-indefinite" className="size-5" />
            </Button>
          )}
        </div>
      </header>
      <MobileSessionSwitcher
        open={switcherOpen}
        onClose={() => setSwitcherOpen(false)}
        anchorRef={titleRef}
      />
    </>
  );
};
