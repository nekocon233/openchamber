import type { Session } from "@/lib/opencode/model"
import { nativeHistoryRevision } from "@/lib/native-agents/history"

const MAX_REMOVAL_HISTORY = 5_000
let removalRevision = 0
const removalRevisionBySessionId = new Map<string, number>()

export const getSessionRemovalRevision = (): number => removalRevision

export const recordSessionRemoval = (sessionId: string): void => {
  if (!sessionId) return
  removalRevision += 1
  removalRevisionBySessionId.delete(sessionId)
  removalRevisionBySessionId.set(sessionId, removalRevision)
  while (removalRevisionBySessionId.size > MAX_REMOVAL_HISTORY) {
    const oldest = removalRevisionBySessionId.keys().next().value
    if (typeof oldest !== "string") break
    removalRevisionBySessionId.delete(oldest)
  }
}

export const wasSessionRemovedSince = (sessionId: string, baselineRevision: number): boolean => (
  (removalRevisionBySessionId.get(sessionId) ?? 0) > baselineRevision
)

export const resetSessionRemovalHistory = (): void => {
  removalRevision += 1
  removalRevisionBySessionId.clear()
}

const getSessionRecencyTimestamp = (session: Session): number => {
  const updatedAt = session.time?.updated
  if (typeof updatedAt === "number" && Number.isFinite(updatedAt)) {
    return updatedAt
  }
  const createdAt = session.time?.created
  return typeof createdAt === "number" && Number.isFinite(createdAt) ? createdAt : 0
}

export const shouldSkipStaleSessionEvent = (currentSession: Session | null, incomingSession: Session): boolean => {
  if (!currentSession) return false
  if (incomingSession.id.startsWith('ndh_')) {
    const before = nativeHistoryRevision(currentSession.metadata)
    const after = nativeHistoryRevision(incomingSession.metadata)
    if (before !== null && after !== null && before !== after) return after < before
  }
  return getSessionRecencyTimestamp(incomingSession) < getSessionRecencyTimestamp(currentSession)
}
