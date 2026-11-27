import { useWorkspaceViewState } from '@/hooks/useWorkspaceViewState';

import * as React from 'react';

import { handleDropdownNavigationKey } from '@/components/ui/dropdown-navigation';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useMinuteTickerNow } from '@/hooks/useDurationTicker';
import type { ChangeRequestListStatus, Label, RepositoryReference, RepositoryReferenceKind, RepositoryReferenceFilter } from '@/lib/api/types';
import { isIMECompositionEvent } from '@/lib/ime';
import { useSourceControlProvider, useSourceControlProviderRegistry } from '@/lib/source-control/providers/registry';
import { useTrackedItems } from '@/lib/trackedItems/interest';
import type { TrackedItem } from '@/lib/trackedItems/model';

import { itemDirectory, leftOutFolders, type AcrossReference } from './acrossRepositories';
import { recordLabelWrite } from './labelWrites';
import type { CachedValue } from './referenceCache';
import {
    referencePickerItemKey,
    hasRepositoryPullConflict,
    trackerOfSource,
    DEFAULT_REPOSITORY_FILTER,
    DEFAULT_TRACKER_FILTER,
    REPOSITORY_PEOPLE,
    REPOSITORY_STATES,
    type ReferencePickerItem,
    type ReferencePickerSource,
    type TrackerReferenceFilter,
} from './referencePickerItems';
import {
    useRepositoryAcrossProvider,
    useRepositoryAcrossReferenceList,
    useRepositoryPullStatuses,
    useRepositoryPullStatusesAcross,
    useRepositoryReferenceDetail,
    useRepositoryReferenceList,
    useRepositoryReferenceProvider,
    useRepositorySourceStatus,
    useTrackerItemDetail,
    useTrackerReferenceList,
} from './referenceSources';
import { useRepositoryFilterMemory } from './useRepositoryFilterMemory';
import { useTrackerDescriptor } from '@/lib/trackers/registry';
import { useTrackerSourceStatus } from '@/lib/trackers/sources';

let lastRepositoryKind: RepositoryReferenceKind = 'issue';
const lastRepositoryFilter = new Map<RepositoryReferenceKind, RepositoryReferenceFilter>();
const lastTrackerFilter = new Map<string, TrackerReferenceFilter>();

const NO_REFERENCES: RepositoryReference[] = [];
const NO_DIRECTORIES: readonly string[] = [];
const NO_ACROSS_ITEMS: AcrossReference[] = [];
const NO_ITEMS: ReadonlyMap<string, ReferencePickerItem> = new Map();
const NO_FOLLOWED: TrackedItem[] = [];
const SEARCH_DEBOUNCE_MS = 300;
const DETAIL_DEBOUNCE_MS = 250;

const normalizedRepositoryFilter = (filter: RepositoryReferenceFilter, kind: RepositoryReferenceKind): RepositoryReferenceFilter => ({
    state: REPOSITORY_STATES[kind].some((state) => state === filter.state) ? filter.state : DEFAULT_REPOSITORY_FILTER.state,
    people: REPOSITORY_PEOPLE[kind].some((people) => people === filter.people) ? filter.people : DEFAULT_REPOSITORY_FILTER.people,
    labels: filter.labels,
});

export const IDLE_PULL_STATUS: CachedValue<ChangeRequestListStatus | null> = { status: 'idle' };
export const readyValue = <T,>(state: CachedValue<T | null>): T | null => (state.status === 'ready' ? state.value : null);

export type ReferenceBrowserOptions = {
    mode?: 'references' | 'project-pulls' | 'project-issues';
    projectState?: { owner: string | null; preferences: string | null };
    active?: boolean;
    source: ReferencePickerSource;
    directory: string | null;
    directories?: readonly string[] | null;
    isMobile: boolean;
    initialGitHubKind?: RepositoryReferenceKind;
    trackerContainerId?: string | null;
    retainedItems?: ReadonlyMap<string, ReferencePickerItem>;
    pinnedItem?: ReferencePickerItem | null;
    onScreen?: boolean;
};

export function useReferenceBrowser({
    mode = 'references',
    projectState,
    active = true,
    source,
    directory,
    directories = null,
    isMobile,
    initialGitHubKind,
    trackerContainerId,
    retainedItems = NO_ITEMS,
    pinnedItem = null,
    onScreen = true,
}: ReferenceBrowserOptions) {
    const projectPulls = mode === 'project-pulls';
    const projectList = mode !== 'references';
    const viewKind = mode === 'project-issues' ? 'issue' : 'pullRequest';
    const [projectPeople, setProjectPeople] = useWorkspaceViewState(viewKind, projectList ? projectState?.preferences ?? null : null, 'people');
    const [chosenRepositoryKind, setRepositoryKind] = React.useState<RepositoryReferenceKind>(
        projectList ? (projectPulls ? 'pull' : 'issue') : initialGitHubKind ?? lastRepositoryKind,
    );
    const [chosenRepositoryFilter, setRepositoryFilter] = React.useState<RepositoryReferenceFilter>(lastRepositoryFilter.get(initialGitHubKind ?? lastRepositoryKind) ?? DEFAULT_REPOSITORY_FILTER);
    const tracker = trackerOfSource(source);
    const trackerDescriptor = useTrackerDescriptor(tracker);
    const [chosenFilter, setTrackerFilter] = React.useState<{ tracker: string; filter: TrackerReferenceFilter } | null>(null);
    const rememberedFilter = (chosenFilter && chosenFilter.tracker === tracker ? chosenFilter.filter : undefined)
        ?? (tracker ? lastTrackerFilter.get(tracker) : undefined)
        ?? DEFAULT_TRACKER_FILTER;
    const trackerFilter = React.useMemo<TrackerReferenceFilter>(() => ({
        state: trackerDescriptor.stateFilters.includes(rememberedFilter.state) ? rememberedFilter.state : DEFAULT_TRACKER_FILTER.state,
        people: trackerDescriptor.capabilities.filters.people ? rememberedFilter.people : DEFAULT_TRACKER_FILTER.people,
        priority: trackerDescriptor.capabilities.filters.priority ? rememberedFilter.priority : DEFAULT_TRACKER_FILTER.priority,
    }), [rememberedFilter, trackerDescriptor]);
    const stateOwner = projectList ? projectState?.owner ?? null : null;
    const [projectAllState, setProjectAllState] = useWorkspaceViewState(viewKind, stateOwner, 'allState');
    const [query, setQueryState] = useWorkspaceViewState(viewKind, stateOwner, 'query');
    const [selectionUrl, setSelectionUrl] = useWorkspaceViewState(viewKind, stateOwner, 'selectedUrl');
    const [loadedCount, setLoadedCount] = useWorkspaceViewState(viewKind, stateOwner, 'loadedCount');
    const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
    const [highlightedKey, setHighlightedKey] = React.useState<string | null>(null);
    const [mobilePreviewKey, setMobilePreviewKey] = React.useState<string | null>(null);
    const now = useMinuteTickerNow(true);
    const searchRef = React.useRef<HTMLInputElement>(null);

    const across = !projectList && directories !== null;
    const projectProvider = useRepositoryReferenceProvider(across ? null : directory);
    const acrossProvider = useRepositoryAcrossProvider(across ? directories : null);
    const descriptor = useSourceControlProvider(across ? acrossProvider : projectProvider);
    const term = descriptor.terminology.changeRequest;
    const providersHeld = useSourceControlProviderRegistry((state) => state.holdsList);
    const hostKnown = providersHeld && (across ? acrossProvider : projectProvider) !== null;
    const awaitingHost = chosenRepositoryKind === 'discussion' && !hostKnown;
    const repositoryKind: RepositoryReferenceKind = chosenRepositoryKind === 'discussion' && hostKnown && !descriptor.features.discussions ? 'issue' : chosenRepositoryKind;
    const effectiveRepositoryFilter = repositoryKind === chosenRepositoryKind
        ? chosenRepositoryFilter
        : lastRepositoryFilter.get(repositoryKind) ?? DEFAULT_REPOSITORY_FILTER;
    const repositoryFilter = React.useMemo<RepositoryReferenceFilter>(
        () => projectList
            ? { state: projectPeople === 'any' ? projectAllState : 'open', people: projectPeople, labels: [] }
            : normalizedRepositoryFilter(effectiveRepositoryFilter, repositoryKind),
        [effectiveRepositoryFilter, projectAllState, projectPeople, projectList, repositoryKind],
    );
    const filterMemory = useRepositoryFilterMemory(
        source === 'repository' && !projectList && !across && directory !== null,
        directory,
        repositoryKind,
    );
    const changedRepositoryFilters = React.useRef(new Map<string, RepositoryReferenceFilter>());
    const filterChangedBeforeKey = React.useRef<{ kind: RepositoryReferenceKind; filter: RepositoryReferenceFilter } | null>(null);
    const [alignedFilterKey, setAlignedFilterKey] = React.useState<string | null>(null);
    React.useEffect(() => {
        const key = filterMemory.key;
        if (!key) return;
        const pending = filterChangedBeforeKey.current;
        if (pending && pending.kind === repositoryKind) {
            changedRepositoryFilters.current.set(key, pending.filter);
            filterChangedBeforeKey.current = null;
        }
        const filter = normalizedRepositoryFilter(
            changedRepositoryFilters.current.get(key) ?? filterMemory.saved ?? DEFAULT_REPOSITORY_FILTER,
            repositoryKind,
        );
        lastRepositoryFilter.set(repositoryKind, filter);
        setRepositoryFilter(filter);
        setAlignedFilterKey(key);
    }, [filterMemory.key, filterMemory.saved, repositoryKind]);
    const filterPending = filterMemory.key !== null && alignedFilterKey !== filterMemory.key;

    const repositoryStatus = useRepositorySourceStatus(across ? null : directory);
    const trackerStatus = useTrackerSourceStatus(tracker);
    const sourceStatus = source === 'repository' ? repositoryStatus : trackerStatus;

    const repositoryList = useRepositoryReferenceList({
        enabled: source === 'repository' && repositoryStatus === 'ready' && !across && !awaitingHost && !filterPending,
        active,
        scope: projectList ? 'repository' : 'network',
        directory,
        kind: repositoryKind,
        filter: repositoryFilter,
        query: debouncedQuery,
    });
    const acrossList = useRepositoryAcrossReferenceList({
        enabled: source === 'repository' && repositoryStatus === 'ready' && across && !awaitingHost,
        directories: directories ?? NO_DIRECTORIES,
        kind: repositoryKind,
        filter: repositoryFilter,
        query: debouncedQuery,
    });
    const trackerList = useTrackerReferenceList({
        enabled: tracker !== null && trackerStatus === 'ready',
        provider: tracker,
        filter: trackerFilter,
        query: debouncedQuery,
        containerId: trackerContainerId,
    });
    const otherRepositoryKind: RepositoryReferenceKind = repositoryKind === 'issue' ? 'pull' : 'issue';
    useRepositoryReferenceList({
        enabled: active && !projectList && source === 'repository' && repositoryStatus === 'ready' && !across,
        directory,
        kind: otherRepositoryKind,
        filter: lastRepositoryFilter.get(otherRepositoryKind) ?? DEFAULT_REPOSITORY_FILTER,
        query: '',
    });
    useRepositoryAcrossReferenceList({
        enabled: source === 'repository' && repositoryStatus === 'ready' && across,
        directories: directories ?? NO_DIRECTORIES,
        kind: otherRepositoryKind,
        filter: lastRepositoryFilter.get(otherRepositoryKind) ?? DEFAULT_REPOSITORY_FILTER,
        query: '',
    });
    const candidateList = source === 'repository' ? (across ? acrossList : repositoryList) : trackerList;
    useTrackedItems(onScreen ? candidateList.followed : NO_FOLLOWED);
    const showClosed = repositoryFilter.state === 'closed';
    const repositoryItems = React.useMemo(() => projectList
        ? repositoryList.items.filter(item => item.kind === repositoryKind && (showClosed ? item.state !== 'open' : item.state === 'open'))
        : repositoryList.items, [projectList, repositoryKind, repositoryList.items, showClosed]);
    const filterByPullStatus = projectPulls && projectPeople === 'mine' && descriptor.features.listStatuses;
    const singlePullStatusOf = useRepositoryPullStatuses(
        across ? null : directory,
        active && source === 'repository' && !across ? repositoryItems : NO_REFERENCES,
        { includeClosed: projectPulls && showClosed, matchHead: filterByPullStatus },
    );
    const acrossPullStatusOf = useRepositoryPullStatusesAcross(acrossList.contexts, source === 'repository' && across ? acrossList.items : NO_ACROSS_ITEMS);
    const pullStatusOf = (reference: RepositoryReference, itemFolder?: string): CachedValue<ChangeRequestListStatus | null> => (
        across ? acrossPullStatusOf(reference, itemFolder ?? null) : singlePullStatusOf(reference)
    );
    const leftOut = React.useMemo(
        () => (across && source === 'repository' ? leftOutFolders(acrossList.contexts, acrossList.skipped) : []),
        [across, acrossList.contexts, acrossList.skipped, source],
    );

    const minePullStatusOf = filterByPullStatus ? singlePullStatusOf : null;
    const minePulls = React.useMemo(() => {
        if (!minePullStatusOf) return null;
        const matches: RepositoryReference[] = [];
        let checking = false;
        let error: string | null = null;
        for (const reference of repositoryItems) {
            const result = minePullStatusOf(reference);
            if (result.status === 'error') error ??= result.error;
            else if (result.status !== 'ready') checking = true;
            else if (result.value?.checks?.state === 'success' && result.value.mergeable === true
                && !hasRepositoryPullConflict(reference, result.value)) matches.push(reference);
        }
        return { matches, checking, error };
    }, [minePullStatusOf, repositoryItems]);
    const checkingPulls = minePulls?.checking ?? false;
    const pullStatusError = minePulls?.error ?? null;
    const loadCandidatePage = candidateList.loadMore;
    const loadMore = React.useCallback(() => {
        if (!checkingPulls && pullStatusError === null) loadCandidatePage();
    }, [checkingPulls, loadCandidatePage, pullStatusError]);
    const list = minePulls ? { ...candidateList, loadMore } : candidateList;
    const visibleRepositoryItems = minePulls?.matches ?? repositoryItems;

    const items = React.useMemo<ReferencePickerItem[]>(() => {
        if (tracker) return trackerList.items.map((item) => ({ source: 'tracker', provider: tracker, item }));
        if (across) return acrossList.items.map((reference) => ({ source: 'repository', reference, directory: reference.directory }));
        return visibleRepositoryItems.map((reference) => ({ source: 'repository', reference }));
    }, [across, acrossList.items, visibleRepositoryItems, trackerList.items, tracker]);

    const [openedItem, setOpenedItem] = React.useState<ReferencePickerItem | null>(null);

    const pinnedKey = pinnedItem ? referencePickerItemKey(pinnedItem) : null;
    const openedKey = openedItem ? referencePickerItemKey(openedItem) : null;
    const effectiveHighlightKey = highlightedKey && (highlightedKey === pinnedKey || highlightedKey === openedKey || items.some((item) => referencePickerItemKey(item) === highlightedKey))
        ? highlightedKey
        : (items[0] ? referencePickerItemKey(items[0]) : null);
    const findItem = (key: string | null) => (key
        ? items.find((item) => referencePickerItemKey(item) === key)
            ?? retainedItems.get(key)
            ?? (key === pinnedKey ? pinnedItem : null)
            ?? (key === openedKey ? openedItem : null)
        : null);
    const highlightedItem = findItem(effectiveHighlightKey);
    const previewKey = isMobile || projectList ? mobilePreviewKey : effectiveHighlightKey;
    const previewItem = findItem(previewKey);

    const settledPreviewItem = useDebouncedValue(previewItem, DETAIL_DEBOUNCE_MS);
    const previewSettled = Boolean(active && settledPreviewItem && previewItem
        && referencePickerItemKey(settledPreviewItem) === referencePickerItemKey(previewItem));
    const { detail: trackerDetail } = useTrackerItemDetail(
        previewItem?.source === 'tracker' ? { provider: previewItem.provider, id: previewItem.item.id } : null,
        previewSettled,
    );
    const [revisionChoice, setRevisionChoice] = React.useState<{ key: string; sha: string } | null>(null);
    const previewRevision = revisionChoice && previewKey !== null && revisionChoice.key === previewKey ? revisionChoice.sha : null;
    const selectPreviewRevision = React.useCallback((sha: string | null) => {
        setRevisionChoice(sha && previewKey !== null ? { key: previewKey, sha } : null);
    }, [previewKey]);
    const { detail: repositoryDetail, latest: repositoryLatestDetail, refresh: refreshRepositoryDetail } = useRepositoryReferenceDetail(
        itemDirectory(previewItem, directory),
        previewItem?.source === 'repository' ? previewItem.reference : null,
        previewSettled,
        previewRevision,
    );

    const selectRepositoryKind = (kind: RepositoryReferenceKind) => {
        if (projectList) return;
        lastRepositoryKind = kind;
        setRepositoryKind(kind);
        setRepositoryFilter(lastRepositoryFilter.get(kind) ?? DEFAULT_REPOSITORY_FILTER);
        setHighlightedKey(null);
    };
    const selectRepositoryFilter = (patch: Partial<RepositoryReferenceFilter>) => {
        if (projectList) {
            const people = patch.people ?? projectPeople;
            if (people !== 'mine' && people !== 'any') return;
            const state = people === 'any' && (patch.state === 'open' || patch.state === 'closed') ? patch.state : projectAllState;
            if (people === projectPeople && state === projectAllState) return;
            if (people !== projectPeople) setProjectPeople(people);
            if (state !== projectAllState) setProjectAllState(state);
            setLoadedCount(0);
            setHighlightedKey(null);
            return;
        }
        const filter = normalizedRepositoryFilter({ ...repositoryFilter, ...patch }, repositoryKind);
        lastRepositoryFilter.set(repositoryKind, filter);
        const key = filterMemory.key;
        if (key) {
            changedRepositoryFilters.current.set(key, filter);
            filterMemory.remember(filter);
        } else {
            filterChangedBeforeKey.current = { kind: repositoryKind, filter };
        }
        setRepositoryFilter(filter);
        setHighlightedKey(null);
    };
    const selectTrackerFilter = (patch: Partial<TrackerReferenceFilter>) => {
        if (!tracker) return;
        const filter = { ...trackerFilter, ...patch };
        lastTrackerFilter.set(tracker, filter);
        setTrackerFilter({ tracker, filter });
        setHighlightedKey(null);
    };
    const setQuery = React.useCallback((value: string) => {
        setQueryState(value);
        setLoadedCount(0);
        setHighlightedKey(null);
    }, [setLoadedCount, setQueryState]);

    const moveHighlight = React.useCallback((direction: 1 | -1) => {
        if (items.length === 0) return;
        const index = items.findIndex((item) => referencePickerItemKey(item) === effectiveHighlightKey);
        const next = items[Math.min(items.length - 1, Math.max(0, index + direction))];
        if (next) setHighlightedKey(referencePickerItemKey(next));
        if (direction === 1 && index >= items.length - 3) loadMore();
    }, [effectiveHighlightKey, items, loadMore]);

    const handleNavigationKey = (event: React.KeyboardEvent<HTMLInputElement>): boolean => {
        if (isIMECompositionEvent(event)) return false;
        if (handleDropdownNavigationKey(event, (key) => moveHighlight(key === 'ArrowDown' ? 1 : -1))) return true;
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return false;
        event.preventDefault();
        moveHighlight(event.key === 'ArrowDown' ? 1 : -1);
        return true;
    };

    const showItem = (key: string) => {
        // A resumed list may refresh its first page while a later-page PR is still being read.
        if (projectList) {
            const item = findItem(key);
            setOpenedItem(item);
            if (item?.source === 'repository') setSelectionUrl(item.reference.url);
        }
        if (isMobile || projectList) {
            setHighlightedKey(key);
            setMobilePreviewKey(key);
            return;
        }
        setHighlightedKey(key);
        searchRef.current?.focus();
    };

    const labelsWritten = (reference: RepositoryReference, labels: Label[]) => {
        const index = repositoryList.items.findIndex((item) => item.kind === reference.kind && item.url === reference.url);
        const listing = !across && repositoryList.key && index >= 0 ? { listKey: repositoryList.key, index } : null;
        recordLabelWrite(reference, labels, listing);
    };

    const openItem = (item: ReferencePickerItem) => {
        setOpenedItem(item);
        const key = referencePickerItemKey(item);
        if (projectList) {
            if (item.source === 'repository') setSelectionUrl(item.reference.url);
            setHighlightedKey(key);
            setMobilePreviewKey(key);
        } else showItem(key);
    };

    return {
        mode, selectionUrl, loadedCount, setLoadedCount, projectAllState,
        source,
        directory,
        across,
        acrossProvider: across ? acrossList.contexts.provider : null,
        discussions: descriptor.features.discussions,
        leftOut,
        isMobile,
        descriptor,
        term,
        sourceStatus,
        repositoryKind,
        repositoryFilter,
        tracker,
        trackerDescriptor,
        trackerFilter,
        query,
        debouncedQuery,
        setQuery,
        selectRepositoryKind,
        selectRepositoryFilter,
        selectTrackerFilter,
        list,
        items,
        checkingPulls,
        pullStatusError,
        pullStatusOf,
        effectiveHighlightKey,
        highlightedItem,
        previewKey,
        previewItem,
        mobilePreviewKey,
        closeMobilePreview: () => { setMobilePreviewKey(null); setSelectionUrl(null); },
        trackerDetail,
        repositoryDetail,
        repositoryLatestDetail,
        refreshRepositoryDetail,
        previewRevision,
        selectPreviewRevision,
        now,
        searchRef,
        handleNavigationKey,
        showItem,
        openItem,
        labelsWritten,
    };
}

export type ReferenceBrowser = ReturnType<typeof useReferenceBrowser>;

