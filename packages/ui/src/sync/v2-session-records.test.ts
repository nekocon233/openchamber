import { describe, expect, test } from 'bun:test';
import type { SessionMessage } from '@opencode-ai/sdk/v2/client';
import { convertSessionNextMessages } from './v2-session-records';

describe('convertSessionNextMessages', () => {
  test('converts projected V2 user and assistant messages into legacy records', () => {
    const records = convertSessionNextMessages({
      sessionID: 'session-1',
      directory: '/repo',
      messages: [
        {
          id: 'msg-user',
          type: 'user',
          text: 'run tests',
          files: [{ uri: 'file:///repo/test.ts', mime: 'text/plain', name: 'test.ts' }],
          time: { created: 1000 },
        },
        {
          id: 'msg-assistant',
          type: 'assistant',
          agent: 'build',
          model: { id: 'model-a', providerID: 'provider-a', variant: 'high' },
          time: { created: 1100, completed: 1200 },
          finish: 'stop',
          cost: 0.01,
          tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
          content: [
            { type: 'text', id: 'text-1', text: 'Done' },
            { type: 'reasoning', id: 'reasoning-1', text: 'thought', time: { created: 1110, completed: 1120 } },
            {
              type: 'tool',
              id: 'call-1',
              name: 'bash',
              state: {
                status: 'completed',
                input: { command: 'bun test' },
                structured: { title: 'Run tests' },
                content: [{ type: 'text', text: 'ok' }],
              },
              time: { created: 1130, ran: 1140, completed: 1150 },
            },
          ],
        } satisfies Extract<SessionMessage, { type: 'assistant' }>,
      ] as SessionMessage[],
    });

    expect(records).toHaveLength(2);
    expect(records[0].info.role).toBe('user');
    expect(records[0].parts.map((part) => part.type)).toEqual(['text', 'file']);
    expect(records[1].info.role).toBe('assistant');
    if (records[1].info.role !== 'assistant') throw new Error('expected assistant');
    expect(records[1].info.parentID).toBe('msg-user');
    expect(records[1].info.providerID).toBe('provider-a');
    expect(records[1].parts.map((part) => part.type)).toEqual(['text', 'reasoning', 'tool']);
    const tool = records[1].parts[2];
    if (tool.type !== 'tool') throw new Error('expected tool');
    expect(tool.state.status).toBe('completed');
    if (tool.state.status !== 'completed') throw new Error('expected completed tool');
    expect(tool.state.output).toBe('ok');
  });
});
