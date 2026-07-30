import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { opencodeClient } from '@/lib/opencode/client';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useSessionWorktreeStore } from './session-worktree-store';
import { expandSlashCommandGoalObjective, routeMessage, useSessionUIStore } from './session-ui-store';
import { setActionRefs, setOptimisticRefs } from './session-actions';
import { useSessionInputQueueStore } from './session-input-queue';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { useCommandsStore } from '@/stores/useCommandsStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { getRuntimeKey } from '@/lib/runtime-switch';
import {
  clearPersistedSessionNavigation,
  parsePersistedSessionNavigation,
  persistSessionNavigation,
  readPersistedSessionNavigation,
  openSessionFromToast,
} from './session-navigation';

/**
 * Unit tests for session worktree routing through the authoritative store.
 *
 * These tests verify that session-worktree-store is properly integrated as the
 * authoritative holder of session↔worktree attachments, and that session-ui-store
 * routes through it for switching and creation flows.
 *
 * Note: Full integration tests for setCurrentSession require runtime mocking.
 * These tests focus on the contract layer: that setAttachment/getAttachment work
 * correctly and that the contract helpers produce correct results.
 */

describe('session-worktree-store worktree routing', () => {
  beforeEach(() => {
    // Clear all attachments before each test
    const store = useSessionWorktreeStore.getState();
    const attachments = store.attachments;
    for (const sessionId of attachments.keys()) {
      store.clearAttachment(sessionId);
    }
    useSessionUIStore.setState({ currentSessionId: null, worktreeMetadata: new Map() });
  });

  test('getDirectoryForSession prefers authoritative attachment cwd over sync fallback', () => {
    useSessionWorktreeStore.getState().setAttachment('session-dir', {
      worktreeRoot: '/repo/worktrees/feat-a',
      cwd: '/repo/worktrees/feat-a/src',
      branch: 'feat-a',
      headState: 'branch',
      worktreeStatus: 'ready',
      worktreeSource: 'existing',
      legacy: false,
      degraded: false,
    });

    expect(useSessionUIStore.getState().getDirectoryForSession('session-dir')).toBe('/repo/worktrees/feat-a/src');
  });

  test('getDirectoryForSession falls back to authoritative worktreeRoot when attachment is degraded', () => {
    useSessionWorktreeStore.getState().setAttachment('session-dir', {
      worktreeRoot: '/repo/worktrees/feat-a',
      cwd: '/tmp/outside',
      branch: 'feat-a',
      headState: 'branch',
      worktreeStatus: 'invalid',
      worktreeSource: 'existing',
      legacy: false,
      degraded: true,
    });

    expect(useSessionUIStore.getState().getDirectoryForSession('session-dir')).toBe('/repo/worktrees/feat-a');
  });

  test('setCurrentSession uses canonical cwd when valid', () => {
    const store = useSessionWorktreeStore.getState();

    // Simulate: session has valid worktree metadata with cwd inside worktreeRoot
    store.setAttachment('session-1', {
      worktreeRoot: '/repo/worktrees/feat-a',
      cwd: '/repo/worktrees/feat-a/src',
      branch: 'feat-a',
      headState: 'branch',
      worktreeStatus: 'ready',
      worktreeSource: 'existing',
      legacy: false,
      degraded: false,
    });

    const attachment = store.getAttachment('session-1');
    expect(attachment).toBeDefined();
    expect(attachment.cwd).toBe('/repo/worktrees/feat-a/src');
    expect(attachment.worktreeRoot).toBe('/repo/worktrees/feat-a');
    expect(attachment.degraded).toBe(false);
    expect(attachment.worktreeStatus).toBe('ready');
  });

  test('setCurrentSession falls back to worktreeRoot when cwd is degraded', () => {
    const store = useSessionWorktreeStore.getState();

    // Simulate: cwd is outside worktreeRoot (degraded)
    store.setAttachment('session-2', {
      worktreeRoot: '/repo/worktrees/feat-a',
      cwd: '/repo/worktrees/feat-a', // same as worktreeRoot means not degraded for this case
      branch: 'feat-a',
      headState: 'branch',
      worktreeStatus: 'ready',
      worktreeSource: 'existing',
      legacy: false,
      degraded: true, // marked degraded because cwd was resolved from invalid state
    });

    const attachment = store.getAttachment('session-2');
    expect(attachment).toBeDefined();
    expect(attachment.degraded).toBe(true);
    // cwd should equal worktreeRoot when degraded (fallback)
    expect(attachment.cwd).toBe(attachment.worktreeRoot);
  });

  test('isolated session initializes created-for-session attachment', () => {
    const store = useSessionWorktreeStore.getState();

    // Simulate: isolated worktree session created for a specific branch
    store.setAttachment('session-isolated', {
      worktreeRoot: '/repo/worktrees/feature-xyz',
      cwd: '/repo/worktrees/feature-xyz',
      branch: 'feature-xyz',
      headState: 'branch',
      worktreeStatus: 'ready',
      worktreeSource: 'created-for-session',
      legacy: false,
      degraded: false,
    });

    const attachment = store.getAttachment('session-isolated');
    expect(attachment).toBeDefined();
    expect(attachment.worktreeSource).toBe('created-for-session');
    expect(attachment.worktreeStatus).toBe('ready');
    expect(attachment.legacy).toBe(false);
  });

  test('legacy session upgrades when runtime canonicalization recovers a worktree', () => {
    const store = useSessionWorktreeStore.getState();

    // Simulate: session without metadata (legacy) gets upgraded via runtime resolution
    // Initially no attachment
    let attachment = store.getAttachment('session-legacy');
    expect(attachment).toBeUndefined();

    // Runtime canonicalization resolves it to a worktree
    store.setAttachment('session-legacy', {
      worktreeRoot: '/repo/worktrees/recovered',
      cwd: '/repo/worktrees/recovered',
      branch: 'recovered',
      headState: 'branch',
      worktreeStatus: 'ready',
      worktreeSource: 'existing',
      legacy: false, // upgraded from legacy=true to false
      degraded: false,
    });

    attachment = store.getAttachment('session-legacy');
    expect(attachment).toBeDefined();
    expect(attachment.legacy).toBe(false);
    expect(attachment.worktreeRoot).toBe('/repo/worktrees/recovered');
  });

  test('missing worktree session has missing status', () => {
    const store = useSessionWorktreeStore.getState();

    // Simulate: session whose worktree was deleted
    store.setAttachment('session-missing', {
      worktreeRoot: null,
      cwd: null,
      branch: null,
      headState: 'branch',
      worktreeStatus: 'missing',
      worktreeSource: null,
      legacy: false,
      degraded: true,
    });

    const attachment = store.getAttachment('session-missing');
    expect(attachment).toBeDefined();
    expect(attachment.worktreeStatus).toBe('missing');
    expect(attachment.degraded).toBe(true);
  });

  test('not-a-repo session has correct status', () => {
    const store = useSessionWorktreeStore.getState();

    // Simulate: session opened in a directory that is not a git repo
    store.setAttachment('session-not-repo', {
      worktreeRoot: null,
      cwd: '/tmp/not-a-repo',
      branch: null,
      headState: 'detached',
      worktreeStatus: 'not-a-repo',
      worktreeSource: null,
      legacy: false,
      degraded: true,
    });

    const attachment = store.getAttachment('session-not-repo');
    expect(attachment).toBeDefined();
    expect(attachment.worktreeStatus).toBe('not-a-repo');
  });
});

describe('persisted current session navigation', () => {
  const runtimeA = 'test:session-navigation-a';
  const runtimeB = 'test:session-navigation-b';

  beforeEach(() => {
    clearPersistedSessionNavigation(null, runtimeA);
    clearPersistedSessionNavigation(null, runtimeB);
    clearPersistedSessionNavigation();
    useSessionUIStore.setState({
      currentSessionId: null,
      currentSessionDirectory: null,
      restoredSessionPendingValidation: false,
      restoredSessionRuntimeKey: null,
      newSessionDraft: { open: false, directoryOverride: null, parentID: null },
    });
    useGlobalSessionsStore.setState({ activeSessions: [], archivedSessions: [] });
  });

  afterEach(() => {
    clearPersistedSessionNavigation(null, runtimeA);
    clearPersistedSessionNavigation(null, runtimeB);
    clearPersistedSessionNavigation();
  });

  test('rejects malformed and version-mismatched records', () => {
    expect(parsePersistedSessionNavigation('{')).toBeNull();
    expect(parsePersistedSessionNavigation(JSON.stringify({ version: 2, sessionId: 'session-a' }))).toBeNull();
    expect(parsePersistedSessionNavigation(JSON.stringify({ version: 1, sessionId: '' }))).toBeNull();
    expect(parsePersistedSessionNavigation(JSON.stringify({
      version: 1,
      sessionId: ' session-a ',
      directory: '/repo/project/',
    }))).toEqual({
      version: 1,
      sessionId: 'session-a',
      directory: '/repo/project',
    });
  });

  test('restores independent conversations for each runtime', () => {
    persistSessionNavigation('session-a', '/repo/a', runtimeA);
    persistSessionNavigation('session-b', '/repo/b', runtimeB);

    useSessionUIStore.getState().restoreForRuntimeSwitch(runtimeA);
    expect(useSessionUIStore.getState()).toMatchObject({
      currentSessionId: 'session-a',
      currentSessionDirectory: '/repo/a',
      restoredSessionPendingValidation: true,
      restoredSessionRuntimeKey: runtimeA,
    });

    useSessionUIStore.getState().restoreForRuntimeSwitch(runtimeB);
    expect(useSessionUIStore.getState()).toMatchObject({
      currentSessionId: 'session-b',
      currentSessionDirectory: '/repo/b',
      restoredSessionPendingValidation: true,
      restoredSessionRuntimeKey: runtimeB,
    });
  });

  test('only clears the persisted conversation when the session matches', () => {
    persistSessionNavigation('session-a', '/repo/a', runtimeA);

    clearPersistedSessionNavigation('session-b', runtimeA);
    expect(readPersistedSessionNavigation(runtimeA)?.sessionId).toBe('session-a');

    clearPersistedSessionNavigation('session-a', runtimeA);
    expect(readPersistedSessionNavigation(runtimeA)).toBeNull();
  });

  test('clears a restored conversation after an authoritative active list excludes it', () => {
    const runtimeKey = getRuntimeKey();
    persistSessionNavigation('session-gone', '/repo/gone', runtimeKey);
    useSessionUIStore.setState({
      currentSessionId: 'session-gone',
      currentSessionDirectory: '/repo/gone',
      restoredSessionPendingValidation: true,
      restoredSessionRuntimeKey: runtimeKey,
    });

    useSessionUIStore.getState().reconcileRestoredSession(null);

    expect(useSessionUIStore.getState()).toMatchObject({
      currentSessionId: null,
      currentSessionDirectory: null,
      restoredSessionPendingValidation: false,
      restoredSessionRuntimeKey: null,
    });
    expect(readPersistedSessionNavigation(runtimeKey)).toBeNull();
  });

  test('replaces a stale saved directory with the authoritative session directory', () => {
    const runtimeKey = getRuntimeKey();
    persistSessionNavigation('session-active', '/repo/stale', runtimeKey);
    useSessionUIStore.setState({
      currentSessionId: 'session-active',
      currentSessionDirectory: '/repo/stale',
      restoredSessionPendingValidation: true,
      restoredSessionRuntimeKey: runtimeKey,
    });

    useSessionUIStore.getState().reconcileRestoredSession({
      id: 'session-active',
      directory: '/repo/authoritative',
      time: { created: 1 },
    });

    expect(useSessionUIStore.getState()).toMatchObject({
      currentSessionId: 'session-active',
      currentSessionDirectory: '/repo/authoritative',
      restoredSessionPendingValidation: false,
      restoredSessionRuntimeKey: null,
    });
    expect(readPersistedSessionNavigation(runtimeKey)?.directory).toBe('/repo/authoritative');
  });

  test('restores a persisted subagent through its parent chain to the root conversation', () => {
    const runtimeKey = getRuntimeKey();
    const root = {
      id: 'session-root',
      directory: '/repo/root',
      time: { created: 1 },
    };
    const child = {
      id: 'session-child',
      parentID: root.id,
      directory: '/repo/root',
      time: { created: 2 },
    };
    const grandchild = {
      id: 'session-grandchild',
      parentID: child.id,
      directory: '/repo/root',
      time: { created: 3 },
    };
    persistSessionNavigation(grandchild.id, grandchild.directory, runtimeKey);
    useGlobalSessionsStore.setState({ activeSessions: [root, child, grandchild], archivedSessions: [] });
    useSessionUIStore.setState({
      currentSessionId: grandchild.id,
      currentSessionDirectory: grandchild.directory,
      restoredSessionPendingValidation: true,
      restoredSessionRuntimeKey: runtimeKey,
    });

    useSessionUIStore.getState().reconcileRestoredSession(grandchild);

    expect(useSessionUIStore.getState()).toMatchObject({
      currentSessionId: root.id,
      currentSessionDirectory: root.directory,
      restoredSessionPendingValidation: false,
      restoredSessionRuntimeKey: null,
    });
    expect(readPersistedSessionNavigation(runtimeKey)?.sessionId).toBe(root.id);
  });

  test('clears a restored subagent when its parent is missing', () => {
    const runtimeKey = getRuntimeKey();
    const child = {
      id: 'session-orphan',
      parentID: 'session-missing-parent',
      directory: '/repo/orphan',
      time: { created: 1 },
    };
    persistSessionNavigation(child.id, child.directory, runtimeKey);
    useGlobalSessionsStore.setState({ activeSessions: [child], archivedSessions: [] });
    useSessionUIStore.setState({
      currentSessionId: child.id,
      currentSessionDirectory: child.directory,
      restoredSessionPendingValidation: true,
      restoredSessionRuntimeKey: runtimeKey,
    });

    useSessionUIStore.getState().reconcileRestoredSession(child);

    expect(useSessionUIStore.getState()).toMatchObject({
      currentSessionId: null,
      currentSessionDirectory: null,
      restoredSessionPendingValidation: false,
      restoredSessionRuntimeKey: null,
    });
    expect(readPersistedSessionNavigation(runtimeKey)).toBeNull();
  });

  test('clears a restored subagent when its parent chain contains a cycle', () => {
    const runtimeKey = getRuntimeKey();
    const first = {
      id: 'session-cycle-a',
      parentID: 'session-cycle-b',
      directory: '/repo/cycle',
      time: { created: 1 },
    };
    const second = {
      id: 'session-cycle-b',
      parentID: first.id,
      directory: '/repo/cycle',
      time: { created: 2 },
    };
    persistSessionNavigation(first.id, first.directory, runtimeKey);
    useGlobalSessionsStore.setState({ activeSessions: [first, second], archivedSessions: [] });
    useSessionUIStore.setState({
      currentSessionId: first.id,
      currentSessionDirectory: first.directory,
      restoredSessionPendingValidation: true,
      restoredSessionRuntimeKey: runtimeKey,
    });

    useSessionUIStore.getState().reconcileRestoredSession(first);

    expect(useSessionUIStore.getState()).toMatchObject({
      currentSessionId: null,
      currentSessionDirectory: null,
      restoredSessionPendingValidation: false,
      restoredSessionRuntimeKey: null,
    });
    expect(readPersistedSessionNavigation(runtimeKey)).toBeNull();
  });

  test('keeps the last conversation when an unsent new-session draft is opened', () => {
    useSessionUIStore.getState().setCurrentSession('session-last', '/repo/last');
    expect(readPersistedSessionNavigation()).toEqual({
      version: 1,
      sessionId: 'session-last',
      directory: '/repo/last',
    });

    useSessionUIStore.getState().openNewSessionDraft({ directoryOverride: '/repo/last' });

    expect(useSessionUIStore.getState().currentSessionId).toBeNull();
    expect(readPersistedSessionNavigation()?.sessionId).toBe('session-last');
  });

  test('lets an explicit notification target replace provisional cold-start restoration', () => {
    const runtimeKey = getRuntimeKey();
    persistSessionNavigation('session-restored', '/repo/restored', runtimeKey);
    useSessionUIStore.setState({
      currentSessionId: 'session-restored',
      currentSessionDirectory: '/repo/restored',
      restoredSessionPendingValidation: true,
      restoredSessionRuntimeKey: runtimeKey,
    });

    openSessionFromToast('session-notification', '/repo/notification');

    expect(useSessionUIStore.getState()).toMatchObject({
      currentSessionId: 'session-notification',
      currentSessionDirectory: '/repo/notification',
      restoredSessionPendingValidation: false,
      restoredSessionRuntimeKey: null,
    });
    expect(readPersistedSessionNavigation(runtimeKey)).toMatchObject({
      sessionId: 'session-notification',
      directory: '/repo/notification',
    });
  });
});

describe('routeMessage directory scoping', () => {
  test('runs sends in the provided session directory', async () => {
    // The session directory travels as an explicit request param (not via
    // client-wide directory scoping), so concurrent sends can't cross-talk.
    const calls = [];
    const originalShellSession = opencodeClient.shellSession;

    opencodeClient.shellSession = async (params) => {
      calls.push(params);
      return { info: {}, parts: [] };
    };

    try {
      await routeMessage({
        sessionId: 'session-a',
        directory: '/session/project',
        content: 'pwd',
        providerID: 'provider-a',
        modelID: 'model-a',
        inputMode: 'shell',
      });
    } finally {
      opencodeClient.shellSession = originalShellSession;
    }

    expect(calls).toHaveLength(1);
    expect(calls[0].sessionId).toBe('session-a');
    expect(calls[0].directory).toBe('/session/project');
  });
});

describe('slash-command goal objectives', () => {
  test('expands every $ARGUMENTS reference from the authoritative command template', () => {
    expect(expandSlashCommandGoalObjective('/issue--to-pr LIN-123 --draft', [{
      name: 'issue--to-pr',
      template: 'Run the issue pipeline for $ARGUMENTS. Verify $ARGUMENTS is represented by the PR.',
    }])).toBe('Run the issue pipeline for LIN-123 --draft. Verify LIN-123 --draft is represented by the PR.');
  });

  test('keeps the invocation when the command template is unavailable', () => {
    expect(expandSlashCommandGoalObjective('/issue--to-pr LIN-123', [{ name: 'issue--to-pr' }]))
      .toBe('/issue--to-pr LIN-123');
  });

  test('matches OpenCode positional and implicit argument expansion', () => {
    expect(expandSlashCommandGoalObjective('/move "src old" dist extra', [{
      name: 'move',
      template: 'Move $1 to $2',
    }])).toBe('Move src old to dist extra');
    expect(expandSlashCommandGoalObjective('/review auth module', [{
      name: 'review',
      template: 'Review the requested scope.',
    }])).toBe('Review the requested scope.\n\nauth module');
  });
});

describe('runtime worktree topology', () => {
  test('restores independent in-memory maps across A -> B -> A', () => {
    const topologyA = new Map([['/repo', [{ path: '/repo/a', branch: 'a' }]]]);
    const topologyB = new Map([['/repo', [{ path: '/repo/b', branch: 'b' }]]]);

    useSessionUIStore.setState({ availableWorktreesByProject: topologyA, availableWorktrees: topologyA.get('/repo') });
    useSessionUIStore.getState().prepareForRuntimeSwitch('runtime-a');
    useSessionUIStore.setState({ availableWorktreesByProject: topologyB, availableWorktrees: topologyB.get('/repo') });
    useSessionUIStore.getState().prepareForRuntimeSwitch('runtime-b');

    useSessionUIStore.getState().restoreForRuntimeSwitch('runtime-a');
    expect(useSessionUIStore.getState().availableWorktreesByProject.get('/repo')?.[0]?.path).toBe('/repo/a');

    useSessionUIStore.getState().restoreForRuntimeSwitch('runtime-b');
    expect(useSessionUIStore.getState().availableWorktreesByProject.get('/repo')?.[0]?.path).toBe('/repo/b');
  });
});

describe('openNewSessionDraft project binding', () => {
  const projectA = { id: 'proj-a', path: '/projects/alpha', label: 'Alpha' };
  const projectB = { id: 'proj-b', path: '/projects/beta', label: 'Beta' };

  beforeEach(() => {
    useSessionUIStore.setState({
      currentSessionId: null,
      currentSessionDirectory: null,
      newSessionDraft: { open: false, directoryOverride: null, parentID: null },
      availableWorktreesByProject: new Map(),
    });
    useProjectsStore.setState({
      projects: [projectA, projectB],
      activeProjectId: projectA.id,
    });
    useDirectoryStore.getState().setDirectory(projectB.path, { showOverlay: false });
  });

  test('keeps implicit draft on current directory when active project differs', () => {
    useSessionUIStore.getState().openNewSessionDraft();
    const draft = useSessionUIStore.getState().newSessionDraft;

    expect(draft.open).toBe(true);
    expect(draft.selectedProjectId).toBe(projectB.id);
    expect(draft.directoryOverride).toBe(projectB.path);
  });

  test('does not attach active project when current directory is unmatched', () => {
    useDirectoryStore.getState().setDirectory('/external/worktree', { showOverlay: false });

    useSessionUIStore.getState().openNewSessionDraft();
    const draft = useSessionUIStore.getState().newSessionDraft;

    expect(draft.open).toBe(true);
    expect(draft.selectedProjectId).toBeNull();
    expect(draft.directoryOverride).toBe('/external/worktree');
  });

  test('respects explicit directoryOverride over active project', () => {
    useSessionUIStore.getState().openNewSessionDraft({ directoryOverride: '/projects/beta/src' });
    const draft = useSessionUIStore.getState().newSessionDraft;

    expect(draft.open).toBe(true);
    expect(draft.directoryOverride).toBe('/projects/beta/src');
  });

  test('respects explicit selectedProjectId over active project', () => {
    useSessionUIStore.getState().openNewSessionDraft({ selectedProjectId: projectB.id });
    const draft = useSessionUIStore.getState().newSessionDraft;

    expect(draft.open).toBe(true);
    expect(draft.selectedProjectId).toBe(projectB.id);
  });
});

describe('createSession draft lifecycle', () => {
  let originalCreateSession;

  beforeEach(() => {
    originalCreateSession = opencodeClient.createSession;
    useSessionUIStore.setState({
      currentSessionId: null,
      currentSessionDirectory: null,
      newSessionDraft: { open: true, directoryOverride: '/projects/alpha', parentID: null, title: 'Draft title' },
    });
  });

  afterEach(() => {
    opencodeClient.createSession = originalCreateSession;
  });

  test('keeps the draft open when session creation fails', async () => {
    opencodeClient.createSession = async () => {
      throw new Error('offline');
    };

    const session = await useSessionUIStore.getState().createSession('Draft title', '/projects/alpha');

    expect(session).toBeNull();
    expect(useSessionUIStore.getState().newSessionDraft.open).toBe(true);
    expect(useSessionUIStore.getState().newSessionDraft.title).toBe('Draft title');
  });
});

describe('routeMessage skill invocation', () => {
  // OpenCode registers every skill as a command (source: "skill"), so a skill
  // selected from the slash menu must be dispatched via session.command so its
  // content is injected — not sent as a plain "/name" text message (issue #1605).
  const sendCommandCalls = [];
  const sendMessageCalls = [];
  let originalSendCommand;
  let originalSendMessage;
  let originalLoadSessionInputAdmissionHistory;

  beforeEach(() => {
    sendCommandCalls.length = 0;
    sendMessageCalls.length = 0;

    // Minimal optimistic + connection machinery so routeMessage can dispatch.
    const childStore = {
      getState: () => ({ session_status: {} }),
      setState: () => {},
    };
    const childStores = {
      children: new Map(),
      ensureChild: () => childStore,
      getChild: () => childStore,
    };
    setActionRefs(opencodeClient, childStores, () => '/skills/project');
    setOptimisticRefs(() => {}, () => {});
    useConfigStore.setState({ isConnected: true });

    // The sync command list and the commands store both exclude user skills,
    // so they start empty here — the skill is only known to the skills store.
    useCommandsStore.setState({ commands: [] });
    useSkillsStore.setState({ skills: [] });

    originalSendCommand = opencodeClient.sendCommand;
    originalSendMessage = opencodeClient.sendMessage;
    originalLoadSessionInputAdmissionHistory = opencodeClient.loadSessionInputAdmissionHistory;
    useSessionInputQueueStore.setState({ entriesByKey: {}, promotedByKey: {} });
    opencodeClient.sendCommand = async (params) => {
      sendCommandCalls.push(params);
      return 'msg';
    };
    opencodeClient.sendMessage = async (params) => {
      sendMessageCalls.push(params);
      return 'msg';
    };
  });

  afterEach(() => {
    opencodeClient.sendCommand = originalSendCommand;
    opencodeClient.sendMessage = originalSendMessage;
    opencodeClient.loadSessionInputAdmissionHistory = originalLoadSessionInputAdmissionHistory;
    useSkillsStore.setState({ skills: [] });
    useSessionInputQueueStore.setState({ entriesByKey: {}, promotedByKey: {} });
  });

  test('invokes a user-installed skill as a command', async () => {
    useSkillsStore.setState({
      skills: [{ name: 'grill-with-docs', path: '/skills/grill-with-docs/SKILL.md', scope: 'user', source: 'opencode' }],
    });

    await routeMessage({
      sessionId: 'session-skill',
      directory: '/skills/project',
      content: '/grill-with-docs',
      providerID: 'provider-a',
      modelID: 'model-a',
    });

    expect(sendCommandCalls).toHaveLength(1);
    expect(sendCommandCalls[0].command).toBe('grill-with-docs');
    expect(sendMessageCalls).toHaveLength(0);
  });

  test('forwards trailing arguments to the skill command', async () => {
    useSkillsStore.setState({
      skills: [{ name: 'grill-with-docs', path: '/skills/grill-with-docs/SKILL.md', scope: 'user', source: 'opencode' }],
    });

    await routeMessage({
      sessionId: 'session-skill',
      directory: '/skills/project',
      content: '/grill-with-docs focus on auth',
      providerID: 'provider-a',
      modelID: 'model-a',
    });

    expect(sendCommandCalls).toHaveLength(1);
    expect(sendCommandCalls[0].command).toBe('grill-with-docs');
    expect(sendCommandCalls[0].arguments).toBe('focus on auth');
  });

  test('sends an unknown slash token as a plain message', async () => {
    await routeMessage({
      sessionId: 'session-skill',
      directory: '/skills/project',
      content: '/not-a-real-skill',
      providerID: 'provider-a',
      modelID: 'model-a',
      delivery: 'queue',
    });

    expect(sendMessageCalls).toHaveLength(1);
    expect(sendMessageCalls[0].delivery).toBe('queue');
    expect(sendCommandCalls).toHaveLength(0);
  });

  test('queue delivery records official admission without a transcript optimistic insert', async () => {
    const optimisticAdds = [];
    setOptimisticRefs((input) => optimisticAdds.push(input), () => {});
    opencodeClient.sendMessage = async (params) => {
      sendMessageCalls.push(params);
      params.onAdmitted?.({
        admittedSeq: 42,
        id: params.messageId,
        sessionID: params.id,
        prompt: { text: params.text, files: [{ uri: 'data:text/plain;base64,AA==', name: 'note.txt' }] },
        delivery: 'queue',
        timeCreated: 4200,
      });
      return params.messageId;
    };

    await routeMessage({
      sessionId: 'session-queue',
      directory: '/skills/project',
      content: 'queue this',
      providerID: 'provider-a',
      modelID: 'model-a',
      files: [{ type: 'file', mime: 'text/plain', url: 'data:text/plain;base64,AA==', filename: 'note.txt' }],
      delivery: 'queue',
      messageId: 'msg-queue',
    });

    expect(optimisticAdds).toHaveLength(0);
    expect(sendMessageCalls).toHaveLength(1);
    expect(sendMessageCalls[0].delivery).toBe('queue');
    const queued = useSessionInputQueueStore.getState().entriesByKey;
    expect(Object.values(queued).flatMap((entries) => Object.values(entries))).toEqual([
      expect.objectContaining({
        messageID: 'msg-queue',
        sessionID: 'session-queue',
        directory: '/skills/project',
        state: 'queued',
        admittedSeq: 42,
        fileCount: 1,
      }),
    ]);
  });

  test('ambiguous queue failure confirms admission through durable history', async () => {
    opencodeClient.sendMessage = async () => {
      throw new TypeError('Failed to fetch');
    };
    opencodeClient.loadSessionInputAdmissionHistory = async (params) => {
      expect(params).toEqual({ sessionID: 'session-queue', directory: '/skills/project', limit: 500, maxPages: 100 });
      return {
        complete: true,
        admissions: [{
          admittedSeq: 43,
          id: 'msg-ambiguous-queue',
          sessionID: 'session-queue',
          prompt: { text: 'queue this' },
          delivery: 'queue',
          timeCreated: 4300,
        }],
      };
    };

    await routeMessage({
      sessionId: 'session-queue',
      directory: '/skills/project',
      content: 'queue this',
      providerID: 'provider-a',
      modelID: 'model-a',
      delivery: 'queue',
      messageId: 'msg-ambiguous-queue',
    });

    const queued = Object.values(useSessionInputQueueStore.getState().entriesByKey)
      .flatMap((entries) => Object.values(entries));
    expect(queued).toEqual([
      expect.objectContaining({
        messageID: 'msg-ambiguous-queue',
        state: 'queued',
        admittedSeq: 43,
      }),
    ]);
  });

  test('keeps an ambiguous queue submission pending when durable history is incomplete', async () => {
    opencodeClient.sendMessage = async () => {
      throw new TypeError('Failed to fetch');
    };
    opencodeClient.loadSessionInputAdmissionHistory = async () => ({
      complete: false,
      admissions: [],
    });

    await routeMessage({
      sessionId: 'session-queue',
      directory: '/skills/project',
      content: 'queue this',
      providerID: 'provider-a',
      modelID: 'model-a',
      delivery: 'queue',
      messageId: 'msg-unknown-queue',
    });

    const queued = Object.values(useSessionInputQueueStore.getState().entriesByKey)
      .flatMap((entries) => Object.values(entries));
    expect(queued).toEqual([
      expect.objectContaining({
        messageID: 'msg-unknown-queue',
        state: 'submitting',
      }),
    ]);
  });

  test('removes the submitting chip and rethrows when queue admission is rejected', async () => {
    const failure = Object.assign(new Error('conflict'), { status: 409 });
    opencodeClient.sendMessage = async () => {
      throw failure;
    };

    await expect(routeMessage({
      sessionId: 'session-queue',
      directory: '/skills/project',
      content: 'queue this',
      providerID: 'provider-a',
      modelID: 'model-a',
      delivery: 'queue',
      messageId: 'msg-rejected-queue',
    })).rejects.toBe(failure);

    expect(useSessionInputQueueStore.getState().entriesByKey).toEqual({});
  });

  test('forwards a caller-provided stable message ID through optimisticSend to the SDK', async () => {
    const messageId = 'msg_000000000001ABCDEFGHIJKLMN';

    await routeMessage({
      sessionId: 'session-stable-id',
      directory: '/skills/project',
      content: 'follow up',
      providerID: 'provider-a',
      modelID: 'model-a',
      messageId,
    });

    expect(sendMessageCalls).toHaveLength(1);
    expect(sendMessageCalls[0].messageId).toBe(messageId);
  });
});
