import { describe, expect, it } from 'vitest';
import { buildAssistantMessage, buildTextPart, buildToolPart } from '../records.js';
import { antigravityMeasurementsSchema, captureAntigravityMeasurements, restoreAntigravityMeasurements } from './measurements.js';

const record = () => ({
  info: buildAssistantMessage({ id: 'assistant', sessionID: 'session', parentID: 'user', created: 1000, completed: 5000,
    providerID: 'antigravity-native', modelID: 'test', agent: 'plan', cwd: '/repo',
    tokens: { total: 320, input: 100, output: 5, reasoning: 15, cache: { read: 200, write: 0 } } }),
  parts: [
    buildTextPart({ id: 'text', sessionID: 'session', messageID: 'assistant', text: 'Private answer', start: 3000, end: 4000 }),
    buildToolPart({ id: 'tool', sessionID: 'session', messageID: 'assistant', callID: 'call', tool: 'bash', input: { command: 'private command' },
      start: 2000, result: { status: 'completed', output: 'Private output', end: 2500 } }),
  ],
});
const sendsFor = (measurements) => new Map([['user', { messageId: 'user', antigravity: { measurements } }]]);

describe('Antigravity stream measurements', () => {
  it('retains numeric counters and timing without copying conversation or tool content', () => {
    const measurements = captureAntigravityMeasurements([record()], 'user');
    expect(antigravityMeasurementsSchema.parse(JSON.parse(JSON.stringify(measurements)))).toEqual(measurements);
    expect(JSON.stringify(measurements)).not.toContain('Private');
    expect(JSON.stringify(measurements)).not.toContain('private command');
    const history = record();
    history.info.time.completed = 1000;
    history.info.tokens.output = 20;
    history.info.tokens.reasoning = 0;
    history.parts[0].time = { start: 1000, end: 1000 };
    history.parts[1].state.time = { start: 1000, end: 1000 };
    restoreAntigravityMeasurements([history], sendsFor(measurements));
    expect(history.info).toEqual(record().info);
    expect(history.parts).toEqual(record().parts);
  });

  it('does not attach measurements to another prompt, changed usage or changed text', () => {
    const measurements = captureAntigravityMeasurements([record()], 'user');
    const otherTurn = record();
    otherTurn.info.parentID = 'another-user';
    const changedUsage = record();
    changedUsage.info.tokens.input = 101;
    const changedText = record();
    changedText.parts[0].text = 'Native correction';
    changedText.parts[0].time = { start: 1000, end: 1000 };
    const before = structuredClone([otherTurn, changedUsage, changedText]);
    restoreAntigravityMeasurements([otherTurn, changedUsage, changedText], sendsFor(measurements));
    expect([otherTurn, changedUsage, changedText]).toEqual(before);
  });

  it('skips unfinished intervals, empty text, app interactions and unrecorded tool completions', () => {
    const live = record();
    live.parts[0].text = '';
    live.parts[1].state = { status: 'error', input: {}, error: 'Antigravity tool completion was not recorded', time: { start: 2000, end: 2500 } };
    const app = structuredClone(record().parts[1]);
    app.state.metadata = { openchamberToolSource: 'native-interaction' };
    live.parts.push(app);
    expect(captureAntigravityMeasurements([live], 'user').records[0].parts).toEqual([]);
    expect(captureAntigravityMeasurements([record()], 'other').records).toEqual([]);
    expect(antigravityMeasurementsSchema.safeParse({ version: 2, records: [] }).success).toBe(false);
  });
});
