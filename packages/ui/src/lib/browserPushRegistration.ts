import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { PushAPI, PushSubscribePayload } from '@/lib/api/types';
import { getClientPlatform } from '@/lib/platform';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { getSafeStorage } from '@/stores/utils/safeStorage';

type BrowserPushRegistrationStatus = 'idle' | 'reconciling' | 'confirmed' | 'missing' | 'failed';

type BrowserPushRegistrationState = {
  runtimeKey: string;
  endpoint: string | null;
  status: BrowserPushRegistrationStatus;
};

type BrowserPushAPI = Pick<PushAPI, 'getVapidPublicKey' | 'subscribe'>;
type BrowserPushProvenanceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

export type BrowserPushRegistrationDependencies = {
  getRuntimeKey(): string;
  getPushAPI(): BrowserPushAPI | null;
  getRegistration(): Promise<ServiceWorkerRegistration | null>;
  getOrigin(): string | undefined;
  getPlatform(): string;
  getStorage?(): BrowserPushProvenanceStorage | null;
  subscribeRuntimeChanged(callback: () => void): () => void;
};

const defaultDependencies: BrowserPushRegistrationDependencies = {
  getRuntimeKey,
  getPushAPI: () => getRegisteredRuntimeAPIs()?.push ?? null,
  getRegistration: async () => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
    try {
      return (await navigator.serviceWorker.getRegistration()) ?? null;
    } catch {
      return null;
    }
  },
  getOrigin: () => typeof window === 'undefined' ? undefined : window.location.origin,
  getPlatform: getClientPlatform,
  getStorage: () => typeof window === 'undefined' ? null : getSafeStorage(),
  subscribeRuntimeChanged: (callback) => subscribeRuntimeEndpointChanged(callback),
};

let reconciliationGeneration = 0;
let activeReconciliationWatchers = 0;
let browserPushOptInKnown = false;
let registrationState: BrowserPushRegistrationState = {
  runtimeKey: '',
  endpoint: null,
  status: 'idle',
};
const listeners = new Set<() => void>();

const setRegistrationState = (next: BrowserPushRegistrationState): void => {
  if (
    next.runtimeKey === registrationState.runtimeKey
    && next.endpoint === registrationState.endpoint
    && next.status === registrationState.status
  ) {
    return;
  }
  registrationState = next;
  for (const listener of listeners) listener();
};

export const getBrowserPushRegistrationState = (): BrowserPushRegistrationState => registrationState;

export const subscribeBrowserPushRegistrationState = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const base64UrlToUint8Array = (base64Url: string): Uint8Array<ArrayBuffer> => {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length) as Uint8Array<ArrayBuffer>;
  for (let index = 0; index < raw.length; index += 1) {
    output[index] = raw.charCodeAt(index);
  }
  return output;
};

const applicationServerKeyBytesMatch = (
  current: Uint8Array,
  expected: Uint8Array<ArrayBuffer>,
): boolean => {
  if (current.length !== expected.length) return false;
  return current.every((value, index) => value === expected[index]);
};

const PUSH_PROVENANCE_STORAGE_PREFIX = 'openchamber.browserPushProvenance.v1';

type StoredPushProvenance = {
  version: 1;
  endpoint: string;
  publicKey: string;
};

const getProvenanceStorage = (
  deps: BrowserPushRegistrationDependencies,
): BrowserPushProvenanceStorage | null => {
  try {
    return deps.getStorage?.() ?? null;
  } catch {
    return null;
  }
};

const provenanceStorageKey = (runtimeKey: string): string => (
  `${PUSH_PROVENANCE_STORAGE_PREFIX}:${encodeURIComponent(runtimeKey.trim() || 'default')}`
);

const listProvenanceStorageKeys = (storage: BrowserPushProvenanceStorage): string[] => {
  const keys: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(`${PUSH_PROVENANCE_STORAGE_PREFIX}:`)) keys.push(key);
    }
  } catch {
    return [];
  }
  return keys;
};

const parseStoredPushProvenance = (raw: string | null): StoredPushProvenance | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; endpoint?: unknown; publicKey?: unknown };
    const endpoint = typeof parsed.endpoint === 'string' ? parsed.endpoint.trim() : '';
    const publicKey = typeof parsed.publicKey === 'string' ? parsed.publicKey.trim() : '';
    if (parsed.version !== 1 || !endpoint || endpoint.length > 16_384 || !publicKey || publicKey.length > 4_096) {
      return null;
    }
    return { version: 1, endpoint, publicKey };
  } catch {
    return null;
  }
};

const readStoredApplicationServerKey = (
  endpoint: string,
  deps: BrowserPushRegistrationDependencies,
): Uint8Array<ArrayBuffer> | null => {
  const storage = getProvenanceStorage(deps);
  if (!storage) return null;
  for (const key of listProvenanceStorageKeys(storage)) {
    let record: StoredPushProvenance | null = null;
    try {
      record = parseStoredPushProvenance(storage.getItem(key));
    } catch {
      continue;
    }
    if (record?.endpoint !== endpoint) continue;
    try {
      return base64UrlToUint8Array(record.publicKey);
    } catch {
      // Malformed persisted provenance is non-authoritative.
    }
  }
  return null;
};

const clearStoredPushProvenance = (
  deps: BrowserPushRegistrationDependencies,
  endpoint?: string,
): void => {
  const storage = getProvenanceStorage(deps);
  if (!storage) return;
  for (const key of listProvenanceStorageKeys(storage)) {
    if (endpoint) {
      try {
        if (parseStoredPushProvenance(storage.getItem(key))?.endpoint !== endpoint) continue;
      } catch {
        continue;
      }
    }
    try {
      storage.removeItem(key);
    } catch {
      // Storage is best-effort; the live subscription remains authoritative.
    }
  }
};

const applicationServerKeysMatch = (
  subscription: PushSubscription,
  expected: Uint8Array<ArrayBuffer>,
  deps: BrowserPushRegistrationDependencies,
): boolean | null => {
  const current = subscription.options?.applicationServerKey;
  if (current) return applicationServerKeyBytesMatch(new Uint8Array(current), expected);

  const stored = readStoredApplicationServerKey(subscription.endpoint, deps);
  return stored ? applicationServerKeyBytesMatch(stored, expected) : null;
};

const rememberSubscriptionApplicationServerKey = (
  subscription: PushSubscription,
  publicKey: string,
  runtimeKey: string,
  deps: BrowserPushRegistrationDependencies,
): void => {
  const endpoint = subscription.endpoint?.trim();
  const normalizedPublicKey = publicKey.trim();
  if (!endpoint || !normalizedPublicKey) return;
  const storage = getProvenanceStorage(deps);
  if (!storage) return;
  const targetKey = provenanceStorageKey(runtimeKey);

  for (const key of listProvenanceStorageKeys(storage)) {
    let record: StoredPushProvenance | null = null;
    try {
      record = parseStoredPushProvenance(storage.getItem(key));
    } catch {
      continue;
    }
    if (key !== targetKey && record?.endpoint !== endpoint) continue;
    try {
      storage.removeItem(key);
    } catch {
      // The subsequent write can still establish current provenance.
    }
  }

  try {
    storage.setItem(targetKey, JSON.stringify({
      version: 1,
      endpoint,
      publicKey: normalizedPublicKey,
    } satisfies StoredPushProvenance));
  } catch {
    // Browsers without writable storage retain the conservative preserve behavior.
  }
};

const toSubscribePayload = (
  subscription: PushSubscription,
  deps: BrowserPushRegistrationDependencies,
): PushSubscribePayload | null => {
  const json = subscription.toJSON();
  const endpoint = json.endpoint?.trim() || subscription.endpoint?.trim();
  const p256dh = json.keys?.p256dh?.trim();
  const auth = json.keys?.auth?.trim();
  if (!endpoint || !p256dh || !auth) return null;

  return {
    endpoint,
    keys: { p256dh, auth },
    origin: deps.getOrigin(),
    platform: deps.getPlatform(),
  };
};

const registerForCapturedRuntime = async (
  subscription: PushSubscription,
  deps: BrowserPushRegistrationDependencies,
  generation: number,
  runtimeKey: string,
): Promise<boolean> => {
  const push = deps.getPushAPI();
  let payload: PushSubscribePayload | null = null;
  try {
    payload = toSubscribePayload(subscription, deps);
  } catch {
    payload = null;
  }
  if (!push || !payload) {
    if (generation === reconciliationGeneration && deps.getRuntimeKey() === runtimeKey) {
      setRegistrationState({ runtimeKey, endpoint: payload?.endpoint ?? null, status: 'failed' });
    }
    return false;
  }

  let result: { ok: true } | null = null;
  try {
    result = await push.subscribe(payload);
  } catch {
    result = null;
  }

  if (generation !== reconciliationGeneration || deps.getRuntimeKey() !== runtimeKey) return false;
  if (result?.ok !== true) {
    setRegistrationState({ runtimeKey, endpoint: payload.endpoint, status: 'failed' });
    return false;
  }

  setRegistrationState({ runtimeKey, endpoint: payload.endpoint, status: 'confirmed' });
  return true;
};

const invalidateBrowserPushRegistration = (
  deps: BrowserPushRegistrationDependencies = defaultDependencies,
): void => {
  reconciliationGeneration += 1;
  setRegistrationState({ runtimeKey: deps.getRuntimeKey(), endpoint: null, status: 'idle' });
};

export const markBrowserPushSubscriptionRemoved = (
  deps: BrowserPushRegistrationDependencies = defaultDependencies,
): void => {
  reconciliationGeneration += 1;
  browserPushOptInKnown = false;
  clearStoredPushProvenance(deps);
  setRegistrationState({ runtimeKey: deps.getRuntimeKey(), endpoint: null, status: 'missing' });
};

export const isBrowserPushRegistrationConfirmed = (
  endpoint?: string | null,
  deps: Pick<BrowserPushRegistrationDependencies, 'getRuntimeKey'> = defaultDependencies,
): boolean => {
  return registrationState.status === 'confirmed'
    && registrationState.runtimeKey === deps.getRuntimeKey()
    && (!endpoint || registrationState.endpoint === endpoint);
};

export const registerBrowserPushSubscriptionWithActiveRuntime = async (
  subscription: PushSubscription,
  deps: BrowserPushRegistrationDependencies = defaultDependencies,
): Promise<boolean> => {
  const generation = ++reconciliationGeneration;
  const runtimeKey = deps.getRuntimeKey();
  browserPushOptInKnown = true;
  setRegistrationState({ runtimeKey, endpoint: subscription.endpoint || null, status: 'reconciling' });
  return registerForCapturedRuntime(subscription, deps, generation, runtimeKey);
};

export const reconcileBrowserPushSubscription = async (
  deps: BrowserPushRegistrationDependencies = defaultDependencies,
): Promise<boolean> => {
  const generation = ++reconciliationGeneration;
  const runtimeKey = deps.getRuntimeKey();
  setRegistrationState({ runtimeKey, endpoint: null, status: 'reconciling' });

  let registration: ServiceWorkerRegistration | null = null;
  try {
    registration = await deps.getRegistration();
  } catch {
    registration = null;
  }
  if (generation !== reconciliationGeneration || deps.getRuntimeKey() !== runtimeKey) return false;
  if (!registration?.pushManager) {
    setRegistrationState({ runtimeKey, endpoint: null, status: 'missing' });
    return false;
  }

  let subscription: PushSubscription | null;
  try {
    subscription = await registration.pushManager.getSubscription();
  } catch {
    setRegistrationState({ runtimeKey, endpoint: null, status: 'failed' });
    return false;
  }
  if (generation !== reconciliationGeneration || deps.getRuntimeKey() !== runtimeKey) return false;
  if (subscription) browserPushOptInKnown = true;
  if (!subscription && !browserPushOptInKnown) {
    setRegistrationState({ runtimeKey, endpoint: null, status: 'missing' });
    return false;
  }

  const push = deps.getPushAPI();
  if (!push) {
    setRegistrationState({ runtimeKey, endpoint: subscription?.endpoint || null, status: 'failed' });
    return false;
  }

  // A service-worker scope can hold only one subscription. If the newly active
  // runtime uses a different VAPID key, preserve the user's existing opt-in by
  // replacing the stale subscription before registering it with that runtime.
  try {
    const vapid = await push.getVapidPublicKey();
    if (generation !== reconciliationGeneration || deps.getRuntimeKey() !== runtimeKey) return false;
    const publicKey = vapid?.publicKey?.trim() ?? '';
    const applicationServerKey = publicKey
      ? base64UrlToUint8Array(publicKey)
      : null;
    if (!subscription) {
      if (!applicationServerKey) {
        setRegistrationState({ runtimeKey, endpoint: null, status: 'failed' });
        return false;
      }
      const created = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });
      rememberSubscriptionApplicationServerKey(created, publicKey, runtimeKey, deps);
      if (generation !== reconciliationGeneration || deps.getRuntimeKey() !== runtimeKey) {
        if (browserPushOptInKnown) {
          if (activeReconciliationWatchers > 0) queueMicrotask(() => void reconcileBrowserPushSubscription(deps));
        } else {
          void created.unsubscribe().catch(() => false);
        }
        return false;
      }
      subscription = created;
    } else if (applicationServerKey && applicationServerKeysMatch(subscription, applicationServerKey, deps) === false) {
      const removed = await subscription.unsubscribe();
      if (!removed) {
        setRegistrationState({ runtimeKey, endpoint: subscription.endpoint || null, status: 'failed' });
        return false;
      }
      clearStoredPushProvenance(deps, subscription.endpoint);
      if (generation !== reconciliationGeneration || deps.getRuntimeKey() !== runtimeKey) {
        if (browserPushOptInKnown && activeReconciliationWatchers > 0) {
          queueMicrotask(() => void reconcileBrowserPushSubscription(deps));
        }
        return false;
      }
      const replacement = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });
      rememberSubscriptionApplicationServerKey(replacement, publicKey, runtimeKey, deps);
      if (generation !== reconciliationGeneration || deps.getRuntimeKey() !== runtimeKey) {
        if (browserPushOptInKnown) {
          if (activeReconciliationWatchers > 0) queueMicrotask(() => void reconcileBrowserPushSubscription(deps));
        } else {
          void replacement.unsubscribe().catch(() => false);
        }
        return false;
      }
      subscription = replacement;
    } else if (applicationServerKey) {
      // Some browsers do not expose applicationServerKey on PushSubscription.
      // Keep unknown provenance, then persist this authoritative key so reloads
      // and later runtime switches can detect a different key without churn.
      rememberSubscriptionApplicationServerKey(subscription, publicKey, runtimeKey, deps);
    }
  } catch {
    setRegistrationState({ runtimeKey, endpoint: subscription?.endpoint || null, status: 'failed' });
    return false;
  }

  if (generation !== reconciliationGeneration || deps.getRuntimeKey() !== runtimeKey) return false;
  return registerForCapturedRuntime(subscription, deps, generation, runtimeKey);
};

type BrowserPushUnsubscribeResult = 'removed' | 'local-failed' | 'server-failed';

export const unsubscribeBrowserPushSubscription = async (
  subscription: PushSubscription,
  push: Pick<PushAPI, 'unsubscribe'>,
  deps: BrowserPushRegistrationDependencies = defaultDependencies,
): Promise<BrowserPushUnsubscribeResult> => {
  const runtimeKey = deps.getRuntimeKey();
  const endpoint = subscription.endpoint?.trim() ?? '';
  const previousState = registrationState;
  let removed = false;
  let unsubscribeThrew = false;
  try {
    removed = await subscription.unsubscribe();
  } catch {
    removed = false;
    unsubscribeThrew = true;
  }

  if (!removed) {
    if (
      !unsubscribeThrew
      && previousState.status === 'confirmed'
      && previousState.runtimeKey === runtimeKey
      && previousState.endpoint === endpoint
    ) {
      return 'local-failed';
    }
    await reconcileBrowserPushSubscription(deps);
    return 'local-failed';
  }

  markBrowserPushSubscriptionRemoved(deps);
  if (!endpoint || deps.getRuntimeKey() !== runtimeKey) return 'server-failed';

  try {
    const result = await push.unsubscribe({ endpoint });
    return result?.ok === true ? 'removed' : 'server-failed';
  } catch {
    return 'server-failed';
  }
};

export const startBrowserPushSubscriptionReconciliation = (
  deps: BrowserPushRegistrationDependencies = defaultDependencies,
): (() => void) => {
  let disposed = false;
  activeReconciliationWatchers += 1;
  const reconcile = () => {
    if (disposed) return;
    void reconcileBrowserPushSubscription(deps);
  };

  invalidateBrowserPushRegistration(deps);
  reconcile();
  const unsubscribe = deps.subscribeRuntimeChanged(() => {
    invalidateBrowserPushRegistration(deps);
    reconcile();
  });

  return () => {
    disposed = true;
    activeReconciliationWatchers = Math.max(0, activeReconciliationWatchers - 1);
    unsubscribe();
    invalidateBrowserPushRegistration(deps);
  };
};
