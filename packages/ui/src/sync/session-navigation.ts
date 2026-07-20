import { normalizePath } from '@/lib/pathNormalization'
import { getRuntimeKey } from '@/lib/runtime-switch'
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage'

type SessionOpener = (sessionID: string, directory: string) => void

type PersistedSessionNavigation = {
  version: 1
  sessionId: string
  directory: string | null
}

const SESSION_NAVIGATION_STORAGE_PREFIX = 'oc.sessionNavigation.v1'

const storageKey = (runtimeKey: string): string => (
  `${SESSION_NAVIGATION_STORAGE_PREFIX}:${encodeURIComponent(runtimeKey.trim() || 'default')}`
)

export const parsePersistedSessionNavigation = (raw: string | null): PersistedSessionNavigation | null => {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; sessionId?: unknown; directory?: unknown }
    if (parsed.version !== 1 || typeof parsed.sessionId !== 'string' || !parsed.sessionId.trim()) return null
    if (parsed.directory !== null && parsed.directory !== undefined && typeof parsed.directory !== 'string') return null
    return {
      version: 1,
      sessionId: parsed.sessionId.trim(),
      directory: normalizePath(typeof parsed.directory === 'string' ? parsed.directory : null),
    }
  } catch {
    return null
  }
}

export const readPersistedSessionNavigation = (
  runtimeKey = getRuntimeKey(),
): PersistedSessionNavigation | null => {
  try {
    return parsePersistedSessionNavigation(getDeferredSafeStorage().getItem(storageKey(runtimeKey)))
  } catch {
    return null
  }
}

export const persistSessionNavigation = (
  sessionId: string,
  directory: string | null | undefined,
  runtimeKey = getRuntimeKey(),
): void => {
  const normalizedSessionId = sessionId.trim()
  if (!normalizedSessionId) return
  const value: PersistedSessionNavigation = {
    version: 1,
    sessionId: normalizedSessionId,
    directory: normalizePath(directory),
  }
  try {
    getDeferredSafeStorage().setItem(storageKey(runtimeKey), JSON.stringify(value))
  } catch {
    // Storage failure only disables cold-start continuity; live selection remains valid.
  }
}

export const clearPersistedSessionNavigation = (
  sessionId?: string | null,
  runtimeKey = getRuntimeKey(),
): void => {
  try {
    const storage = getDeferredSafeStorage()
    if (sessionId) {
      const current = parsePersistedSessionNavigation(storage.getItem(storageKey(runtimeKey)))
      if (current && current.sessionId !== sessionId) return
    }
    storage.removeItem(storageKey(runtimeKey))
  } catch {
    // Best-effort cleanup; authoritative startup validation will reject stale records.
  }
}

let sessionOpener: SessionOpener | null = null

export const setSessionOpener = (opener: SessionOpener | null) => {
  sessionOpener = opener
}

export const openSessionFromToast = (sessionID: string, directory: string) => {
  sessionOpener?.(sessionID, directory)
}
