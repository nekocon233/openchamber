import * as React from 'react';

import type { RepositoryReferencesAcrossSkip } from '@/lib/api/types';

const FRESH_MS = 60_000;

export type ListSkip = { directory: string; reason: RepositoryReferencesAcrossSkip };

const mergeSkipped = (shown: readonly ListSkip[], next: readonly ListSkip[]): ListSkip[] => {
    const known = new Set(shown.map((skip) => skip.directory));
    return [...shown, ...next.filter((skip) => !known.has(skip.directory))];
};

export type ListPage<T> =
    | { kind: 'page'; items: T[]; cursor: string | null; hasMore: boolean; total?: number; skipped?: ListSkip[] }
    | { kind: 'unavailable'; reason: 'disconnected' | 'no-repo' };

export type CachedList<T> = {
    status: 'loading' | 'ready' | 'unavailable' | 'error';
    unavailable: 'disconnected' | 'no-repo' | null;
    items: T[];
    hasMore: boolean;
    total?: number;
    refreshing: boolean;
    loadingMore: boolean;
    error: string | null;
    skipped: ListSkip[];
    pageReads: PageRead[];
};

export type ReadStamp = { at: number; forced: boolean };

export type PageRead = { start: number; read: ReadStamp };

export type CachedValue<T> =
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'ready'; value: T }
    | { status: 'error'; error: string };

type PageFetcher<T> = (cursor: string | null) => Promise<ListPage<T>>;

type ListRecord<T> = CachedList<T> & {
    cursor: string | null;
    fetchedAt: number;
    generation: number;
    fetchPage: PageFetcher<T>;
};

type ValueRecord<T> = { state: CachedValue<T>; fetchedAt: number; forced: boolean };

type Listener = () => void;

type Settled<R> = { ok: true; value: R } | { ok: false; message: string };

const settle = async <R,>(request: Promise<R>): Promise<Settled<R>> => {
    try {
        return { ok: true, value: await request };
    } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
};

class KeyedStore<R> {
    private readonly records = new Map<string, R>();
    private readonly listeners = new Map<string, Set<Listener>>();
    version = 0;

    constructor(private readonly limit: number) {}

    get(key: string): R | undefined {
        return this.records.get(key);
    }

    entries(): Array<[string, R]> {
        return [...this.records.entries()];
    }

    delete(key: string): void {
        if (!this.records.delete(key)) return;
        this.version += 1;
        for (const listener of this.listeners.get(key) ?? []) listener();
    }

    set(key: string, record: R): void {
        this.records.delete(key);
        this.records.set(key, record);
        this.version += 1;
        for (const listener of this.listeners.get(key) ?? []) listener();
        this.evict();
    }

    subscribe(key: string, listener: Listener): () => void {
        let set = this.listeners.get(key);
        if (!set) {
            set = new Set();
            this.listeners.set(key, set);
        }
        set.add(listener);
        return () => {
            set.delete(listener);
            if (set.size === 0) this.listeners.delete(key);
        };
    }

    clear(): void {
        this.forget(() => true);
    }

    forget(picked: (key: string) => boolean): void {
        const keys = [...this.records.keys()].filter(picked);
        if (keys.length === 0) return;
        for (const key of keys) this.records.delete(key);
        this.version += 1;
        for (const key of keys) {
            for (const listener of this.listeners.get(key) ?? []) listener();
        }
    }

    private evict(): void {
        for (const key of this.records.keys()) {
            if (this.records.size <= this.limit) return;
            if (this.listeners.has(key)) continue;
            this.records.delete(key);
        }
    }
}

export type ListCache<T> = {
    ensure: (key: string, fetchPage: PageFetcher<T>, options?: { force?: boolean }) => Promise<void>;
    loadMore: (key: string) => void;
    read: (key: string) => CachedList<T> | null;
    subscribe: (key: string, listener: Listener) => () => void;
    /** Retain matching lists while retiring reads started before invalidation. */
    invalidate: (matches: (key: string) => boolean) => void;
    clear: () => void;
};

export function createListCache<T>(limit = 40, now: () => number = Date.now): ListCache<T> {
    const store = new KeyedStore<ListRecord<T>>(limit);
    const pendingReads = new Map<string, Promise<void>>();
    const queuedReads = new Map<string, { running: Promise<void>; promise: Promise<void> }>();
    let generationSequence = 0;
    let clearEpoch = 0;

    const update = (key: string, record: ListRecord<T>, patch: Partial<ListRecord<T>>) => {
        store.set(key, { ...record, ...patch });
    };

    const ensure: ListCache<T>['ensure'] = (key, fetchPage, options) => {
        const running = pendingReads.get(key);
        const existing = store.get(key);
        if (running && (options?.force || !existing?.refreshing)) {
            const queued = queuedReads.get(key);
            if (queued?.running === running) return queued.promise;
            const epoch = clearEpoch;
            // The caller may have invalidated the server cache. Finish the old
            // response before asking again, so its in-flight answer is not reused.
            const promise = running.then(() => epoch === clearEpoch ? ensure(key, fetchPage, { force: true }) : undefined);
            queuedReads.set(key, { running, promise });
            void promise.finally(() => { if (queuedReads.get(key)?.promise === promise) queuedReads.delete(key); });
            return promise;
        }
        if (existing && (existing.refreshing || (!options?.force && now() - existing.fetchedAt < FRESH_MS))) {
            if (existing.fetchPage !== fetchPage) update(key, existing, { fetchPage });
            return Promise.resolve();
        }
        const generation = ++generationSequence;
        store.set(key, existing
            ? { ...existing, refreshing: true, loadingMore: false, generation, fetchPage }
            : {
                status: 'loading',
                unavailable: null,
                items: [],
                hasMore: false,
                refreshing: true,
                loadingMore: false,
                error: null,
                skipped: [],
                pageReads: [],
                cursor: null,
                fetchedAt: 0,
                generation,
                fetchPage,
            });
        const request = settle(fetchPage(null)).then((outcome) => {
            const current = store.get(key);
            if (!current || current.generation !== generation) return;
            if (!outcome.ok) {
                update(key, current, {
                    status: current.status === 'loading' ? 'error' : current.status,
                    refreshing: false,
                    error: outcome.message,
                });
                return;
            }
            const page = outcome.value;
            if (page.kind === 'unavailable') {
                update(key, current, {
                    status: 'unavailable',
                    unavailable: page.reason,
                    items: [],
                    cursor: null,
                    hasMore: false,
                    total: undefined,
                    refreshing: false,
                    error: null,
                    skipped: [],
                    pageReads: [],
                    fetchedAt: now(),
                });
                return;
            }
            const at = now();
            update(key, current, {
                status: 'ready',
                skipped: page.skipped ?? [],
                unavailable: null,
                items: page.items,
                cursor: page.cursor,
                hasMore: page.hasMore,
                total: page.total,
                refreshing: false,
                error: null,
                pageReads: [{ start: 0, read: { at, forced: options?.force === true || existing?.fetchedAt === -Infinity } }],
                fetchedAt: at,
            });
        }).finally(() => {
            if (pendingReads.get(key) === request) pendingReads.delete(key);
        });
        pendingReads.set(key, request);
        return request;
    };

    const loadMore: ListCache<T>['loadMore'] = (key) => {
        const record = store.get(key);
        if (!record || !record.hasMore || record.loadingMore || record.refreshing || record.status !== 'ready') return;
        const { generation, cursor } = record;
        update(key, record, { loadingMore: true });
        void settle(record.fetchPage(cursor)).then((outcome) => {
            const current = store.get(key);
            if (!current || current.generation !== generation) return;
            if (!outcome.ok) {
                update(key, current, { loadingMore: false, error: outcome.message });
                return;
            }
            const page = outcome.value;
            if (page.kind === 'unavailable') {
                update(key, current, { loadingMore: false, hasMore: false });
                return;
            }
            update(key, current, {
                items: [...current.items, ...page.items],
                pageReads: [...current.pageReads, { start: current.items.length, read: { at: now(), forced: false } }],
                cursor: page.cursor,
                hasMore: page.hasMore,
                total: page.total ?? current.total,
                loadingMore: false,
                error: null,
                skipped: mergeSkipped(current.skipped, page.skipped ?? []),
            });
        });
    };

    return {
        ensure,
        loadMore,
        read: (key) => store.get(key) ?? null,
        subscribe: (key, listener) => store.subscribe(key, listener),
        invalidate: (matches) => {
            for (const [key, record] of store.entries()) {
                if (matches(key)) update(key, record, { fetchedAt: -Infinity, generation: ++generationSequence, refreshing: false, loadingMore: false });
            }
        },
        clear: () => { clearEpoch += 1; pendingReads.clear(); queuedReads.clear(); store.clear(); },
    };
}

export type ValueCache<T> = {
    ensure: (key: string, fetch: () => Promise<T>, options?: { force?: boolean }) => Promise<T>;
    ensureMany: (keys: string[], fetch: (keys: string[]) => Promise<ReadonlyMap<string, T>>, batchSize: number) => void;
    read: (key: string) => CachedValue<T> | null;
    readOf: (key: string) => ReadStamp | null;
    subscribe: (key: string, listener: Listener) => () => void;
    version: () => number;
    forget: (picked: (key: string) => boolean) => void;
    invalidate: (matches: (key: string) => boolean) => void;
    clear: () => void;
};

export function createValueCache<T>(limit = 40, now: () => number = Date.now): ValueCache<T> {
    const store = new KeyedStore<ValueRecord<T>>(limit);
    const inflight = new Map<string, Promise<T>>();
    const retired = new Set<Promise<T>>();

    const isFresh = (key: string) => {
        const existing = store.get(key);
        return existing?.state.status === 'ready' && now() - existing.fetchedAt < FRESH_MS;
    };

    const track = (key: string, request: Promise<Settled<T>>, forced = false): Promise<T> => {
        if (store.get(key)?.state.status !== 'ready') {
            store.set(key, { state: { status: 'loading' }, fetchedAt: 0, forced: false });
        }
        const promise = request.then((outcome) => {
            const stale = retired.delete(promise);
            if (inflight.get(key) !== promise || stale) {
                if (inflight.get(key) === promise) {
                    inflight.delete(key);
                    // Active readers can now ask past the old server-side flight.
                    revalidateReferences();
                }
                if (!outcome.ok) throw new Error(outcome.message);
                return outcome.value;
            }
            inflight.delete(key);
            if (!outcome.ok) {
                store.set(key, { state: { status: 'error', error: outcome.message }, fetchedAt: 0, forced: false });
                throw new Error(outcome.message);
            }
            store.set(key, { state: { status: 'ready', value: outcome.value }, fetchedAt: now(), forced });
            return outcome.value;
        });
        inflight.set(key, promise);
        return promise;
    };

    const ensure: ValueCache<T>['ensure'] = (key, fetch, options) => {
        const existing = store.get(key);
        const running = inflight.get(key);
        if (options?.force || (running && retired.has(running))) {
            const after = running ? running.then(() => undefined, () => undefined) : Promise.resolve();
            return track(key, settle(after.then(fetch)), Boolean(options?.force));
        }
        if (existing?.state.status === 'ready' && isFresh(key)) {
            return Promise.resolve(existing.state.value);
        }
        return running ?? track(key, settle(fetch()));
    };

    const ensureMany: ValueCache<T>['ensureMany'] = (keys, fetch, batchSize) => {
        const wanted = [...new Set(keys)].filter((key) => !isFresh(key) && !inflight.has(key));
        for (let start = 0; start < wanted.length; start += batchSize) {
            const batch = wanted.slice(start, start + batchSize);
            const answer = settle(fetch(batch));
            for (const key of batch) {
                const one = answer.then((outcome): Settled<T> => {
                    if (!outcome.ok) return outcome;
                    for (const [answered, value] of outcome.value) {
                        if (answered === key) return { ok: true, value };
                    }
                    return { ok: false, message: 'Not in the answer' };
                });
                track(key, one).catch(() => undefined);
            }
        }
    };

    return {
        ensure,
        ensureMany,
        read: (key) => store.get(key)?.state ?? null,
        readOf: (key) => {
            const record = store.get(key);
            return record?.state.status === 'ready' ? { at: record.fetchedAt, forced: record.forced } : null;
        },
        subscribe: (key, listener) => store.subscribe(key, listener),
        version: () => store.version,
        forget: (picked) => {
            for (const [key, running] of inflight) {
                if (picked(key)) {
                    retired.add(running);
                    inflight.delete(key);
                }
            }
            store.forget(picked);
        },
        invalidate: (matches) => {
            for (const [key] of store.entries()) {
                if (!matches(key)) continue;
                const running = inflight.get(key);
                if (running) retired.add(running);
                store.delete(key);
            }
        },
        clear: () => {
            for (const running of inflight.values()) retired.add(running);
            store.clear();
        },
    };
}

const noSubscription = () => () => undefined;

let revalidation = 0;
const revalidationListeners = new Set<Listener>();

const subscribeRevalidation = (listener: Listener) => {
    revalidationListeners.add(listener);
    return () => {
        revalidationListeners.delete(listener);
    };
};

export function revalidateReferences(): void {
    revalidation += 1;
    for (const listener of revalidationListeners) listener();
}

export function useReferenceRevalidation(): number {
    return React.useSyncExternalStore(subscribeRevalidation, () => revalidation, () => revalidation);
}

export function useCachedList<T>(
    cache: ListCache<T>,
    key: string | null,
    fetchPage: PageFetcher<T>,
    active = true,
): CachedList<T> & { loadMore: () => void; retry: () => Promise<void> } {
    const subscribe = React.useCallback(
        (listener: Listener) => (key ? cache.subscribe(key, listener) : noSubscription()),
        [cache, key],
    );
    const snapshot = React.useSyncExternalStore(subscribe, () => (key ? cache.read(key) : null));
    const revalidation = useReferenceRevalidation();

    React.useEffect(() => {
        if (key && active) void cache.ensure(key, fetchPage);
    }, [active, cache, fetchPage, key, revalidation]);

    const loadMore = React.useCallback(() => {
        if (key && active) cache.loadMore(key);
    }, [active, cache, key]);
    const retry = React.useCallback(
        () => (key && active ? cache.ensure(key, fetchPage, { force: true }) : Promise.resolve()),
        [active, cache, fetchPage, key],
    );

    return {
        ...(snapshot ?? { status: 'loading', unavailable: null, items: [], hasMore: false, refreshing: false, loadingMore: false, error: null, skipped: [], pageReads: [] }),
        loadMore,
        retry,
    };
}

export function useCachedValue<T>(
    cache: ValueCache<T>,
    key: string | null,
    fetch: () => Promise<T>,
    fetchNow = true,
): CachedValue<T> {
    const subscribe = React.useCallback(
        (listener: Listener) => (key ? cache.subscribe(key, listener) : noSubscription()),
        [cache, key],
    );
    const snapshot = React.useSyncExternalStore(subscribe, () => (key ? cache.read(key) : null));
    const revalidation = useReferenceRevalidation();

    React.useEffect(() => {
        if (key && fetchNow) cache.ensure(key, fetch).catch(() => undefined);
    }, [cache, fetch, fetchNow, key, revalidation]);

    return snapshot ?? { status: 'idle' };
}
