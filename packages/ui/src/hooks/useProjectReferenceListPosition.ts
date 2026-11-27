import * as React from 'react';
import type { ReferenceBrowser } from '@/components/references/useReferenceBrowser';
import { WORKSPACE_VIEW_DEFAULTS, useWorkspaceViewStateStore } from '@/stores/useWorkspaceViewStateStore';
import { useWorkspaceScroll } from './useWorkspaceViewState';

export function useProjectReferenceListPosition(browser: ReferenceBrowser, stateOwner: string | null, showingList: boolean) {
  const scrollRef = React.useRef<HTMLElement>(null);
  const scrollTop = React.useRef(0);
  const listVisibleRef = React.useRef(false);
  const { people, state } = browser.repositoryFilter;
  const depthIdentity = JSON.stringify([stateOwner, people, state, browser.query]);
  const savedDepth = React.useRef({ identity: depthIdentity, count: browser.loadedCount });
  if (savedDepth.current.identity !== depthIdentity) savedDepth.current = { identity: depthIdentity, count: browser.loadedCount };
  React.useEffect(() => {
    if (!showingList || browser.list.status !== 'ready') return;
    if (browser.list.items.length < savedDepth.current.count && browser.list.hasMore && !browser.list.error) browser.list.loadMore();
    if (browser.list.items.length > browser.loadedCount) browser.setLoadedCount(browser.list.items.length);
  }, [browser, showingList]);

  React.useLayoutEffect(() => {
    if (showingList && scrollRef.current) scrollRef.current.scrollTop = scrollTop.current;
    listVisibleRef.current = showingList;
    return () => { listVisibleRef.current = false; };
  }, [showingList]);
  const scrollOwnerFor = (people: typeof browser.repositoryFilter.people, state: typeof browser.repositoryFilter.state) => {
    if (!stateOwner) return null;
    const scope = [stateOwner, browser.mode === 'project-issues' ? 'issue-list' : 'list', people, browser.query];
    if (state === 'closed') scope.push(state);
    return JSON.stringify(scope);
  };
  useWorkspaceScroll(scrollRef, scrollOwnerFor(people, state),
    showingList && browser.list.status === 'ready' && (browser.list.items.length >= savedDepth.current.count || !browser.list.hasMore), showingList);

  const selectListFilter = (nextPeople: 'mine' | 'any', nextState: typeof browser.projectAllState) => {
    if (nextPeople === people && nextState === state) return;
    const scrollOwner = scrollOwnerFor(nextPeople, nextState);
    if (scrollOwner) useWorkspaceViewStateStore.getState().update('scroll', scrollOwner, () => WORKSPACE_VIEW_DEFAULTS.scroll);
    browser.selectRepositoryFilter({ people: nextPeople, state: nextState });
    scrollTop.current = 0;
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  };
  const rememberScroll = () => { scrollTop.current = scrollRef.current?.scrollTop ?? 0; };
  const onScroll: React.UIEventHandler<HTMLElement> = event => {
    if (listVisibleRef.current) scrollTop.current = event.currentTarget.scrollTop;
  };
  return { scrollRef, selectListFilter, rememberScroll, onScroll };
}
