/**
 * The list and preview state behind the reference picker and the issues and
 * PRs board: the GitHub tab and filter, the search, the highlighted row and
 * the details of the item it rests on. Each surface lays these parts out and
 * adds what it does with an item: the picker checks and attaches, the board
 * acts on the previewed one.
 */

import * as React from 'react';

import { handleDropdownNavigationKey } from '@/components/ui/dropdown-navigation';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import type { GitHubPullStatus, GitHubReference, GitHubReferenceKind, RepositoryReferenceFilter } from '@/lib/api/types';
import { isIMECompositionEvent } from '@/lib/ime';
import { useWorkspaceViewState } from '@/hooks/useWorkspaceViewState';

import type { CachedValue } from './referenceCache';
import {
    referencePickerItemKey,
    DEFAULT_LINEAR_FILTER,
    DEFAULT_REPOSITORY_FILTER,
    type LinearReferenceFilter,
    type ReferencePickerItem,
    type ReferencePickerSource,
} from './referencePickerItems';
import {
    useGitHubPullStatuses,
    useGitHubReferenceDetail,
    useGitHubReferenceList,
    useGitHubSourceStatus,
    useLinearIssueDetail,
    useLinearReferenceList,
    useLinearSourceStatus,
    useRepositoryReferenceProvider,
} from './referenceSources';

// Remembered for the app run: reopening lands on the tab and filter left last.
let lastGitHubKind: GitHubReferenceKind = 'issue';
const lastGitHubFilter = new Map<GitHubReferenceKind, RepositoryReferenceFilter>();
let lastLinearFilter: LinearReferenceFilter = DEFAULT_LINEAR_FILTER;

const NO_REFERENCES: GitHubReference[] = [];
const NO_ITEMS: ReadonlyMap<string, ReferencePickerItem> = new Map();
const SEARCH_DEBOUNCE_MS = 300;
const DETAIL_DEBOUNCE_MS = 250;
const PROJECT_PULL_FILTER: RepositoryReferenceFilter = { state: 'open', people: 'reviewRequested' };

export const IDLE_PULL_STATUS: CachedValue<GitHubPullStatus | null> = { status: 'idle' };

export type ReferenceBrowserOptions = {
    /** Project PRs have independent filters, a single repository, and an explicit detail selection. */
    mode?: 'references' | 'project-pulls';
    projectPullsState?: { owner: string | null; preferences: string | null };
    active?: boolean;
    source: ReferencePickerSource;
    /** The project GitHub or GitLab items come from. */
    directory: string | null;
    isMobile: boolean;
    /** Tab to open GitHub on; the last used one otherwise. */
    initialGitHubKind?: GitHubReferenceKind;
    /** One Linear team's issues; every team's when absent. */
    linearTeamId?: string | null;
    /** Items kept outside the list (the picker's checked ones) that can still be previewed. */
    retainedItems?: ReadonlyMap<string, ReferencePickerItem>;
    /** One item another surface asked to show, read on its own: it can be highlighted while the list does not hold it. */
    pinnedItem?: ReferencePickerItem | null;
};

export function useReferenceBrowser({
    mode = 'references',
    projectPullsState,
    active = true,
    source,
    directory,
    isMobile,
    initialGitHubKind,
    linearTeamId,
    retainedItems = NO_ITEMS,
    pinnedItem = null,
}: ReferenceBrowserOptions) {
    const projectPulls = mode === 'project-pulls';
    const [githubKind, setGitHubKind] = React.useState<GitHubReferenceKind>(projectPulls ? 'pull' : initialGitHubKind ?? lastGitHubKind);
    const [localGitHubFilter, setGitHubFilter] = React.useState<RepositoryReferenceFilter>(lastGitHubFilter.get(initialGitHubKind ?? lastGitHubKind) ?? DEFAULT_REPOSITORY_FILTER);
    const [projectPeople, setProjectPeople] = useWorkspaceViewState('pullRequest', projectPulls ? projectPullsState?.preferences ?? null : null, 'people');
    const githubFilter: RepositoryReferenceFilter = projectPulls ? { ...PROJECT_PULL_FILTER, people: projectPeople } : localGitHubFilter;
    const [linearFilter, setLinearFilter] = React.useState<LinearReferenceFilter>(lastLinearFilter);
    const stateOwner = projectPulls ? projectPullsState?.owner ?? null : null;
    const [query, setQueryState] = useWorkspaceViewState('pullRequest', stateOwner, 'query');
    const [selectionUrl, setSelectionUrl] = useWorkspaceViewState('pullRequest', stateOwner, 'selectedUrl');
    const [loadedCount, setLoadedCount] = useWorkspaceViewState('pullRequest', stateOwner, 'loadedCount');
    const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
    const [highlightedKey, setHighlightedKey] = React.useState<string | null>(null);
    const [mobilePreviewKey, setMobilePreviewKey] = React.useState<string | null>(null);
    const [now] = React.useState(() => Date.now());
    const searchRef = React.useRef<HTMLInputElement>(null);

    const githubStatus = useGitHubSourceStatus(directory);
    // A GitLab project lists in the same tabs, as merge requests, open items only.
    const isGitLab = useRepositoryReferenceProvider(directory) === 'gitlab';
    const linearStatus = useLinearSourceStatus();
    const sourceStatus = source === 'github' ? githubStatus : linearStatus;

    const githubList = useGitHubReferenceList({
        enabled: source === 'github' && githubStatus === 'ready',
        active,
        scope: projectPulls ? 'repository' : 'network',
        directory,
        kind: githubKind,
        filter: githubFilter,
        query: debouncedQuery,
    });
    const linearList = useLinearReferenceList({
        enabled: active && source === 'linear' && linearStatus === 'ready',
        filter: linearFilter,
        query: debouncedQuery,
        teamId: linearTeamId,
    });
    // The other GitHub tab loads in the background, so switching to it is instant.
    const otherGitHubKind: GitHubReferenceKind = githubKind === 'issue' ? 'pull' : 'issue';
    useGitHubReferenceList({
        enabled: active && !projectPulls && source === 'github' && githubStatus === 'ready',
        directory,
        kind: otherGitHubKind,
        filter: lastGitHubFilter.get(otherGitHubKind) ?? DEFAULT_REPOSITORY_FILTER,
        query: '',
    });
    const list = source === 'github' ? githubList : linearList;
    // Direct lookups and advanced search can return another state. Project
    // browsing keeps its open-only contract before rows or checks consume it.
    const githubItems = React.useMemo(() => projectPulls
        ? githubList.items.filter(reference => reference.kind === 'pull' && reference.state === 'open')
        : githubList.items, [githubList.items, projectPulls]);
    const pullStatusOf = useGitHubPullStatuses(directory, active && source === 'github' ? githubItems : NO_REFERENCES);

    const items = React.useMemo<ReferencePickerItem[]>(() => (
        source === 'github'
            ? githubItems.map((reference) => ({ source: 'github', reference }))
            : linearList.items.map((issue) => ({ source: 'linear', issue }))
    ), [githubItems, linearList.items, source]);

    // An item opened from the preview (a Linear parent or sub-issue): it can be
    // highlighted while the list does not hold it, like a pinned one.
    const [openedItem, setOpenedItem] = React.useState<ReferencePickerItem | null>(null);

    // The highlight follows the list: the first row until the user moves it,
    // and the first row again when the highlighted one leaves the list.
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
    const previewKey = isMobile || projectPulls ? mobilePreviewKey : effectiveHighlightKey;
    const previewItem = findItem(previewKey);

    // Details are asked for the row the highlight rests on, not every row an
    // arrow key passes over; one already fetched shows at once.
    const settledPreviewItem = useDebouncedValue(previewItem, DETAIL_DEBOUNCE_MS);
    const previewSettled = Boolean(active && settledPreviewItem && previewItem
        && referencePickerItemKey(settledPreviewItem) === referencePickerItemKey(previewItem));
    const { detail: linearDetail } = useLinearIssueDetail(previewItem?.source === 'linear' ? previewItem.issue.id : null, previewSettled);
    const { detail: githubDetail, refresh: refreshGithubDetail } = useGitHubReferenceDetail(directory, previewItem?.source === 'github' ? previewItem.reference : null, previewSettled);

    const selectGitHubKind = (kind: GitHubReferenceKind) => {
        if (projectPulls) return;
        lastGitHubKind = kind;
        setGitHubKind(kind);
        setGitHubFilter(lastGitHubFilter.get(kind) ?? DEFAULT_REPOSITORY_FILTER);
        setHighlightedKey(null);
    };
    /** Changes the state or whose items, keeping the other. */
    const selectGitHubFilter = (patch: Partial<RepositoryReferenceFilter>) => {
        const filter = { ...githubFilter, ...patch };
        if (projectPulls) {
            filter.state = 'open';
            if (filter.people === 'assigned') filter.people = 'any';
        }
        if (!projectPulls) lastGitHubFilter.set(githubKind, filter);
        if (projectPulls) {
            setProjectPeople(filter.people === 'assigned' ? 'any' : filter.people);
            setLoadedCount(0);
        } else setGitHubFilter(filter);
        setHighlightedKey(null);
    };
    /** Changes one part of the Linear filter, keeping the others. */
    const selectLinearFilter = (patch: Partial<LinearReferenceFilter>) => {
        const filter = { ...linearFilter, ...patch };
        lastLinearFilter = filter;
        setLinearFilter(filter);
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
        if (direction === 1 && index >= items.length - 3) list.loadMore();
    }, [effectiveHighlightKey, items, list]);

    /** Arrows and Ctrl+N/P from the search field; true when the key was used. */
    const handleNavigationKey = (event: React.KeyboardEvent<HTMLInputElement>): boolean => {
        if (isIMECompositionEvent(event)) return false;
        if (handleDropdownNavigationKey(event, (key) => moveHighlight(key === 'ArrowDown' ? 1 : -1))) return true;
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return false;
        event.preventDefault();
        moveHighlight(event.key === 'ArrowDown' ? 1 : -1);
        return true;
    };

    /** A row click: highlights on desktop, opens the preview in place on mobile. */
    const showItem = (key: string) => {
        // A resumed list may refresh its first page while a later-page PR is still being read.
        if (projectPulls) {
            const item = findItem(key);
            setOpenedItem(item);
            if (item?.source === 'github') setSelectionUrl(item.reference.url);
        }
        if (isMobile || projectPulls) {
            setHighlightedKey(key);
            setMobilePreviewKey(key);
            return;
        }
        setHighlightedKey(key);
        searchRef.current?.focus();
    };

    /** Previews an item the list may not hold, such as a Linear issue's parent or sub-issue. */
    const openItem = (item: ReferencePickerItem) => {
        setOpenedItem(item);
        const key = referencePickerItemKey(item);
        if (projectPulls) {
            if (item.source === 'github') setSelectionUrl(item.reference.url);
            setHighlightedKey(key);
            setMobilePreviewKey(key);
        } else showItem(key);
    };

    return {
        mode,
        source,
        directory,
        isMobile,
        isGitLab,
        sourceStatus,
        githubKind,
        githubFilter,
        selectionUrl,
        loadedCount,
        setLoadedCount,
        linearFilter,
        query,
        debouncedQuery,
        setQuery,
        selectGitHubKind,
        selectGitHubFilter,
        selectLinearFilter,
        list,
        items,
        pullStatusOf,
        effectiveHighlightKey,
        highlightedItem,
        previewKey,
        previewItem,
        mobilePreviewKey,
        closeMobilePreview: () => { setMobilePreviewKey(null); setSelectionUrl(null); },
        linearDetail,
        githubDetail,
        refreshGithubDetail,
        now,
        searchRef,
        handleNavigationKey,
        showItem,
        openItem,
    };
}

export type ReferenceBrowser = ReturnType<typeof useReferenceBrowser>;

