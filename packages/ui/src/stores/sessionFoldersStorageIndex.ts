import { getDeferredSafeStorage } from './utils/safeStorage';

export const FOLDERS_STORAGE_KEY = 'oc.sessions.folders';

export const COLLAPSED_STORAGE_KEY = 'oc.sessions.folderCollapse';

const STORAGE_INDEX_KEY = 'oc.sessions.folders.v2.index';

export const safeStorage = getDeferredSafeStorage();

type FolderStorageIndex = {
  version: 2;
  legacyClaimed: boolean;
  runtimes: Array<{ runtimeKey: string; updatedAt: number }>;
};

export const runtimeStorageKey = (base: string, runtimeKey: string) => `${base}.v2:${encodeURIComponent(runtimeKey)}`;

const readStorageIndex = (): FolderStorageIndex => {
  try {
    const parsed = JSON.parse(safeStorage.getItem(STORAGE_INDEX_KEY) ?? '') as Partial<FolderStorageIndex>;
    return parsed.version === 2 && Array.isArray(parsed.runtimes)
      ? { version: 2, legacyClaimed: Boolean(parsed.legacyClaimed), runtimes: parsed.runtimes }
      : { version: 2, legacyClaimed: false, runtimes: [] };
  } catch {
    return { version: 2, legacyClaimed: false, runtimes: [] };
  }
};

export const touchRuntimeStorage = (runtimeKey: string, updatedAt = Date.now(), targetStorage: Storage = safeStorage): void => {
  const index = readStorageIndex();
  const runtimes = [
    { runtimeKey, updatedAt },
    ...index.runtimes.filter((entry) => entry.runtimeKey !== runtimeKey),
  ];
  targetStorage.setItem(STORAGE_INDEX_KEY, JSON.stringify({ version: 2, legacyClaimed: index.legacyClaimed, runtimes }));
};

export const claimLegacyStorage = (runtimeKey: string): void => {
  const index = readStorageIndex();
  if (index.legacyClaimed) return;
  const legacyFolders = safeStorage.getItem(FOLDERS_STORAGE_KEY);
  const legacyCollapsed = safeStorage.getItem(COLLAPSED_STORAGE_KEY);
  if (legacyFolders) safeStorage.setItem(runtimeStorageKey(FOLDERS_STORAGE_KEY, runtimeKey), legacyFolders);
  if (legacyCollapsed) safeStorage.setItem(runtimeStorageKey(COLLAPSED_STORAGE_KEY, runtimeKey), legacyCollapsed);
  const next = { ...index, legacyClaimed: true };
  safeStorage.setItem(STORAGE_INDEX_KEY, JSON.stringify(next));
  if (safeStorage.getItem(STORAGE_INDEX_KEY) === JSON.stringify(next)) {
    safeStorage.removeItem(FOLDERS_STORAGE_KEY);
    safeStorage.removeItem(COLLAPSED_STORAGE_KEY);
  }
  touchRuntimeStorage(runtimeKey, 0);
};
