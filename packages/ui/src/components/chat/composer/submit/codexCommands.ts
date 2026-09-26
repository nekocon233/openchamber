import { listModelVariantIds } from '@/lib/modelVariants';
import type { NativeAgentsAPI, NativeCodexCommandResult } from '@/lib/api/types';
import type { useI18n } from '@/lib/i18n';
import { copyTextToClipboard } from '@/lib/clipboard';
import { CODEX_COMMAND_USAGE, codexFastVariant, codexReviewTarget, type CodexComposerCommand } from '@/lib/native-agents/codex-commands';
import { NATIVE_PROVIDER_CODEX } from '@/lib/native-agents/ids';
import { useConfigStore } from '@/stores/useConfigStore';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';
import { useSelectionStore } from '@/sync/selection-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { forkNativeSession } from '@/sync/session-actions';
import { getSyncMessages, getSyncParts } from '@/sync/sync-refs';

type CommandOutput = Extract<NativeCodexCommandResult, { kind: 'output' }>;
type CommandResult =
  | { kind: 'done' }
  | { kind: 'prompt'; text: string; agent: 'plan' }
  | { kind: 'rewrite'; text: string }
  | { kind: 'edit'; text: string }
  | CommandOutput;

type CommandContext = {
  sessionId: string | null;
  directory: string;
  model: string;
  variant: string | undefined;
  agent: string;
  api: NativeAgentsAPI;
  t: ReturnType<typeof useI18n>['t'];
  isCurrent: () => boolean;
  openModelMenu: () => void;
};

export const executeCodexComposerCommand = async (
  command: CodexComposerCommand,
  context: CommandContext,
): Promise<CommandResult> => {
  const { sessionId, directory, model, variant, agent, api, t, isCurrent } = context;
  const { name, argument } = command;
  const initialSelection = useConfigStore.getState();
  const invalid = () => new Error(t('chat.codexCommand.invalid', { command: CODEX_COMMAND_USAGE.get(name) ?? `/${name}` }));
  const requireSession = () => {
    if (!sessionId) throw new Error(t('chat.codexCommand.needsSession'));
    return sessionId;
  };
  const noArguments = () => { if (argument) throw invalid(); };
  const setSelection = (nextModel: string, nextVariant: string | undefined, nextAgent = agent) => {
    if (!isCurrent()) return;
    const config = useConfigStore.getState();
    if (config.currentProviderId !== initialSelection.currentProviderId
      || config.currentModelId !== initialSelection.currentModelId
      || config.currentVariant !== initialSelection.currentVariant
      || config.currentVariantSelection.override !== initialSelection.currentVariantSelection.override
      || config.currentAgentName !== initialSelection.currentAgentName) return;
    const selections = useSelectionStore.getState();
    config.setAgent(nextAgent);
    config.setProvider(NATIVE_PROVIDER_CODEX);
    config.setModel(nextModel);
    config.setCurrentVariantOverride(nextVariant ?? null, undefined);
    if (sessionId) {
      selections.saveSessionAgentSelection(sessionId, nextAgent);
      selections.saveSessionModelSelection(sessionId, NATIVE_PROVIDER_CODEX, nextModel);
      selections.saveAgentModelForSession(sessionId, nextAgent, NATIVE_PROVIDER_CODEX, nextModel);
      selections.saveAgentModelVariantForSession(sessionId, nextAgent, NATIVE_PROVIDER_CODEX, nextModel, nextVariant ?? null);
    }
  };

  switch (name) {
    case 'model':
    case 'reasoning': {
      if (!argument) { context.openModelMenu(); break; }
      const models = useConfigStore.getState().providers.find((provider) => provider.id === NATIVE_PROVIDER_CODEX)?.models ?? [];
      const [requestedModel, effort, extra] = argument.split(/\s+/);
      if (extra || (name === 'reasoning' && effort)) throw invalid();
      const nextModel = models.find((entry) => entry.id === (name === 'model' ? requestedModel : model));
      if (!nextModel) throw invalid();
      const nextVariant = name === 'reasoning' ? requestedModel : effort;
      if (nextVariant && !listModelVariantIds(nextModel.variants).includes(nextVariant)) throw invalid();
      setSelection(nextModel.id, nextVariant);
      break;
    }
    case 'fast': {
      const current = useConfigStore.getState().providers.find((provider) => provider.id === NATIVE_PROVIDER_CODEX)?.models.find((entry) => entry.id === model);
      let effort = variant;
      if (effort === undefined) {
        const catalog = (await api.catalog()).backends.codex;
        if (catalog.status === 'error') throw new Error(catalog.message);
        effort = catalog.models.find((entry) => entry.id === model)?.defaultEffort ?? undefined;
      }
      const next = codexFastVariant(listModelVariantIds(current?.variants), effort, argument);
      if (next === null) throw invalid();
      setSelection(model, next);
      break;
    }
    case 'plan':
      setSelection(model, variant, 'plan');
      if (argument) return { kind: 'prompt', text: argument, agent: 'plan' };
      break;
    case 'new':
    case 'clear':
      noArguments();
      useSessionUIStore.getState().openNewSessionDraft({ directoryOverride: directory });
      // The new draft's defaults must not turn a Codex command into an OpenCode session.
      useConfigStore.getState().setProvider(NATIVE_PROVIDER_CODEX);
      useConfigStore.getState().setModel(model);
      break;
    case 'resume': {
      if (argument) {
        if (!/^(?:ncx_)?[a-zA-Z0-9_-]+$/.test(argument)) throw invalid();
        const session = await api.getSession(argument.startsWith('ncx_') ? argument : `ncx_${argument}`, directory);
        if (isCurrent()) useSessionUIStore.getState().setCurrentSession(session.id, session.directory);
        break;
      }
      const ui = useUIStore.getState();
      if (ui.isMobile) ui.setSessionSwitcherOpen(true);
      else if (ui.isSidebarOpen) window.dispatchEvent(new CustomEvent('openchamber:sidebar-session-search'));
      else ui.setSessionDropdownOpen(true);
      break;
    }
    case 'agent':
    case 'subagents': {
      noArguments();
      const history = await api.loadMessages(requireSession(), directory, { limit: 1 });
      return {
        kind: 'output', notices: [],
        entries: history.childSessions.map((session) => ({ label: session.title, detail: session.id, command: `/resume ${session.id}` })),
      };
    }
    case 'archive':
      noArguments();
      if (!await useSessionUIStore.getState().archiveSession(requireSession())) throw new Error(t('chat.codexCommand.failed'));
      break;
    case 'exit':
    case 'quit':
      noArguments();
      await api.abort(requireSession());
      if (isCurrent()) useSessionUIStore.getState().setCurrentSession(null);
      break;
    case 'diff':
      noArguments();
      useUIStore.getState().openContextSurface(normalizeContextPanelDirectoryKey(directory), 'git');
      break;
    case 'mention':
      return { kind: 'edit', text: `@${argument}` };
    case 'fork': {
      noArguments();
      const session = await forkNativeSession(requireSession(), null, directory);
      if (isCurrent()) useSessionUIStore.getState().setCurrentSession(session.id, session.directory);
      break;
    }
    case 'rename':
      if (!argument || argument.length > 200) throw invalid();
      await useSessionUIStore.getState().updateSessionTitle(requireSession(), argument);
      break;
    case 'status':
      noArguments();
      return {
        kind: 'output', notices: [],
        entries: [
          { label: 'threadId', detail: sessionId?.replace(/^ncx_/, '') ?? '—' },
          { label: 'cwd', detail: directory },
          { label: 'model', detail: model },
          { label: 'effort', detail: variant?.replace(/-fast$/, '') ?? t('chat.modelControls.default') },
          { label: 'serviceTier', detail: variant?.endsWith('-fast') ? 'priority' : 'default' },
          { label: 'mode', detail: agent },
          { label: 'approvalPolicy', detail: 'never' },
          { label: 'sandbox', detail: 'danger-full-access' },
        ],
      };
    case 'skills':
      noArguments();
      return api.codexCommand({ name, directory, sessionId: sessionId ?? undefined }).then((result) => result.kind === 'accepted' ? { kind: 'done' } : result);
    case 'mcp': {
      if (argument && argument !== 'verbose') throw invalid();
      const result = await api.codexCommand({ name, directory, sessionId: requireSession(), verbose: argument === 'verbose' });
      return result.kind === 'accepted' ? { kind: 'done' } : result;
    }
    case 'ps':
    case 'stop': {
      noArguments();
      const result = await api.codexCommand({ name, directory, sessionId: requireSession() });
      return result.kind === 'accepted' ? { kind: 'done' } : result;
    }
    case 'review': {
      const target = codexReviewTarget(argument);
      if (!target) throw invalid();
      await api.codexCommand({ name, directory, sessionId: requireSession(), model, variant, target });
      break;
    }
    case 'init':
      return { kind: 'rewrite', text: `/init${argument ? ` ${argument}` : ''}` };
    case 'side':
      requireSession();
      return { kind: 'rewrite', text: `/btw${argument ? ` ${argument}` : ''}` };
    case 'copy': {
      noArguments();
      const messages = getSyncMessages(requireSession(), directory);
      const reply = [...messages].reverse().find((message) => message.role === 'assistant' && Boolean(message.time.completed) && !message.summary);
      if (!reply) throw invalid();
      const text = getSyncParts(reply.id, directory).filter((part) => part.type === 'text' && !part.synthetic).map((part) => part.type === 'text' ? part.text : '').join('\n\n');
      if (!text || !(await copyTextToClipboard(text)).ok) throw invalid();
      break;
    }
  }
  return { kind: 'done' };
};
