import type { ContextPartMetadata } from "@/lib/messages/contextParts";
import type { Metadata, Session } from "@/lib/opencode/model";
import { opencodeClient, type SkillMentions } from "@/lib/opencode/client";
import { buildSkillMentionInstruction } from "@/lib/skillMentionInstruction";
import { filesForModel } from "./text-model-images";
import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore";
import { selectCommandsForDirectory, useCommandsStore } from "@/stores/useCommandsStore";
import { useSkillsStore, selectAvailableSkillsForDirectory } from "@/stores/useSkillsStore";
import { normalizePath } from "@/lib/pathNormalization";
import { getSyncSessions, getAllSyncSessions, getSyncSessionDirectory } from "./sync-refs";
import { resolveCheckedSendSelection } from "./session-selection";
import { optimisticSend, commitStagedRevert, commitSessionRevert, waitForPendingRevert } from "./session-actions";
import { getRuntimeEndpointGeneration, getRuntimeKey, RuntimeContextChangedError } from "@/lib/runtime-switch";
import type { NativeAgentModel } from "@/lib/native-agents/combinations";
import { nativePromptRequest, nativeSendMessageId, sendNativePrompt } from "./native-send";
import { getRegisteredRuntimeAPIs } from "@/contexts/runtimeAPIRegistry";
import { NativeAgentsUnsupportedError } from "@/lib/native-agents/errors";
import { isNativeSessionId } from "@/lib/native-agents/ids";

export type ExpectedRuntimeContext = { runtimeKey: string; generation: number }

export const assertExpectedRuntimeContext = (expected?: ExpectedRuntimeContext): void => {
  if (
    expected
    && (
      getRuntimeKey() !== expected.runtimeKey
      || getRuntimeEndpointGeneration() !== expected.generation
    )
  ) throw new RuntimeContextChangedError()
}

export async function routeMessage(params: {
  runtimeKey?: string
  sessionId: string
  directory?: string | null
  content: string
  providerID: string
  modelID: string
  agent?: string
  agentMentionName?: string
  variant?: string | null
  inputMode?: "normal" | "shell"
  files?: Array<{ type: "file"; mime: string; url: string; filename: string }>
  additionalParts?: Array<{ text: string; synthetic?: boolean; metadata?: ContextPartMetadata; files?: Array<{ type: "file"; mime: string; url: string; filename: string }>; systemContext?: 'session-knowledge' | 'feature-instructions' }>
  appendSubmissions?: () => void
  delivery?: 'steer' | 'queue'
  preserveModelSelection?: boolean
  interruptAntigravity?: boolean
  expectedNativeSource?: string
  subagentModel?: NativeAgentModel | null
  messageId?: string
  expectedRuntime?: ExpectedRuntimeContext
  skills?: SkillMentions
  metadata?: Metadata
  sessionKnowledge?: Promise<string | void>
  ready?: Promise<unknown>;
  beforeSend?: () => void;
  onMessageMinted?: (messageId: string) => void;
  markBusy?: boolean
}): Promise<'command' | 'prompt' | 'shell'> {
  const requestRuntimeKey = params.runtimeKey ?? params.expectedRuntime?.runtimeKey
  const assertRuntimeCurrent = () => {
    assertExpectedRuntimeContext(params.expectedRuntime)
    if (requestRuntimeKey !== undefined && requestRuntimeKey !== getRuntimeKey()) {
      throw new Error("Message was not sent because the runtime changed.")
    }
  }
  assertRuntimeCurrent()
  if (params.delivery === 'queue') throw new Error('Queue delivery must be handled by the OpenChamber follow-up queue')
  if (isNativeSessionId(params.sessionId)) return routeNativeMessage(params)
  const requestDirectory = params.directory ?? undefined
  const sendDirectory = () => getAuthoritativeSessionDirectory(params.sessionId) ?? requestDirectory
  const sendSelection = () => resolveCheckedSendSelection(params.sessionId, sendDirectory(), {
    providerID: params.providerID,
    modelID: params.modelID,
    variant: params.variant,
    agent: params.agent,
  })
  const contextItems = (params.additionalParts ?? [])
    .filter((part) => part.text.trim().length > 0)
    .map((part) => ({ text: part.text, metadata: part.metadata }))
  const skillInstructionContext = (): Array<{ text: string }> => {
    const text = params.skills?.names.length ? params.skills.instructionFor(params.skills.names) : null
    return text ? [{ text }] : []
  }
  if (params.inputMode === "shell") {
    await params.ready
    assertRuntimeCurrent()
    params.beforeSend?.()
    await commitStagedRevert(params.sessionId, sendDirectory())
    await opencodeClient.shellSession({
      runtimeKey: requestRuntimeKey,
      sessionId: params.sessionId,
      directory: sendDirectory(),
      command: params.content,
    })
    return 'shell'
  }

  const sendFiles = await filesForModel(params, [...(params.files ?? []), ...(params.additionalParts ?? []).flatMap((part) => part.files ?? [])], requestDirectory)

  let skills = params.skills
  if (params.content.startsWith("/")) {
    const [head, ...tail] = params.content.split(" ")
    const cmdName = head.slice(1)

    let matchedCommand = selectCommandsForDirectory(useCommandsStore.getState(), requestDirectory)
      .find((c) => c.name === cmdName)
    let matchedSkill = selectAvailableSkillsForDirectory(useSkillsStore.getState(), requestDirectory)
      .find((s) => s.name === cmdName)

    if (!matchedCommand && !matchedSkill) {
      const [liveCommands, skillsLoaded] = await Promise.all([
        opencodeClient.listCommands(requestDirectory),
        useSkillsStore.getState().loadSkills(requestDirectory),
      ])
      matchedCommand = liveCommands.find((c) => c.name === cmdName)
      if (!matchedCommand) {
        if (!skillsLoaded) {
          throw new Error(`Could not load skills to resolve /${cmdName}`)
        }
        matchedSkill = selectAvailableSkillsForDirectory(useSkillsStore.getState(), requestDirectory)
          .find((s) => s.name === cmdName)
      }
    }

    if (matchedCommand) {
      await params.ready
      assertRuntimeCurrent()
      await waitForPendingRevert(params.sessionId, sendDirectory())
      assertRuntimeCurrent()
      params.appendSubmissions?.()
      const knowledge = await params.sessionKnowledge
      assertRuntimeCurrent()
      const commandContext = [...(knowledge ? [{ text: knowledge }] : []), ...contextItems, ...skillInstructionContext()]
      const selection = await sendSelection()
      const revertStaged = getSyncSessions(sendDirectory()).some((session) => session.id === params.sessionId && session.revert)
      await opencodeClient.sendCommand({
      runtimeKey: requestRuntimeKey,
      id: params.sessionId,
      model: selection.model,
      agent: selection.agent,
      command: cmdName,
      arguments: tail.join(" "),
      files: sendFiles,
      context: commandContext.length > 0 ? commandContext : undefined,
      delivery: params.delivery,
      directory: sendDirectory(),
      beforeSend: params.beforeSend,
      commitRevert: revertStaged ? () => commitSessionRevert(params.sessionId, sendDirectory()) : undefined,
    })
      return 'command'
    }

    if (matchedSkill) {
      skills = {
        names: [...new Set([matchedSkill.name, ...(params.skills?.names ?? [])])],
        instructionFor: params.skills?.instructionFor ?? buildSkillMentionInstruction,
      }
    }
  }

  await optimisticSend({
    messageId: params.messageId,
    expectedRuntime: params.expectedRuntime,
    runtimeKey: requestRuntimeKey,
    sessionId: params.sessionId,
    content: params.content,
    directory: requestDirectory,
    files: sendFiles,
    context: contextItems,
    ready: params.ready,
    leadingContext: params.sessionKnowledge?.then((text) => text ? { text } : null),
    markBusy: params.markBusy,
    appendSubmissions: params.appendSubmissions,
    onOptimisticInsert: params.onMessageMinted,
    send: async (messageID, context, commitRevert) => {
      assertRuntimeCurrent()
      const selection = await sendSelection()
      return opencodeClient.sendMessage({
        runtimeKey: requestRuntimeKey,
        id: params.sessionId,
        providerID: params.providerID,
        model: selection.model,
        agent: selection.agent,
        text: params.content,
        agentMentions: params.agentMentionName ? [{ name: params.agentMentionName }] : undefined,
        files: sendFiles,
        context: context.length > 0 ? context : undefined,
        metadata: params.metadata,
        delivery: params.delivery,
        messageId: messageID,
        directory: sendDirectory(),
        skills,
        beforeSend: params.beforeSend,
        commitRevert,
      }).then(() => {})
    },
  })
  return 'prompt'
}

async function routeNativeMessage(params: Parameters<typeof routeMessage>[0]): Promise<'prompt'> {
  if (params.inputMode === "shell") throw new Error("Shell mode is not available in native CLI sessions")
  const nativeAgents = getRegisteredRuntimeAPIs()?.nativeAgents
  if (!nativeAgents?.supported) throw new NativeAgentsUnsupportedError()
  const directory = params.directory
  if (!directory) throw new Error("The native session's directory is unknown")
  await optimisticSend({
    runtimeKey: params.runtimeKey ?? params.expectedRuntime?.runtimeKey,
    sessionId: params.sessionId,
    content: params.content,
    providerID: params.providerID,
    modelID: params.modelID,
    agent: params.agent,
    directory,
    files: params.files,
    appendSubmissions: params.appendSubmissions,
    messageId: nativeSendMessageId(params.sessionId, params.messageId),
    expectedRuntime: params.expectedRuntime,
    ready: params.ready,
    onOptimisticInsert: params.onMessageMinted,
    send: (messageID) => {
      assertExpectedRuntimeContext(params.expectedRuntime)
      params.beforeSend?.()
      return sendNativePrompt(nativeAgents, params.sessionId, nativePromptRequest({
      directory,
      messageID,
      content: params.content,
      files: params.files,
      additionalParts: params.additionalParts,
      providerID: params.providerID,
      modelID: params.modelID,
      // A recorded null is an explicit "Default", which the CLI request leaves unset.
      variant: params.variant ?? undefined,
      agent: params.agent,
      preserveSelection: params.preserveModelSelection,
      subagentModel: params.subagentModel,
    }), params.interruptAntigravity, params.expectedNativeSource)
    },
  })
  return 'prompt'
}

export const resolveDirectoryKey = (session: Session): string | null => {
  const sessionRecord = session as Session & {
    directory?: string | null
    project?: { worktree?: string | null } | null
  }
  return normalizePath(sessionRecord.directory ?? null)
    ?? normalizePath(sessionRecord.project?.worktree ?? null)
}

export const getAuthoritativeSessionDirectory = (sessionId: string): string | null => {
  const target = getAllSyncSessions().find((s) => s.id === sessionId)
  const recordDirectory = target ? resolveDirectoryKey(target) : null
  if (recordDirectory) return normalizePath(recordDirectory)
  const globalSession = useGlobalSessionsStore.getState().entityById.get(sessionId)
  const globalDirectory = normalizePath(globalSession?.directory)
  if (globalDirectory) return globalDirectory
  const owningDirectory = getSyncSessionDirectory(sessionId)
  return owningDirectory ? normalizePath(owningDirectory) : null
}
