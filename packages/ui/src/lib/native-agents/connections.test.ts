import { describe, expect, test } from 'bun:test';
import { claudeConnectionSchema, claudeConnectionWriteSchema } from './connections';

const connection = {
  id: 'b14d5c32-287a-4296-81e8-777a8c024eb8', revision: 1, hasKey: true,
  name: 'Gateway', baseURL: 'http://127.0.0.1:8317', auth: 'api-key',
  models: [{
    id: 'f5f76bef-8cf3-4d5e-a8db-a9b49f0dab5c', name: 'Opus 5.5 (agy)', modelID: 'claude-opus-5-5-high',
    contextWindow: 1000000, outputLimit: 128000, input: { image: true, pdf: false }, efforts: ['low', 'high', 'max'],
  }],
};

describe('Claude connection family selection', () => {
  test('preserves the following rule through API reads and an unrelated name edit', () => {
    const read = claudeConnectionSchema.parse({ ...connection, models: [{ ...connection.models[0], followFamily: 'antigravity-opus' }] });
    const write = claudeConnectionWriteSchema.parse({ ...read, name: 'Renamed gateway' });
    expect(write.models[0]).toMatchObject({ id: connection.models[0].id, followFamily: 'antigravity-opus' });
    expect(write.models[0].efforts).toEqual(connection.models[0].efforts);
    expect(write.apiKey).toBeUndefined();
  });

  test('keeps older configurations pinned and rejects unknown following rules', () => {
    expect(claudeConnectionSchema.parse(connection).models[0].followFamily).toBeUndefined();
    expect(claudeConnectionSchema.safeParse({ ...connection, models: [{ ...connection.models[0], followFamily: 'any-latest-model' }] }).success).toBe(false);
  });
});
