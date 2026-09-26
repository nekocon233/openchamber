import { opencodeClient } from '@/lib/opencode/client';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type Session } from "@/lib/opencode/model"

import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { NativePromptRequest, NativeSessionPatch } from '@/lib/api/types';
import { createTestNativeAgentsAPI, createTestRuntimeAPIs } from '@/lib/native-agents/test-utils/runtime';
import { useAutoReviewStore } from '@/stores/useAutoReviewStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { ChildStoreManager } from '@/sync/child-store';
import { useSelectionStore } from '@/sync/selection-store';
import { setActionRefs, setOptimisticRefs } from '@/sync/session-actions';
import { sendReviewFeedbackToOriginal, startReviewFlow } from './reviewFlow';

const originalGetSession = opencodeClient.getSession;
const DIRECTORY = '/work/project';
const ORIGINAL = 'ncl_f1033b7a-88c5-4b77-bbec-6d63ec3a1188';
const CLAUDE_REVIEW = 'ncl_2b0e1c52-2f1f-4c3a-9d8e-0a7b6c5d4e3f';
const CODEX_REVIEW = 'ncx_01a0d2a6-b55b-7162-a837-c62053537e00';

const nativeSession = (id: string, patch: Partial<Session> = {}): Session => ({
  id,
  projectID: '',
  directory: DIRECTORY,
  title: 'Work',
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
  ...patch,
});

// The native server's sessions, as the fake answers for them.
let stored = new Map<string, Session>();
let created: Array<{ backend: string; title?: string }> = [];
let updates: Array<{ sessionId: string; patch: NativeSessionPatch }> = [];
let prompts: Array<{ sessionId: string; request: NativePromptRequest }> = [];
let openCodeRequests: string[] = [];
let childStores = new ChildStoreManager();
const realFetch = globalThis.fetch;

beforeEach(() => {
  stored = new Map([[ORIGINAL, nativeSession(ORIGINAL)]]);
  created = [];
  updates = [];
  prompts = [];
  openCodeRequests = [];
  childStores = new ChildStoreManager();
  childStores.ensureChild(DIRECTORY, { bootstrap: false });
  registerRuntimeAPIs(createTestRuntimeAPIs(createTestNativeAgentsAPI({
    getSession: async (sessionId) => {
      const session = stored.get(sessionId);
      if (!session) throw new Error(`no session ${sessionId}`);
      return session;
    },
    createSession: async (request) => {
      created.push({ backend: request.backend, title: request.title });
      const session = nativeSession(request.backend === 'codex' ? CODEX_REVIEW : CLAUDE_REVIEW, { title: request.title ?? 'New' });
      stored.set(session.id, session);
      return session;
    },
    updateSession: async (sessionId, _directory, patch) => {
      updates.push({ sessionId, patch });
      const current = stored.get(sessionId) ?? nativeSession(sessionId);
      const next = { ...current, metadata: patch.metadata ?? current.metadata };
      stored.set(sessionId, next);
      return next;
    },
    prompt: async (sessionId, request) => {
      prompts.push({ sessionId, request });
    },
  })));
  // Native sessions must never reach OpenCode; any request is recorded and refused.
  opencodeClient.getSession = async (sessionId) => {
    openCodeRequests.push(sessionId)
    throw new Error('OpenCode must not be asked about a native session')
  }
  setActionRefs(childStores, () => DIRECTORY);
  setOptimisticRefs(() => {}, () => {});
  useConfigStore.setState({ isConnected: true });
  // Magic prompt overrides cannot be read here, so the built-in templates apply.
  globalThis.fetch = Object.assign(async () => Response.json({ error: 'not expected' }, { status: 500 }), { preconnect: () => undefined });
});

afterEach(() => {
  opencodeClient.getSession = originalGetSession;
  useAutoReviewStore.getState().stopRun(ORIGINAL);
  globalThis.fetch = realFetch;
  registerRuntimeAPIs(null);
  childStores.disposeAll();
});

describe('review flow for native sessions', () => {
  test("a CLI's model reviews in that CLI's own session, linked both ways, with the loop's rules as instructions", async () => {
    await startReviewFlow({
      originalSessionID: ORIGINAL,
      directory: DIRECTORY,
      providerID: 'codex-native',
      modelID: 'gpt-5.5',
      agent: 'general',
      variant: 'low',
      generateHandoff: false,
      autoReview: true,
    });

    expect(created).toEqual([{ backend: 'codex', title: 'Review: Work' }]);
    expect(updates).toEqual([
      { sessionId: CODEX_REVIEW, patch: { metadata: { openchamber: { kind: 'review', originalSessionID: ORIGINAL } } } },
      { sessionId: ORIGINAL, patch: { metadata: { openchamber: { reviewSessionID: CODEX_REVIEW } } } },
    ]);
    expect(prompts).toHaveLength(1);
    const [{ sessionId, request }] = prompts;
    expect(sessionId).toBe(CODEX_REVIEW);
    expect(request.messageID.startsWith('ncx_u_')).toBe(true);
    expect(request.model).toEqual({ providerID: 'codex-native', modelID: 'gpt-5.5' });
    expect(request.variant).toBe('low');
    expect(request.agent).toBe('build');
    expect(request.parts).toHaveLength(1);
    expect(request.instructions).toContain('FINAL_REVIEW_STATUS: no_remaining_findings');
    expect(openCodeRequests).toEqual([]);
  });

  test('a review session reuses its CLI for a model of that CLI and gives way to a new one for another', async () => {
    stored.set(CLAUDE_REVIEW, nativeSession(CLAUDE_REVIEW, { metadata: { openchamber: { kind: 'review', originalSessionID: ORIGINAL } } }));
    stored.set(ORIGINAL, nativeSession(ORIGINAL, { metadata: { openchamber: { reviewSessionID: CLAUDE_REVIEW } } }));

    await startReviewFlow({ originalSessionID: ORIGINAL, directory: DIRECTORY, providerID: 'claude-native', modelID: 'opus', generateHandoff: false });
    expect(created).toEqual([]);
    expect(prompts.map((prompt) => prompt.sessionId)).toEqual([CLAUDE_REVIEW]);

    await startReviewFlow({ originalSessionID: ORIGINAL, directory: DIRECTORY, providerID: 'codex-native', modelID: 'gpt-5.5', generateHandoff: false });
    expect(created).toEqual([{ backend: 'codex', title: 'Review: Work' }]);
    expect(prompts.map((prompt) => prompt.sessionId)).toEqual([CLAUDE_REVIEW, CODEX_REVIEW]);
    expect(stored.get(ORIGINAL)?.metadata).toEqual({ openchamber: { reviewSessionID: CODEX_REVIEW } });
    expect(openCodeRequests).toEqual([]);
  });

  test("review feedback reaches a native original session through its CLI, on the session's own model", async () => {
    stored.set(CLAUDE_REVIEW, nativeSession(CLAUDE_REVIEW, { metadata: { openchamber: { kind: 'review', originalSessionID: ORIGINAL } } }));
    useSelectionStore.getState().saveSessionModelSelection(ORIGINAL, 'claude-native', 'opus');

    const sentMessageID = await sendReviewFeedbackToOriginal(CLAUDE_REVIEW, DIRECTORY, 'Check the null case in parse().');

    expect(prompts).toHaveLength(1);
    const [{ sessionId, request }] = prompts;
    expect(sessionId).toBe(ORIGINAL);
    expect(request.messageID).toBe(sentMessageID);
    expect(request.model).toEqual({ providerID: 'claude-native', modelID: 'opus' });
    expect(request.parts[0]).toMatchObject({ type: 'text' });
    expect(JSON.stringify(request.parts)).toContain('Check the null case in parse().');
    expect(request.instructions).toBeUndefined();
    expect(openCodeRequests).toEqual([]);
  });
});
