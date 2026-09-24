import type { NativePromptPart, NativePromptRequest } from "@/lib/api/types"
import type { ContextPartMetadata } from "@/lib/messages/contextParts"
import { createNativeUserMessageId, isNativeUserMessageIdFor, nativeBackendOfSessionId } from "@/lib/native-agents/ids"

// A native session receives what the user wrote and attached. OpenChamber's
// own context (pinned knowledge, goal and response-style reminders, skill
// hints) stays out: the CLI brings its own instructions, and its session
// should read the same as one typed in a terminal. A feature that cannot work
// without telling the agent something (the btw boundary) marks that part
// `feature-instructions`; it goes to the CLI as instructions the conversation
// does not show.

type PromptFile = { type: "file"; mime: string; url: string; filename: string }
type AdditionalPart = {
  text: string
  synthetic?: boolean
  metadata?: ContextPartMetadata
  files?: PromptFile[]
  systemContext?: "session-knowledge" | "feature-instructions"
}

/** Prompt parts for a native session; attached context keeps its text and files. */
export const nativePromptParts = (
  content: string,
  files: PromptFile[] | undefined,
  additionalParts: AdditionalPart[] | undefined,
): NativePromptPart[] => {
  const parts: NativePromptPart[] = []
  if (content.length > 0) parts.push({ type: "text", text: content })
  for (const file of files ?? []) parts.push({ type: "file", mime: file.mime, url: file.url, filename: file.filename })
  for (const part of additionalParts ?? []) {
    // Context the user attached carries its metadata; the rest is OpenChamber's.
    if (!part.metadata) continue
    parts.push({ type: "text", text: part.text })
    for (const file of part.files ?? []) parts.push({ type: "file", mime: file.mime, url: file.url, filename: file.filename })
  }
  return parts
}

/** The instructions features send with this prompt, each once; undefined when none does. */
const nativePromptInstructions = (additionalParts: AdditionalPart[] | undefined): string | undefined => {
  const texts = new Set((additionalParts ?? [])
    .filter((part) => part.systemContext === "feature-instructions")
    .map((part) => part.text.trim())
    .filter((text) => text.length > 0))
  return texts.size > 0 ? [...texts].join("\n\n") : undefined
}

/** Native sessions run the build or the plan agent; any other name builds. */
export const nativeAgentOf = (agent: string | undefined): NativePromptRequest["agent"] => (agent === "plan" ? "plan" : "build")

/** The prompt a native session receives for a composer or feature send. */
export const nativePromptRequest = (send: {
  directory: string
  messageID: string
  content: string
  files?: PromptFile[]
  additionalParts?: AdditionalPart[]
  providerID: string
  modelID: string
  variant?: string
  agent?: string
}): NativePromptRequest => ({
  directory: send.directory,
  messageID: send.messageID,
  parts: nativePromptParts(send.content, send.files, send.additionalParts),
  model: { providerID: send.providerID, modelID: send.modelID },
  variant: send.variant,
  agent: nativeAgentOf(send.agent),
  instructions: nativePromptInstructions(send.additionalParts),
})

/**
 * The id of a message sent to a native session: the caller's when the CLI can
 * record it, else a new one.
 */
export const nativeSendMessageId = (sessionId: string, requested: string | undefined): string => {
  const backend = nativeBackendOfSessionId(sessionId)
  if (!backend) throw new Error(`Not a native session: ${sessionId}`)
  return requested !== undefined && isNativeUserMessageIdFor(backend, requested)
    ? requested
    : createNativeUserMessageId(backend)
}

const NATIVE_COMPACT_COMMAND = /^\/compact(?:\s+([\s\S]*?))?\s*$/

/**
 * `/compact` typed in a native session: the CLI's own compaction, which shows
 * as its marker rather than as a message. Claude Code takes the rest of the
 * line as instructions for its summary. Null for any other text.
 */
export const nativeCompactCommand = (text: string): { instructions?: string } | null => {
  const match = NATIVE_COMPACT_COMMAND.exec(text.trim())
  if (!match) return null
  const instructions = match[1]?.trim()
  return instructions ? { instructions } : {}
}

// Commands OpenChamber runs itself in a native session: the ones that act on
// its own view of the session, `/btw`, which asks a fork of it, and
// `/handoff-review`, which opens a review. Every other slash command is the
// CLI's, and goes out as typed.
const NATIVE_LOCAL_COMMANDS = new Set(["undo", "redo", "timeline", "btw", "handoff-review"])

/** Whether the composer runs `/name` itself in a native session. */
export const isNativeLocalCommand = (name: string): boolean => NATIVE_LOCAL_COMMANDS.has(name)
