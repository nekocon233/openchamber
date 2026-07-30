import { describe, expect, test } from 'bun:test';
import type { Event, Message, Part } from '@opencode-ai/sdk/v2/client';
import { createSessionNextTranslator } from './session-next-translator';

const event = (type: string, properties: Record<string, unknown>, id = `${type}-1`): Event => ({
  id,
  type,
  properties,
} as Event);

const promptProperties = {
  timestamp: 1000,
  sessionID: 'session-1',
  messageID: 'msg-1',
  prompt: {
    text: 'queued prompt',
    files: [{ uri: 'file:///repo/note.txt', mime: 'text/plain', name: 'note.txt' }],
  },
  delivery: 'queue',
};

describe('session-next translator', () => {
  test('keeps admission out of the transcript and materializes the user message on promotion', () => {
    const translator = createSessionNextTranslator();

    expect(translator.translate('/repo', event('session.next.prompt.admitted', promptProperties))).toEqual([]);
    const promoted = translator.translate('/repo', event('session.next.prompted', promptProperties, 'prompted-1')) ?? [];

    expect(promoted.map((candidate) => candidate.type)).toEqual([
      'message.updated',
      'message.part.updated',
      'message.part.updated',
    ]);
    const info = (promoted[0].properties as { info: Message }).info;
    expect(info.id).toBe('msg-1');
    expect(info.role).toBe('user');
    expect(info.sessionID).toBe('session-1');
    const parts = promoted.slice(1).map((candidate) => (candidate.properties as { part: Part }).part);
    expect(parts.map((part) => part.type)).toEqual(['text', 'file']);
    expect(parts[0].id).toBe('msg-1:text');
  });

  test('maps assistant lifecycle, streamed text, and final status into legacy events', () => {
    const translator = createSessionNextTranslator();
    translator.translate('/repo', event('session.next.prompted', promptProperties, 'prompted-1'));
    const started = translator.translate('/repo', event('session.next.step.started', {
      timestamp: 1100,
      sessionID: 'session-1',
      assistantMessageID: 'assistant-1',
      agent: 'build',
      model: { id: 'model-a', providerID: 'provider-a', variant: 'high' },
    }, 'step-started-1')) ?? [];

    expect(started.map((candidate) => candidate.type)).toEqual(['message.updated', 'session.status']);
    const assistant = (started[0].properties as { info: Message }).info;
    expect(assistant.id).toBe('assistant-1');
    expect(assistant.role).toBe('assistant');
    if (assistant.role !== 'assistant') throw new Error('expected assistant message');
    expect(assistant.parentID).toBe('msg-1');
    expect(assistant.agent).toBe('build');
    expect(assistant.providerID).toBe('provider-a');
    expect(assistant.modelID).toBe('model-a');
    expect(assistant.variant).toBe('high');

    const textStarted = translator.translate('/repo', event('session.next.text.started', {
      timestamp: 1200,
      sessionID: 'session-1',
      assistantMessageID: 'assistant-1',
      textID: 'text-1',
    }, 'text-started-1')) ?? [];
    expect(textStarted.map((candidate) => candidate.type)).toEqual(['message.part.updated']);

    const delta = translator.translate('/repo', event('session.next.text.delta', {
      timestamp: 1250,
      sessionID: 'session-1',
      assistantMessageID: 'assistant-1',
      textID: 'text-1',
      delta: 'hello',
    }, 'text-delta-1')) ?? [];
    expect(delta.map((candidate) => candidate.type)).toEqual(['message.part.delta']);
    const deltaProperties = delta[0].properties as {
      sessionID: string;
      messageID: string;
      partID: string;
      field: string;
      delta: string;
    };
    expect(deltaProperties.sessionID).toBe('session-1');
    expect(deltaProperties.messageID).toBe('assistant-1');
    expect(deltaProperties.partID).toBe('text-1');
    expect(deltaProperties.field).toBe('text');
    expect(deltaProperties.delta).toBe('hello');

    const ended = translator.translate('/repo', event('session.next.text.ended', {
      timestamp: 1300,
      sessionID: 'session-1',
      assistantMessageID: 'assistant-1',
      textID: 'text-1',
      text: 'hello!',
    }, 'text-ended-1')) ?? [];
    expect(ended.map((candidate) => candidate.type)).toEqual(['message.part.updated']);

    const stepEnded = translator.translate('/repo', event('session.next.step.ended', {
      timestamp: 1400,
      sessionID: 'session-1',
      assistantMessageID: 'assistant-1',
      finish: 'stop',
      cost: 0.01,
      tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
    }, 'step-ended-1')) ?? [];
    expect(stepEnded.map((candidate) => candidate.type)).toEqual(['message.updated']);
  });

  test('maps tool input, execution, progress, and success into one stable tool part', () => {
    const translator = createSessionNextTranslator();
    const base = {
      sessionID: 'session-1',
      assistantMessageID: 'assistant-1',
      callID: 'call-1',
    };

    translator.translate('/repo', event('session.next.tool.input.started', {
      ...base,
      timestamp: 1000,
      name: 'bash',
    }, 'tool-started'));
    translator.translate('/repo', event('session.next.tool.input.delta', {
      ...base,
      timestamp: 1001,
      delta: '{"command":"ls',
    }, 'tool-delta-a'));
    translator.translate('/repo', event('session.next.tool.input.delta', {
      ...base,
      timestamp: 1002,
      delta: '"}',
    }, 'tool-delta-b'));
    translator.translate('/repo', event('session.next.tool.input.ended', {
      ...base,
      timestamp: 1003,
      text: '{"command":"ls"}',
    }, 'tool-input-ended'));
    translator.translate('/repo', event('session.next.tool.called', {
      ...base,
      timestamp: 1004,
      tool: 'bash',
      input: { command: 'ls' },
      provider: { executed: false },
    }, 'tool-called'));
    translator.translate('/repo', event('session.next.tool.progress', {
      ...base,
      timestamp: 1005,
      structured: { title: 'List files' },
      content: [{ type: 'text', text: 'partial' }],
    }, 'tool-progress'));
    const success = translator.translate('/repo', event('session.next.tool.success', {
      ...base,
      timestamp: 1006,
      structured: { title: 'List files' },
      content: [{ type: 'text', text: 'file.txt' }],
      provider: { executed: false },
    }, 'tool-success')) ?? [];

    const part = (success[0].properties as { part: Part }).part;
    expect(part.id).toBe('call-1');
    expect(part.type).toBe('tool');
    if (part.type !== 'tool') throw new Error('expected tool part');
    expect(part.callID).toBe('call-1');
    expect(part.tool).toBe('bash');
    expect(part.state.status).toBe('completed');
    if (part.state.status !== 'completed') throw new Error('expected completed tool');
    expect(part.state.input).toEqual({ command: 'ls' });
    expect(part.state.output).toBe('file.txt');
  });

  test('deduplicates replayed events and does not append deltas after a stream ends', () => {
    const translator = createSessionNextTranslator();
    const started = event('session.next.text.started', {
      timestamp: 1000,
      sessionID: 'session-1',
      assistantMessageID: 'assistant-1',
      textID: 'text-1',
    }, 'same-event');

    expect(translator.translate('/repo', started)).toHaveLength(1);
    expect(translator.translate('/repo', started)).toEqual([]);

    translator.translate('/repo', event('session.next.text.ended', {
      timestamp: 1001,
      sessionID: 'session-1',
      assistantMessageID: 'assistant-1',
      textID: 'text-1',
      text: 'done',
    }, 'ended'));
    expect(translator.translate('/repo', event('session.next.text.delta', {
      timestamp: 1002,
      sessionID: 'session-1',
      assistantMessageID: 'assistant-1',
      textID: 'text-1',
      delta: 'late',
    }, 'late-delta'))).toEqual([]);
  });

  test('passes unsupported session.next events through without swallowing them', () => {
    const translator = createSessionNextTranslator();

    expect(translator.translate('/repo', event('session.next.shell.started', {
      timestamp: 1,
      sessionID: 'session-1',
      messageID: 'shell-1',
      callID: 'call-1',
      command: 'pwd',
    }, 'shell-1'))).toBeNull();
  });
});
