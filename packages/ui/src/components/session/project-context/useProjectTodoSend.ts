import React from 'react';

import { toast } from '@/components/ui';
import { useSessionActivity } from '@/hooks/useSessionActivity';
import { resolveSessionSendSelection } from '@/lib/defaultSendSelection';
import { generateBranchName } from '@/lib/git/branchNameGenerator';
import { useI18n } from '@/lib/i18n';
import { loadMagicPrompts } from '@/lib/magicPrompts';
import type { ProjectRef } from '@/lib/projectContextApi';
import { getRuntimeEndpointGeneration, getRuntimeKey } from '@/lib/runtime-switch';
import { createWorktreeSessionForNewBranch } from '@/lib/worktreeSessionCreator';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import * as sessionActions from '@/sync/session-actions';
import { useSelectionStore } from '@/sync/selection-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { resolveExecutionForDirectory, type TodoSendExecution } from '../todoSendExecution';
import { useChatColumnActions, useChatSessionSelection } from '@/components/chat/chatColumnSession';

type PendingSendTarget = {
  kind: 'session' | 'worktree';
  todoId: string;
  todoText: string;
};

export const useProjectTodoSend = (options: {
  projectRef: ProjectRef | null;
  canCreateWorktree: boolean;
  onActionComplete?: () => void;
}) => {
  const { projectRef, canCreateWorktree, onActionComplete } = options;
  const { t } = useI18n();

  const [pendingSendTarget, setPendingSendTarget] = React.useState<PendingSendTarget | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [sendingTodoId, setSendingTodoId] = React.useState<string | null>(null);
  const currentSendPending = React.useRef(false);

  const { sessionId: currentSessionId, directory: currentSessionDirectory } = useChatSessionSelection();
  const { pinned } = useChatColumnActions();
  const createSession = useSessionUIStore((state) => state.createSession);
  const initializeNewOpenChamberSession = useSessionUIStore((state) => state.initializeNewOpenChamberSession);
  const sendMessage = useSessionUIStore((state) => state.sendMessage);
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const setSessionSwitcherOpen = useUIStore((state) => state.setSessionSwitcherOpen);
  // The session's own activity decides whether the message waits for the turn
  // or rides into it; see `sendToCurrentSession`. Its directory is known for a
  // live session; the project's own directory keeps the status readable when it
  // is not, instead of asking for a directoryless store.
  const activityDirectory = currentSessionDirectory ?? projectRef?.path ?? undefined;
  const { phase: currentSessionPhase } = useSessionActivity(currentSessionId, activityDirectory);

  const routeToChat = React.useCallback(() => {
    setSessionSwitcherOpen(false);
  }, [setSessionSwitcherOpen]);

  /**
   * Sends the todo into the conversation as a user message, the way pressing
   * send in the composer does. A running turn takes it as a steering message;
   * the todo no longer waits in the composer for a second manual send.
   */
  const sendToCurrentSession = React.useCallback(
    async (todoId: string, todoText: string) => {
      if (currentSendPending.current) return;
      const expectedRuntime = { runtimeKey: getRuntimeKey(), generation: getRuntimeEndpointGeneration() };
      const sessionState = useSessionUIStore.getState();
      const draft = !currentSessionId && !pinned && sessionState.newSessionDraft.open
        ? { ...sessionState.newSessionDraft }
        : undefined;
      if (!currentSessionId && !draft) {
        toast.error(t('rightSidebar.contextNotesTodo.toast.noActiveSession'));
        return;
      }
      const config = useConfigStore.getState();
      const selection = currentSessionId ? resolveSessionSendSelection(currentSessionId) : {
        providerID: config.currentProviderId,
        modelID: config.currentModelId,
        agent: config.currentAgentName || undefined,
        variant: config.currentVariant,
      };
      if (!selection?.providerID || !selection.modelID) {
        toast.error(t('chat.chatInput.toast.noModelSelected'));
        return;
      }
      let sentSessionId = currentSessionId;
      const sendOptions: NonNullable<Parameters<typeof sendMessage>[9]> = {
        userInitiated: true,
        expectedRuntime,
      };
      if (currentSessionId) {
        const directory = currentSessionDirectory ?? sessionState.getDirectoryForSession(currentSessionId);
        if (directory) sendOptions.target = { runtimeKey: expectedRuntime.runtimeKey, sessionId: currentSessionId, directory };
        else sendOptions.sessionId = currentSessionId;
      } else {
        sendOptions.draftSnapshot = draft;
        sendOptions.onSessionMaterialized = (sessionId) => { sentSessionId = sessionId; };
      }

      currentSendPending.current = true;
      setSendingTodoId(todoId);
      try {
        routeToChat();
        // A send supersedes a blocking prompt, as in the composer: rejecting it
        // resumes the turn, and the todo then steers into that turn.
        if (currentSessionId) {
          const [dismissedPermissions, dismissedQuestions] = await Promise.all([
            sessionActions.dismissOpenPermissionsForSession(currentSessionId),
            sessionActions.dismissOpenFormsForSession(currentSessionId),
          ]);
          if (currentSessionPhase !== 'idle' || dismissedPermissions || dismissedQuestions.dismissed) sendOptions.delivery = 'steer';
        }
        await sendMessage(
          todoText,
          selection.providerID,
          selection.modelID,
          selection.agent,
          undefined,
          undefined,
          undefined,
          selection.variant,
          'normal',
          sendOptions,
        );
        if (getRuntimeKey() !== expectedRuntime.runtimeKey || getRuntimeEndpointGeneration() !== expectedRuntime.generation) return;
        // The send started beside the chat, so the new row has to be brought
        // into view; the composer does the same before it submits.
        window.dispatchEvent(new CustomEvent('openchamber:chat-force-scroll-bottom', {
          detail: { sessionId: sentSessionId },
        }));
        toast.success(t('rightSidebar.contextNotesTodo.toast.sentToCurrentSession'));
        onActionComplete?.();
      } catch (error) {
        const description = error instanceof Error ? error.message : undefined;
        toast.error(t('rightSidebar.contextNotesTodo.toast.sendTodoFailed'), description ? { description } : undefined);
      } finally {
        currentSendPending.current = false;
        setSendingTodoId(null);
      }
    },
    [currentSessionDirectory, currentSessionId, currentSessionPhase, onActionComplete, pinned, routeToChat, sendMessage, t]
  );

  const sendToNewSession = React.useCallback(
    (todoId: string, todoText: string) => {
      if (!projectRef || sendingTodoId) {
        return;
      }
      setPendingSendTarget({ kind: 'session', todoId, todoText });
    },
    [projectRef, sendingTodoId]
  );

  const sendToNewWorktreeSession = React.useCallback(
    (todoId: string, todoText: string) => {
      if (!projectRef || sendingTodoId) {
        return;
      }
      if (!canCreateWorktree) {
        toast.error(t('rightSidebar.contextNotesTodo.toast.worktreeRequiresGitRepo'));
        return;
      }
      setPendingSendTarget({ kind: 'worktree', todoId, todoText });
    },
    [canCreateWorktree, projectRef, sendingTodoId, t]
  );

  const confirmSend = React.useCallback(
    async (dialogExecution: TodoSendExecution) => {
      if (!projectRef || !pendingSendTarget) {
        return;
      }

      setIsSubmitting(true);
      setSendingTodoId(pendingSendTarget.todoId);

      try {
        const prompts = await loadMagicPrompts(projectRef.path);
        const visiblePrompt = prompts.render('plan.todo.visible', {
          todo_text: pendingSendTarget.todoText,
        });
        const instructionsText = prompts.render('plan.todo.instructions', {
          todo_text: pendingSendTarget.todoText,
        });
        const syntheticParts = [{ synthetic: true as const, text: instructionsText }];

        routeToChat();

        let sessionId: string | null = null;
        let directoryHint: string | null = projectRef.path;
        let execution = dialogExecution;

        if (pendingSendTarget.kind === 'worktree') {
          if (!canCreateWorktree) {
            toast.error(t('rightSidebar.contextNotesTodo.toast.worktreeRequiresGitRepo'));
            return;
          }
          const created = await createWorktreeSessionForNewBranch(projectRef.path, generateBranchName());
          if (!created?.id) {
            return;
          }
          sessionId = created.id;
          directoryHint = created.directory;
          execution = await resolveExecutionForDirectory(created.directory, dialogExecution);
        } else {
          const session = await createSession(undefined, projectRef.path, undefined, {
            model: { providerID: execution.providerID, id: execution.modelID, variant: execution.variant || undefined },
            agent: execution.agent.trim() || undefined,
          });
          if (!session?.id) {
            toast.error(t('rightSidebar.contextNotesTodo.toast.createSessionFailed'));
            return;
          }
          sessionId = session.id;
          directoryHint = session.directory ?? projectRef.path;
          initializeNewOpenChamberSession(session.id, useConfigStore.getState().agents ?? []);
        }

        if (!sessionId) {
          return;
        }

        const selectionState = useSelectionStore.getState();
        selectionState.saveSessionModelSelection(sessionId, execution.providerID, execution.modelID);
        if (execution.agent.trim()) {
          selectionState.saveSessionAgentSelection(sessionId, execution.agent);
          selectionState.saveAgentModelForSession(sessionId, execution.agent, execution.providerID, execution.modelID);
          selectionState.saveAgentModelVariantForSession(
            sessionId,
            execution.agent,
            execution.providerID,
            execution.modelID,
            execution.variant || undefined,
          );
        }

        setCurrentSession(sessionId, directoryHint);
        await sendMessage(
          visiblePrompt,
          execution.providerID,
          execution.modelID,
          execution.agent.trim() || undefined,
          undefined,
          undefined,
          syntheticParts,
          execution.variant || undefined,
        );

        toast.success(
          pendingSendTarget.kind === 'worktree'
            ? t('rightSidebar.contextNotesTodo.toast.sentToNewWorktreeSession')
            : t('rightSidebar.contextNotesTodo.toast.sentToNewSession')
        );
        setPendingSendTarget(null);
        onActionComplete?.();
      } catch (error) {
        const description = error instanceof Error ? error.message : undefined;
        toast.error(t('rightSidebar.contextNotesTodo.toast.sendTodoFailed'), description ? { description } : undefined);
      } finally {
        setIsSubmitting(false);
        setSendingTodoId(null);
      }
    },
    [canCreateWorktree, createSession, initializeNewOpenChamberSession, onActionComplete, pendingSendTarget, projectRef, routeToChat, sendMessage, setCurrentSession, t]
  );

  const closeDialog = React.useCallback(() => {
    if (!isSubmitting) {
      setPendingSendTarget(null);
    }
  }, [isSubmitting]);

  return {
    pendingSendTarget,
    isSubmitting,
    sendingTodoId,
    sendToCurrentSession,
    sendToNewSession,
    sendToNewWorktreeSession,
    confirmSend,
    closeDialog,
  };
};
