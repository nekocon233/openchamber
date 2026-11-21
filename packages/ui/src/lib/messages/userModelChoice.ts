import type { Message, Part, Session } from '@/lib/opencode/model'
import { NATIVE_PROVIDER_CLAUDE, isNativeProviderId } from '@/lib/native-agents/ids';

export type UserModelChoice = {
  id: string
  agent?: string
  providerID?: string
  modelID?: string
  variant?: string
}

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

const extractUserModelChoice = (message: Message): UserModelChoice | null => {
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

export const extractSessionRecordModelChoice = (session: Session | undefined): UserModelChoice | null => {
  const model = session?.model
  if (!session || !model?.providerID || !model.id) return null
  return {
    id: `session:${session.id}`,
    agent: undefined,
    providerID: model.providerID,
    modelID: model.id,
    variant: model.variant?.trim() || undefined,
  }
}

export const areModelChoicesEqual = (left: UserModelChoice | null, right: UserModelChoice | null): boolean => {
  if (left === right) return true
  if (!left || !right) return false
  return left.id === right.id
    && left.agent === right.agent
    && left.providerID === right.providerID
    && left.modelID === right.modelID
    && left.variant === right.variant
}

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
