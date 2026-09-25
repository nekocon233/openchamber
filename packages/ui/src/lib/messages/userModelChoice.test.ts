import { describe, expect, test } from 'bun:test'
import type { Message, Part } from '@opencode-ai/sdk/v2'

import {
  extractUserModelChoice,
  findLatestUserModelChoice,
  shouldPreserveManualModelOverride,
} from './userModelChoice'

const userMessage = (
  id: string,
  model: { providerID: string; modelID: string },
  agent = 'custom-agent',
): Message => ({
  id,
  sessionID: 'ses_1',
  role: 'user',
  time: { created: 1 },
  agent,
  model,
} as Message)

const assistantMessage = (id: string): Message => ({
  id,
  sessionID: 'ses_1',
  role: 'assistant',
  time: { created: 2 },
  parentID: 'u1',
  modelID: 'model-a',
  providerID: 'provider',
} as Message)

const textPart = (id: string, text: string, synthetic = false): Part => ({
  id,
  sessionID: 'ses_1',
  messageID: 'u1',
  type: 'text',
  text,
  ...(synthetic ? { synthetic: true } : {}),
} as Part)

describe('findLatestUserModelChoice', () => {
  const nativeAssistant = (parentID = 'u1'): Message => ({
    id: 'a-plan', sessionID: 'ses_1', role: 'assistant', time: { created: 2 }, parentID,
    providerID: 'claude-native', modelID: 'opus', agent: 'plan', mode: 'plan',
    path: { cwd: '/work/project', root: '/work/project' }, cost: 0,
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
    const choice = findLatestUserModelChoice(messages, (id) => id === 'u1' ? [textPart('p-user', 'Plan a fix')] : [planTool('completed')])
    expect(choice).toEqual({ id: 'u1', agent: 'build', providerID: 'claude-native', modelID: 'opus', variant: undefined })
  })

  const unfinishedStatuses: Array<'running' | 'error'> = ['running', 'error']
  for (const status of unfinishedStatuses) {
    test(`keeps plan mode for a ${status} plan exit`, () => {
      const messages = [userMessage('u1', { providerID: 'claude-native', modelID: 'opus' }, 'plan'), nativeAssistant()]
      expect(findLatestUserModelChoice(messages, (id) => id === 'u1' ? [textPart('p-user', 'Plan')] : [planTool(status)])?.agent).toBe('plan')
    })
  }

  test('does not use a plan exit belonging to another prompt', () => {
    const messages = [userMessage('u1', { providerID: 'claude-native', modelID: 'opus' }, 'plan'), nativeAssistant('another-prompt')]
    expect(findLatestUserModelChoice(messages, (id) => id === 'u1' ? [textPart('p-user', 'Plan')] : [planTool('completed')])?.agent).toBe('plan')
  })

  test('a later prompt can explicitly select plan again', () => {
    const messages = [
      userMessage('u1', { providerID: 'claude-native', modelID: 'opus' }, 'plan'), nativeAssistant(),
      userMessage('u2', { providerID: 'claude-native', modelID: 'opus' }, 'plan'),
    ]
    expect(findLatestUserModelChoice(messages, (id) => id === 'a-plan' ? [planTool('completed')] : [textPart('p-' + id, 'Plan')])?.agent).toBe('plan')
  })

  test('does not read assistant parts for other providers', () => {
    const reads: string[] = []
    const messages = [userMessage('u1', { providerID: 'provider', modelID: 'model-a' }, 'plan'), assistantMessage('a1')]
    expect(findLatestUserModelChoice(messages, (id) => {
      reads.push(id)
      return [textPart('p-user', 'Plan')]
    })?.agent).toBe('plan')
    expect(reads).toEqual(['u1'])
  })

  test('returns the latest real user prompt model', () => {
    const messages = [
      userMessage('u1', { providerID: 'provider', modelID: 'model-a' }),
      assistantMessage('a1'),
      userMessage('u2', { providerID: 'provider', modelID: 'model-b' }),
    ]
    const partsById: Record<string, Part[]> = {
      u1: [textPart('p1', 'first')],
      u2: [textPart('p2', 'second')],
    }

    const choice = findLatestUserModelChoice(messages, (id) => partsById[id])
    expect(choice?.id).toBe('u2')
    expect(choice?.modelID).toBe('model-b')
    expect(choice?.providerID).toBe('provider')
    expect(choice?.agent).toBe('custom-agent')
  })

  test('[issue-2404] skips synthetic subagent-completion nudges so manual override is not clobbered', () => {
    // Real prompt sent with the manual override (model-b).
    const realPrompt = userMessage('u-real', { providerID: 'provider', modelID: 'model-b' })
    // After a delegated child session goes idle, OpenCode injects a synthetic
    // user nudge that often carries the agent default model (model-a).
    const syntheticNudge = userMessage('u-nudge', { providerID: 'provider', modelID: 'model-a' })
    const messages = [realPrompt, assistantMessage('a1'), syntheticNudge]
    const partsById: Record<string, Part[]> = {
      'u-real': [textPart('p-real', 'please investigate', false)],
      'u-nudge': [textPart('p-nudge', 'Subagent finished.', true)],
    }

    const choice = findLatestUserModelChoice(messages, (id) => partsById[id])
    expect(choice?.id).toBe('u-real')
    expect(choice?.modelID).toBe('model-b')
  })

  test('skips user messages whose parts have not loaded yet', () => {
    const messages = [
      userMessage('u1', { providerID: 'provider', modelID: 'model-a' }),
      userMessage('u2', { providerID: 'provider', modelID: 'model-b' }),
    ]
    const partsById: Record<string, Part[]> = {
      u1: [textPart('p1', 'first')],
      // u2 parts missing
    }

    const choice = findLatestUserModelChoice(messages, (id) => partsById[id])
    expect(choice?.id).toBe('u1')
    expect(choice?.modelID).toBe('model-a')
  })

  test('returns null when only synthetic user messages exist', () => {
    const messages = [userMessage('u-nudge', { providerID: 'provider', modelID: 'model-a' })]
    const partsById: Record<string, Part[]> = {
      'u-nudge': [textPart('p-nudge', 'Subagent finished.', true)],
    }

    expect(findLatestUserModelChoice(messages, (id) => partsById[id])).toBeNull()
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

describe('extractUserModelChoice', () => {
  test('reads variant from model.variant', () => {
    const message = {
      ...userMessage('u1', { providerID: 'provider', modelID: 'model-b' }),
      model: { providerID: 'provider', modelID: 'model-b', variant: 'high' },
    } as Message
    expect(extractUserModelChoice(message as never)?.variant).toBe('high')
  })
})
