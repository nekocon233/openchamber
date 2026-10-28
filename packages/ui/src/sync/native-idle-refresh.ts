import { isNativeSessionId } from "@/lib/native-agents/ids"

import { getImperativeSessionMessageLoader } from "./session-message-loader"

// Enough to include a settled turn; refreshTail extends the window when the
// tail does not join the cached transcript.
const NATIVE_IDLE_REFRESH_MESSAGE_LIMIT = 30

/** A settled native turn may have usage or parts the live projection never finished. */
export const refreshNativeHistoryOnIdle = (sessionID: string, directory: string): void => {
  if (!isNativeSessionId(sessionID)) return
  const loader = getImperativeSessionMessageLoader()
  if (!loader?.hasLoaded({ directory, sessionID })) return
  void loader.refreshTail({ directory, sessionID }, NATIVE_IDLE_REFRESH_MESSAGE_LIMIT).catch(() => undefined)
}
