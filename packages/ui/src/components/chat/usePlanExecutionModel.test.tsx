import React, { act } from 'react';
import { describe, expect, spyOn, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { OpenCode } from '@opencode/client';
import { opencodeClient } from '@/lib/opencode/client';
import { nativeSessionSchema } from '@/lib/native-agents/schemas';
import { buildNativeProvider } from '@/lib/native-agents/providers';
import { projectNativeQuestion } from '@/lib/native-agents/forms';
import type { NativePlanExecutionChoice } from '@/lib/api/types';
import type { FormRequest } from '@/lib/opencode/model';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSelectionStore } from '@/sync/selection-store';
import { SyncProvider, useDirectoryStore } from '@/sync/sync-context';
import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { ChatColumnSessionContext } from './chatColumnSession';
import { usePlanExecutionModel, type PlanExecutionModelState } from './usePlanExecutionModel';

const directory = '/fixture/plan-effort';
const descriptor = (id: string, efforts: string[], fast = false) => ({
  id, name: id, efforts, fast, defaultEffort: null, contextWindow: 64000, outputLimit: 8192, input: { image: false, pdf: false },
});
const providers = [
  buildNativeProvider('claude', [descriptor('opus', ['high', 'max'])]),
  buildNativeProvider('codex', [descriptor('gpt-test', ['low', 'high', 'max'], true)]),
  buildNativeProvider('deepseek', [descriptor('ds-test', ['max']), descriptor('plain', [])]),
];
const choice = (providerID: string, modelID: string, variant?: string): NativePlanExecutionChoice => ({ model: { providerID, modelID }, variant });

const withProbe = async (verify: (fixture: {
  state: () => PlanExecutionModelState;
  render: (pending?: NativePlanExecutionChoice, requestId?: string, mountKey?: string) => Promise<void>;
  setExecution: (execution: NativePlanExecutionChoice, revision?: number) => Promise<void>;
}) => Promise<void>) => {
  const dom = installHookTestDom();
  const configBefore = useConfigStore.getState();
  const selectionBefore = useSelectionStore.getState();
  const spies = [
    spyOn(opencodeClient, 'getFilesystemHomeInfo').mockResolvedValue({ home: '/home' }),
    spyOn(opencodeClient, 'getFilesystemHome').mockResolvedValue('/home'),
    spyOn(opencodeClient, 'getLocation').mockResolvedValue({ directory, project: { id: 'project', directory, canonical: directory } }),
    spyOn(opencodeClient, 'getConfig').mockResolvedValue({}),
    spyOn(opencodeClient, 'listProjects').mockResolvedValue([]),
  ];
  const sdk = OpenCode.make({ baseUrl: 'https://plan-effort.test', fetch: async (request) => {
    const pathname = new URL(request instanceof Request ? request.url : request.toString()).pathname;
    return pathname.endsWith('/event') ? new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } })
      : Response.json(pathname.endsWith('/session/active') ? {} : { data: [] });
  } });
  const sessionId = `ncv_${crypto.randomUUID()}`;
  let latest: PlanExecutionModelState | undefined;
  let store: ReturnType<typeof useDirectoryStore> | undefined;
  const root = createRoot(dom.container);
  const firstRequestId = `ncq_${crypto.randomUUID()}`;
  const nativeMetadata = { kind: 'unified', backend: 'claude', sourceSessionID: `ncl_${crypto.randomUUID()}`,
      revision: 3, recordRevision: 3, historyRevision: 0, switchReady: false, preparing: false,
      unifiedBackends: ['claude', 'codex', 'deepseek'], agents: { revision: 1, subagent: null,
        execution: choice('deepseek-native', 'ds-test', 'max') },
  };
  let record = nativeSessionSchema.parse({ id: sessionId, directory, projectID: '', title: 'Plan effort', time: { created: 1, updated: 1 },
    agent: 'plan', model: { providerID: 'claude-native', id: 'opus', variant: 'high' },
    metadata: { openchamber: { native: nativeMetadata } },
  });
  function Probe({ form }: { form: FormRequest }) {
    store = useDirectoryStore(directory, { bootstrap: false });
    latest = usePlanExecutionModel(form, { providerID: 'claude-native', modelID: 'opus', variant: 'high' });
    return null;
  }
  const render = async (pending?: NativePlanExecutionChoice, requestId = firstRequestId, mountKey = 'main') => {
    const form = projectNativeQuestion({ id: requestId, sessionID: sessionId, kind: 'claude-plan-exit', canSelectExecutionModel: true,
      executionPending: pending, questions: [{ header: 'Plan', question: 'Implement the plan', options: [{ label: 'build', description: '' }] }],
    });
    if (!form) throw new Error('Expected an approval form');
    await act(() => root.render(<SyncProvider sdk={sdk} directory=""><ChatColumnSessionContext.Provider value={{ sessionId, directory }}>
      <Probe key={mountKey} form={form} />
    </ChatColumnSessionContext.Provider></SyncProvider>));
  };
  const state = () => {
    if (!latest) throw new Error('Expected the hook to render');
    return latest;
  };
  const setExecution = async (execution: NativePlanExecutionChoice, revision = 3) => {
    record = { ...record, metadata: { openchamber: { native: { ...nativeMetadata,
      revision, agents: { revision: 1, subagent: null, execution },
    } } } };
    if (!store) throw new Error('Expected a directory store');
    await act(() => store?.setState({ session: [record] }));
  };
  try {
    await render();
    await act(() => useConfigStore.setState({ providers, settingsDefaultModel: 'codex-native/gpt-test', settingsDefaultVariant: 'max' }));
    await setExecution(choice('deepseek-native', 'ds-test', 'max'));
    await verify({ state, render, setExecution });
  } finally {
    await act(() => root.unmount());
    for (const spy of spies) spy.mockRestore();
    useConfigStore.setState(configBefore);
    useSelectionStore.setState(selectionBefore);
    dom.restore();
  }
};

describe('plan approval model and effort drafts', () => {
  test('captures a manual effort for this approval while retaining the combination default for the next', async () => {
    await withProbe(async ({ state, render, setExecution }) => {
      expect(state().value).toEqual(choice('deepseek-native', 'ds-test', 'max'));
      await act(() => state().choose('codex-native', 'gpt-test'));
      expect(state().value?.variant).toBe('max');
      await act(() => state().chooseVariant('high-fast'));
      expect(state().executionFor({ 'question-0': 'build' })).toEqual({ ...choice('codex-native', 'gpt-test', 'high-fast'), expectedRevision: 3 });
      expect(state().executionFor({ 'question-0': 'plan' })).toBeUndefined();
      await setExecution(choice('claude-native', 'opus', 'max'));
      await render(undefined, undefined, 'remounted');
      expect(state().value).toEqual(choice('codex-native', 'gpt-test', 'high-fast'));
      await render(undefined, `ncq_${crypto.randomUUID()}`);
      expect(state().value).toEqual(choice('claude-native', 'opus', 'max'));
    });
  });

  test('preserves explicit CLI defaults and rejects unsupported efforts', async () => {
    await withProbe(async ({ state }) => {
      await act(() => state().choose('codex-native', 'gpt-test'));
      await act(() => state().chooseVariant(undefined));
      await act(() => state().chooseVariant('ultra'));
      expect(state().value?.variant).toBeUndefined();
      expect(state().executionFor({ 'question-0': 'build' })?.variant).toBeUndefined();
      await act(() => state().choose('deepseek-native', 'plain'));
      expect(state().variants).toEqual([]);
      expect(state().canApprove).toBe(true);
      expect(state().value?.variant).toBeUndefined();
    });
  });

  test('lets an unconfirmed approval keep a new draft without replaying it before confirmation', async () => {
    await withProbe(async ({ state, render, setExecution }) => {
      const pending = { ...choice('codex-native', 'gpt-test', 'max-fast'), expectedRevision: 0 };
      await render(pending);
      await act(() => state().choose('claude-native', 'opus'));
      await act(() => state().chooseVariant('max'));
      expect(state().value).toEqual(choice('claude-native', 'opus', 'max'));
      expect(state().executionFor({ 'question-0': 'build' })).toEqual(pending);
      await render();
      await setExecution(choice('deepseek-native', 'ds-test', 'max'), 7);
      expect(state().executionFor({ 'question-0': 'build' })).toEqual({ ...choice('claude-native', 'opus', 'max'), expectedRevision: 7 });
    });
  });

  test('requires a supported effort when a captured model configuration is stale', async () => {
    await withProbe(async ({ state, setExecution }) => {
      await setExecution(choice('codex-native', 'gpt-test', 'retired-effort'));
      expect(state().available).toBe(true);
      expect(state().effortAvailable).toBe(false);
      expect(state().canApprove).toBe(false);
      await act(() => state().chooseVariant('max'));
      expect(state().canApprove).toBe(true);
    });
  });
});
