import type { SkillMentions } from "@/lib/opencode/client"
import type { NativeAgentModel } from "@/lib/native-agents/combinations"
import type { Metadata } from "@/lib/opencode/model"
import type { QueuedMessageGoal } from "@/stores/messageQueueStore"
import type { InputHistorySubmission } from "@/stores/useInputHistoryStore"
import type { NewSessionDraftState } from "./session-ui-store"

export type SentMessage = { route: 'command' | 'prompt' | 'shell'; sessionId: string }

type CapturedSendTarget = {
  runtimeKey: string
  sessionId: string
  directory: string
}

export type SendProgress = {
  sessionMinted?: (sessionId: string, chatDirectory: string | null) => void
  messageMinted?: (messageId: string) => void
  requestLeaving?: () => void
}

export type SendMessageOptions = {
  userInitiated?: boolean
  target?: CapturedSendTarget
  sessionId?: string
  directory?: string
  historySubmissions?: InputHistorySubmission[]
  draftSnapshot?: NewSessionDraftState
  delivery?: 'steer' | 'queue'
  messageId?: string
  subagentModel?: NativeAgentModel | null
  preserveModelSelection?: boolean
  interruptAntigravity?: boolean
  expectedNativeSource?: string
  expectedRuntime?: { runtimeKey: string; generation: number }
  onSessionMaterialized?: (sessionId: string, directory: string | null) => void
  skills?: SkillMentions
  metadata?: Metadata
  onSent?: (sent: SentMessage) => void
  queuedGoal?: QueuedMessageGoal | null
  recordEffort?: boolean
  effortRevision?: number
  progress?: SendProgress
}
