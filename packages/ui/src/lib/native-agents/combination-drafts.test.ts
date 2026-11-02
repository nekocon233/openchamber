import { afterEach, describe, expect, test } from 'bun:test';
import { initializeRuntimeEndpoint, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { captureAgentCombinationDraft, readAgentCombinationDraft, useAgentCombinationDrafts } from './combination-drafts';
import type { NativeAgentConfigurationWrite } from './combinations';

afterEach(() => useAgentCombinationDrafts.setState({ drafts: new Map() }));
const configured: NativeAgentConfigurationWrite = { subagent: { model: { providerID: 'codex-native', modelID: 'gpt-test' } }, execution: null };
describe('native combination drafts', () => {
  test('isolates managed chat drafts before a directory exists and retains a captured choice', () => {
    const target = { draftId: 71 };
    useAgentCombinationDrafts.getState().set(target, configured);
    const captured = captureAgentCombinationDraft(target);
    expect(captured).toEqual({ target, configuration: configured });
    expect(readAgentCombinationDraft({ draftId: 72 })).toBeUndefined();
    expect(readAgentCombinationDraft('/newly-created-chat')).toBeUndefined();
    const newer: NativeAgentConfigurationWrite = { subagent: null, execution: null };
    useAgentCombinationDrafts.getState().set(target, newer);
    if (!captured) throw new Error('The draft should have a captured combination');
    useAgentCombinationDrafts.getState().clear(captured.target, captured.configuration);
    expect(readAgentCombinationDraft(target)).toBe(newer);
  });
  test('keeps drafts scoped to a runtime and directory', () => {
    initializeRuntimeEndpoint({ apiBaseUrl: 'http://one.test', runtimeKey: 'one' });
    useAgentCombinationDrafts.getState().set('/workspace', configured);
    expect(readAgentCombinationDraft('/elsewhere')).toBeUndefined();
    switchRuntimeEndpoint({ apiBaseUrl: 'http://two.test', runtimeKey: 'two' });
    expect(readAgentCombinationDraft('/workspace')).toBeUndefined();
  });
  test('consuming a created session preserves a newer draft edit', () => {
    initializeRuntimeEndpoint({ apiBaseUrl: 'http://one.test', runtimeKey: 'one' });
    const next: NativeAgentConfigurationWrite = { subagent: null, execution: null };
    useAgentCombinationDrafts.getState().set('/workspace', configured);
    useAgentCombinationDrafts.getState().set('/workspace', next);
    useAgentCombinationDrafts.getState().clear('/workspace', configured);
    expect(readAgentCombinationDraft('/workspace')).toBe(next);
    useAgentCombinationDrafts.getState().clear('/workspace', next);
    expect(readAgentCombinationDraft('/workspace')).toBeUndefined();
  });
});
