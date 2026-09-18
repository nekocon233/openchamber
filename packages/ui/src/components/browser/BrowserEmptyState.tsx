import React from 'react';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { OpenChamberLogo } from '@/components/ui/OpenChamberLogo';
import { useI18n } from '@/lib/i18n';
import { fetchDevServers, mergeDevServerCandidates, type DevServerDiscovery } from '@/lib/browser/devServers';
import { clearAnnouncedDevServers, useAnnouncedDevServers } from '@/lib/browser/announcedServers';
import { browserUrlLabel } from '@/lib/browser/url';
import { useForwardedPorts, useIsPortForwardRelevant } from './useForwardedPorts';

/**
 * What the panel shows before anything is loaded.
 *
 * Rather than an inert placeholder, this lists the servers actually running,
 * which is almost always what the user came here to open. Discovery failure is
 * stated plainly instead of being rendered as "nothing is running" — the two
 * mean very different things to someone whose dev server is definitely up.
 *
 * When OpenChamber is on another machine, those servers are not reachable from
 * here until one is forwarded, so each row carries that as an explicit action.
 * Forwarding publishes a dev server on its own hostname, which is a decision
 * the user makes rather than something opening a tab does for them.
 */

/** The base path a server is served under, or '' when it sits at the root. */
const pathLabel = (url: string): string => {
  try {
    const path = new URL(url).pathname;
    return path === '/' ? '' : path;
  } catch {
    return '';
  }
};

/** Re-checked while the panel is open: a project's servers appear seconds apart. */
const REFRESH_INTERVAL_MS = 2_000;

export const BrowserEmptyState: React.FC<{
  onOpen: (url: string) => void;
  directory?: string;
}> = ({ onOpen, directory = '' }) => {
  const { t } = useI18n();
  const [discovery, setDiscovery] = React.useState<DevServerDiscovery>({ kind: 'loading' });
  const announced = useAnnouncedDevServers(directory);
  const remoteOnly = useIsPortForwardRelevant();
  const forwards = useForwardedPorts({
    enabled: remoteOnly,
    onError: React.useCallback((message: string) => toast.error(message), []),
  });

  React.useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();

    const poll = () => {
      void fetchDevServers(controller.signal).then((result) => {
        if (!active) return;
        setDiscovery(result);
        // One look is a snapshot of whichever servers happened to be up first.
        timer = setTimeout(poll, REFRESH_INTERVAL_MS);
      });
    };
    poll();

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      controller.abort();
    };
  }, []);

  const candidates = React.useMemo(() => mergeDevServerCandidates({
    announced,
    discovered: discovery.kind === 'ready' ? discovery.servers : null,
  }), [announced, discovery]);

  return (
    // The whole panel must not scroll: a centred column that overflows clips its
    // own top, and no amount of scrolling reaches it. Only the list of servers
    // scrolls, and it shrinks to whatever room is left before it does.
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 overflow-hidden bg-background p-6 text-center">
      <OpenChamberLogo width={110} height={110} className="shrink-0 opacity-20" />
      <div className="flex shrink-0 flex-col gap-1">
        <span className="typography-ui-header text-foreground">{t('contextPanel.browser.empty')}</span>
        <span className="typography-micro text-muted-foreground">{t('contextPanel.browser.emptyHint')}</span>
      </div>

      {candidates.length > 0 ? (
        <div className="flex min-h-0 w-full max-w-sm flex-col gap-1">
          <span className="shrink-0 typography-micro text-left text-muted-foreground">
            {announced.length > 0
              ? t('contextPanel.browser.devServers.justStarted')
              : t('contextPanel.browser.devServers.title')}
          </span>
          {remoteOnly ? (
            <span className="shrink-0 pb-1 text-left typography-micro text-muted-foreground">
              {forwards.state.kind === 'unconfigured'
                ? t('contextPanel.browser.devServers.remoteOnlyUnconfigured')
                : t('contextPanel.browser.devServers.remoteOnly')}
            </span>
          ) : null}
          <div className="flex min-h-0 flex-col gap-1 overflow-y-auto pr-0.5">
            {candidates.map((candidate) => {
              const forwarded = forwards.isForwarded(candidate.port);
              // Only a configured forward can be started; without a template
              // the row offers nothing rather than a control that fails.
              const canForward = remoteOnly && forwards.state.kind === 'ready';
              const busy = forwards.pending.has(candidate.port);
              const openable = !remoteOnly || forwarded;

              return (
                <div key={candidate.port} className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!openable}
                    className="min-w-0 flex-1 justify-start gap-2"
                    onClick={() => {
                      // The offer is answered; leaving it up would keep suggesting
                      // servers behind a page the user is already looking at.
                      clearAnnouncedDevServers(directory);
                      onOpen(candidate.url);
                    }}
                  >
                    <Icon name="global" className="size-3.5 shrink-0" aria-hidden="true" />
                    <span className="truncate">{browserUrlLabel(candidate.url) || candidate.url}</span>
                    <span className="ml-auto truncate typography-micro text-muted-foreground">
                      {pathLabel(candidate.url)}
                    </span>
                  </Button>

                  {canForward ? (
                    <Button
                      type="button"
                      variant={forwarded ? 'secondary' : 'default'}
                      size="sm"
                      disabled={busy}
                      className="shrink-0"
                      title={forwarded ? t('contextPanel.browser.portForward.exposureWarning') : undefined}
                      onClick={() => {
                        if (forwarded) {
                          void forwards.stop(candidate.port);
                          return;
                        }
                        void forwards.start(candidate.port).then((forward) => {
                          if (!forward) return;
                          clearAnnouncedDevServers(directory);
                          onOpen(candidate.url);
                        });
                      }}
                    >
                      {busy
                        ? t('contextPanel.browser.portForward.starting')
                        : forwarded
                          ? t('contextPanel.browser.portForward.stop')
                          : t('contextPanel.browser.portForward.start')}
                    </Button>
                  ) : null}
                </div>
              );
            })}
          </div>
          {remoteOnly && forwards.state.kind === 'ready' ? (
            <span className="shrink-0 pt-1 text-left typography-micro text-muted-foreground">
              {t('contextPanel.browser.portForward.exposureWarning')}
            </span>
          ) : null}
        </div>
      ) : null}

      {candidates.length === 0 && discovery.kind === 'unavailable' ? (
        <span className="typography-micro text-muted-foreground">
          {t('contextPanel.browser.devServers.unavailable')}
        </span>
      ) : null}
    </div>
  );
};
