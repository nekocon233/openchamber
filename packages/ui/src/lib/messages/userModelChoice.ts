import type { Message, Part } from '@/lib/opencode/model';
import { NATIVE_PROVIDER_CLAUDE, isNativeProviderId } from '@/lib/native-agents/ids';

type UserModelChoice = {
  id: string
  agent?: string
  providerID?: string
  modelID?: string
  variant?: string
}

/**
 * The agent/model a turn actually ran on.
 *
 * OpenCode v2 user messages carry no model: the server records the choice on
 * the assistant reply, so the reply is the authority for what the composer
 * should show.
 */
export const extractAssistantModelChoice = (message: Message): UserModelChoice | null => {
  if (message.role !== 'assistant') {
    return null
  }
  return {
    id: message.id,
    agent: message.agent.trim() || undefined,
    providerID: message.providerID.trim() || undefined,
    modelID: message.modelID.trim() || undefined,
    variant: message.variant?.trim() || undefined,
  }
}

/**
 * Find the latest turn's model/agent choice.
 *
 * Messages whose parts have not been loaded yet are skipped so an incomplete
 * snapshot cannot be treated as authoritative.
 */
export const extractUserModelChoice = (message: Message): UserModelChoice | null => {
  if (message.role !== 'user' || !message.model) return null
  return { id: message.id, agent: message.agent, providerID: message.model.providerID, modelID: message.model.modelID, variant: message.model.variant }
}

export const findLatestUserModelChoice = (
  messages: readonly Message[],
  getParts: (messageId: string) => Part[] | undefined,
): UserModelChoice | null => {
  let approvedPlanParent: string | undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === 'assistant' && isNativeProviderId(message.providerID)) {
      if (message.providerID === NATIVE_PROVIDER_CLAUDE && approvedPlanParent === undefined
        && getParts(message.id)?.some((part) => part.type === 'tool' && part.tool === 'plan_exit' && part.state.status === 'completed')) {
        approvedPlanParent = message.parentID
      }
      continue
    }
    const nativePrompt = message.role === 'user' && message.model && isNativeProviderId(message.model.providerID)
    if (!nativePrompt && message.role !== 'assistant') continue
    if (!getParts(message.id)?.length) continue
    const choice = nativePrompt ? extractUserModelChoice(message) : extractAssistantModelChoice(message)
    return choice?.providerID === NATIVE_PROVIDER_CLAUDE && choice.agent === 'plan' && approvedPlanParent === message.id
      ? { ...choice, agent: 'build' }
      : choice
  }
  return null
}

/**
 * When the user has a manual session model override, historical user-message
 * metadata must not overwrite it. After a real send the selection store is
 * updated to match the message, so a conflict means the picker was changed
 * after the last prompt — keep the override.
 */
export const shouldPreserveManualModelOverride = ({
  selectionSource,
  savedSessionModel,
  candidate,
}: {
  selectionSource: 'auto' | 'manual' | undefined
  savedSessionModel: { providerId: string; modelId: string } | null | undefined
  candidate: Pick<UserModelChoice, 'providerID' | 'modelID'> | null | undefined
}): boolean => {
  if (selectionSource !== 'manual' || !savedSessionModel?.providerId || !savedSessionModel.modelId) {
    return false
  }
  if (!candidate?.providerID || !candidate.modelID) {
    return true
  }
  return savedSessionModel.providerId !== candidate.providerID
    || savedSessionModel.modelId !== candidate.modelID
}
