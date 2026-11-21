import type { Message, Part } from '@/lib/opencode/model';
import type { DirectoryStore } from "./child-store";
import { type OptimisticItem } from "./optimistic";

export type FetchedPage = {
  session: Message[]
  partsByMessageID: Map<string, Part[]>
  cursor: string | undefined
  complete: boolean
  metadataComplete?: boolean
  historyUnavailable?: boolean
  historyRevision?: number
}

/**
 * Drops the cached records a replacing window no longer covers, so older
 * cached history cannot sit behind a hole. Kept: records the window carries,
 * optimistic records, and records newer than the window, which arrived live
 * while it was read.
 */
export const withoutHistoryOutsideWindow = (
  state: DirectoryStore,
  sessionID: string,
  page: FetchedPage,
  optimistic: ReadonlyMap<string, OptimisticItem>,
): DirectoryStore => {
  const messages = state.message[sessionID]
  if (!messages) return state
  const pageIDs = new Set(page.session.map((message) => message.id))
  const newestWindowTime = page.session.at(-1)?.time.created ?? Number.NEGATIVE_INFINITY
  const dropped: string[] = []
  const kept = messages.filter((message) => {
    if (pageIDs.has(message.id) || optimistic.has(message.id) || message.time.created > newestWindowTime) return true
    dropped.push(message.id)
    return false
  })
  if (dropped.length === 0) return state
  const part = { ...state.part }
  for (const messageID of dropped) delete part[messageID]
  return { ...state, message: { ...state.message, [sessionID]: kept }, part }
}

/**
 * Drops the client's own copies of records the page now carries, so the
 * server's version replaces them instead of losing to them as an existing
 * record. An optimistic prompt is stamped with the browser's clock, the reply
 * with the server's; a remote client whose clock runs ahead would otherwise
 * keep its prompt sorted after the reply until a reload. A copy a live event
 * already replaced is no longer the optimistic object and is left alone.
 */
export const withoutEchoedOptimisticRecords = (
  state: DirectoryStore,
  sessionID: string,
  page: FetchedPage,
  optimistic: ReadonlyMap<string, OptimisticItem>,
): DirectoryStore => {
  const messages = state.message[sessionID]
  if (!messages || optimistic.size === 0) return state
  const pageIDs = new Set(page.session.map((message) => message.id))
  const kept = messages.filter((message) => (
    !pageIDs.has(message.id) || optimistic.get(message.id)?.message !== message
  ))
  return kept.length === messages.length ? state : { ...state, message: { ...state.message, [sessionID]: kept } }
}
