import type { Session } from "@opencode-ai/sdk/v2"

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

export const getSessionIdsRemovedSince = (baselineRevision: number): Set<string> => {
  const removed = new Set<string>()
  for (const [sessionId, revision] of removalRevisionBySessionId) {
    if (revision > baselineRevision) removed.add(sessionId)
  }
  return removed
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
  return getSessionRecencyTimestamp(incomingSession) < getSessionRecencyTimestamp(currentSession)
}
