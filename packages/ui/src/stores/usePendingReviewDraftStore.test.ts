import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

test('review drafts restore long retry payloads and refuse capacity without discarding other scopes', async () => {
  const dom = new Window({ url: 'http://localhost' });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.document });
  const fingerprint = JSON.stringify(['a'.repeat(40), { kind: 'comment', body: `Note${'\n'.repeat(55_000)}`, path: 'a.ts', side: 'RIGHT', line: 1 }]);
  const attempt = { signature: fingerprint, fingerprint, key: 'original-request' };
  dom.localStorage.setItem('openchamber-pending-review-drafts', JSON.stringify({ version: 1, state: {
    texts: { 'project-a:summary': '', 'project-b:summary': 'Unsent summary' },
    attempts: { 'project-a': [attempt] },
  } }));
  const { usePendingReviewDraftStore: store } = await import('./usePendingReviewDraftStore');
  try {
    expect(store.getState().texts['project-a:summary']).toBe('');
    expect(store.getState().texts['project-b:summary']).toBe('Unsent summary');
    expect(store.getState().attempts['project-a']).toEqual([attempt]);
    expect(store.getState().setAttempt('project-a', { ...attempt, key: 'replacement-key' })).toBe(true);
    expect(store.getState().attempts['project-a'][0].key).toBe('original-request');
    expect(store.getState().setText('project-c:summary', 'x'.repeat(65_537))).toBe(false);
    expect(store.getState().texts['project-b:summary']).toBe('Unsent summary');
    for (let i = 0; i < 127; i++) expect(store.getState().setAttempt(`project-${i}`, { signature: String(i), fingerprint: '{}', key: String(i) })).toBe(true);
    expect(store.getState().setAttempt('overflow', { signature: 'new', fingerprint: '{}', key: 'new' })).toBe(false);
    expect(store.getState().attempts['project-a']).toEqual([attempt]);
    expect(store.getState().begin('project-a')).toBe(true);
    expect(store.getState().begin('project-a')).toBe(false);
    expect(store.getState().begin('project-b')).toBe(true);
    dom.dispatchEvent(new dom.Event('pagehide'));
    const persisted = JSON.parse(dom.localStorage.getItem('openchamber-pending-review-drafts') ?? 'null');
    expect(persisted.state).not.toHaveProperty('busy');
    expect(persisted.state.attempts['project-a'][0]).toEqual(attempt);
  } finally { dom.happyDOM.cancelAsync(); }
});
