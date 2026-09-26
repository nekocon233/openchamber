import { describe, expect, test } from 'bun:test'
import type { Message, Part } from '@/lib/opencode/model'

import {
  extractAssistantModelChoice,
  findLatestUserModelChoice,
  shouldPreserveManualModelOverride,
} from './userModelChoice'

const userMessage = (id: string, model?: { providerID: string; modelID: string }, agent?: string): Message => ({
  model,
  agent,
  id,
  sessionID: 'ses_1',
  role: 'user',
  time: { created: 1 },
})

const assistantMessage = (id: string, modelID: string, options: { agent?: string; variant?: string } = {}): Message => ({
  id,
  sessionID: 'ses_1',
  role: 'assistant',
  time: { created: 2, completed: 3 },
  agent: options.agent ?? 'custom-agent',
  providerID: 'provider',
  modelID,
  ...(options.variant ? { variant: options.variant } : {}),
})

const textPart = (id: string, messageID: string, text: string): Part => ({
  id,
  sessionID: 'ses_1',
  messageID,
  type: 'text',
  text,
})

describe('findLatestUserModelChoice', () => {
  const nativeAssistant = (parentID = 'u1'): Message => ({
    id: 'a-plan', sessionID: 'ses_1', role: 'assistant', time: { created: 2 }, parentID,
    providerID: 'claude-native', modelID: 'opus', agent: 'plan',
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  const planTool = (status: 'running' | 'completed' | 'error'): Part => ({
    id: 'p-plan', sessionID: 'ses_1', messageID: 'a-plan', type: 'tool', callID: 'exit-plan', tool: 'plan_exit',
    state: status === 'completed'
      ? { status, input: {}, title: 'Plan', metadata: {}, output: 'Plan approved', time: { start: 2, end: 3 } }
      : status === 'error'
        ? { status, input: {}, error: 'Plan rejected', time: { start: 2, end: 3 } }
        : { status, input: {}, time: { start: 2 } },
  })

  test('restores build after a successful Claude plan exit without changing the model', () => {
    const messages = [userMessage('u1', { providerID: 'claude-native', modelID: 'opus' }, 'plan'), nativeAssistant()]
    const choice = findLatestUserModelChoice(messages, (id) => id === 'u1' ? [textPart('p-user', 'u1', 'Plan a fix')] : [planTool('completed')])
    expect(choice).toEqual({ id: 'u1', agent: 'build', providerID: 'claude-native', modelID: 'opus', variant: undefined })
  })

  const unfinishedStatuses: Array<'running' | 'error'> = ['running', 'error']
  for (const status of unfinishedStatuses) {
    test(`keeps plan mode for a ${status} plan exit`, () => {
      const messages = [userMessage('u1', { providerID: 'claude-native', modelID: 'opus' }, 'plan'), nativeAssistant()]
      expect(findLatestUserModelChoice(messages, (id) => id === 'u1' ? [textPart('p-user', 'u1', 'Plan')] : [planTool(status)])?.agent).toBe('plan')
    })
  }

  test('does not use a plan exit belonging to another prompt', () => {
    const messages = [userMessage('u1', { providerID: 'claude-native', modelID: 'opus' }, 'plan'), nativeAssistant('another-prompt')]
    expect(findLatestUserModelChoice(messages, (id) => id === 'u1' ? [textPart('p-user', 'u1', 'Plan')] : [planTool('completed')])?.agent).toBe('plan')
  })

  test('a later prompt can explicitly select plan again', () => {
    const messages = [
      userMessage('u1', { providerID: 'claude-native', modelID: 'opus' }, 'plan'), nativeAssistant(),
      userMessage('u2', { providerID: 'claude-native', modelID: 'opus' }, 'plan'),
    ]
    expect(findLatestUserModelChoice(messages, (id) => id === 'a-plan' ? [planTool('completed')] : [textPart('p-' + id, id, 'Plan')])?.agent).toBe('plan')
  })

  test('returns the model the latest answered turn ran on', () => {
    const messages = [
      userMessage('u1'),
      assistantMessage('a1', 'model-a'),
      userMessage('u2'),
      assistantMessage('a2', 'model-b'),
    ]
    const partsById: Record<string, Part[]> = {
      a1: [textPart('p1', 'a1', 'first')],
      a2: [textPart('p2', 'a2', 'second')],
    }

    const choice = findLatestUserModelChoice(messages, (id) => partsById[id])
    expect(choice?.id).toBe('a2')
    expect(choice?.modelID).toBe('model-b')
    expect(choice?.providerID).toBe('provider')
    expect(choice?.agent).toBe('custom-agent')
  })

  test('skips messages whose parts have not loaded yet', () => {
    const messages = [assistantMessage('a1', 'model-a'), assistantMessage('a2', 'model-b')]
    const partsById: Record<string, Part[]> = {
      a1: [textPart('p1', 'a1', 'first')],
      // a2 parts missing
    }

    const choice = findLatestUserModelChoice(messages, (id) => partsById[id])
    expect(choice?.id).toBe('a1')
    expect(choice?.modelID).toBe('model-a')
  })

  test('returns null when the session has no answered turn', () => {
    expect(findLatestUserModelChoice([userMessage('u1')], () => undefined)).toBeNull()
  })
})

describe('shouldPreserveManualModelOverride', () => {
  test('preserves manual override when it differs from the candidate message model', () => {
    expect(shouldPreserveManualModelOverride({
      selectionSource: 'manual',
      savedSessionModel: { providerId: 'provider', modelId: 'model-b' },
      candidate: { providerID: 'provider', modelID: 'model-a' },
    })).toBe(true)
  })

  test('does not preserve when selection matches the candidate', () => {
    expect(shouldPreserveManualModelOverride({
      selectionSource: 'manual',
      savedSessionModel: { providerId: 'provider', modelId: 'model-b' },
      candidate: { providerID: 'provider', modelID: 'model-b' },
    })).toBe(false)
  })

  test('does not preserve auto selections', () => {
    expect(shouldPreserveManualModelOverride({
      selectionSource: 'auto',
      savedSessionModel: { providerId: 'provider', modelId: 'model-b' },
      candidate: { providerID: 'provider', modelID: 'model-a' },
    })).toBe(false)
  })

  test('preserves manual override when candidate has no model', () => {
    expect(shouldPreserveManualModelOverride({
      selectionSource: 'manual',
      savedSessionModel: { providerId: 'provider', modelId: 'model-b' },
      candidate: { providerID: undefined, modelID: undefined },
    })).toBe(true)
  })
})

describe('extractAssistantModelChoice', () => {
  test('reads the variant off the assistant message', () => {
    expect(extractAssistantModelChoice(assistantMessage('a1', 'model-b', { variant: 'high' }))?.variant).toBe('high')
  })

  test('ignores non-assistant messages', () => {
    expect(extractAssistantModelChoice(userMessage('u1'))).toBeNull()
  })
})
