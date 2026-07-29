import { normalizePath } from '@/lib/pathNormalization'
import { getRuntimeKey } from '@/lib/runtime-switch'
import { getSafeStorage } from '@/stores/utils/safeStorage'

type SessionOpener = (sessionID: string, directory: string) => void

type PersistedSessionNavigation = {
  version: 1
  sessionId: string
  directory: string | null
}

const SESSION_NAVIGATION_STORAGE_PREFIX = 'oc.sessionNavigation.v1'

type SessionNavigationSurface = {
  search: string
  pathname: string
  electronWindowRole?: 'main' | 'additional' | 'mini-chat' | null
}

const getCurrentSessionNavigationSurface = (): SessionNavigationSurface => {
  if (typeof window === 'undefined') {
    return { search: '', pathname: '' }
  }
  return {
    search: window.location.search,
    pathname: window.location.pathname,
    electronWindowRole: window.__OPENCHAMBER_ELECTRON__?.windowRole ?? null,
  }
}

export const isPrimarySessionNavigationSurface = (
  surface = getCurrentSessionNavigationSurface(),
): boolean => {
  if (surface.electronWindowRole && surface.electronWindowRole !== 'main') return false
  if (surface.pathname.endsWith('/mini-chat.html')) return false
  try {
    return new URLSearchParams(surface.search).get('ocPanel') !== 'session-chat'
  } catch {
    return true
  }
}

export const shouldRestorePrimarySessionNavigation = (
  surface = getCurrentSessionNavigationSurface(),
): boolean => {
  if (!isPrimarySessionNavigationSurface(surface)) return false
  try {
    const params = new URLSearchParams(surface.search)
    return !params.has('session') && !params.has('directory')
  } catch {
    return true
  }
}

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
  if (!isPrimarySessionNavigationSurface()) return null
  try {
    return parsePersistedSessionNavigation(getSafeStorage().getItem(storageKey(runtimeKey)))
  } catch {
    return null
  }
}

export const shouldPrimePrimarySessionNavigation = (
  surface = getCurrentSessionNavigationSurface(),
  persistedSessionId = readPersistedSessionNavigation()?.sessionId ?? null,
): boolean => {
  if (!isPrimarySessionNavigationSurface(surface)) return false
  if (shouldRestorePrimarySessionNavigation(surface)) return true
  try {
    const explicitSessionId = new URLSearchParams(surface.search).get('session')?.trim() ?? ''
    return Boolean(explicitSessionId && explicitSessionId === persistedSessionId?.trim())
  } catch {
    return false
  }
}

export const persistSessionNavigation = (
  sessionId: string,
  directory: string | null | undefined,
  runtimeKey = getRuntimeKey(),
): void => {
  if (!isPrimarySessionNavigationSurface()) return
  const normalizedSessionId = sessionId.trim()
  if (!normalizedSessionId) return
  const value: PersistedSessionNavigation = {
    version: 1,
    sessionId: normalizedSessionId,
    directory: normalizePath(directory),
  }
  try {
    getSafeStorage().setItem(storageKey(runtimeKey), JSON.stringify(value))
  } catch {
    // Storage failure only disables cold-start continuity; live selection remains valid.
  }
}

export const clearPersistedSessionNavigation = (
  sessionId?: string | null,
  runtimeKey = getRuntimeKey(),
): void => {
  if (!isPrimarySessionNavigationSurface()) return
  try {
    const storage = getSafeStorage()
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
