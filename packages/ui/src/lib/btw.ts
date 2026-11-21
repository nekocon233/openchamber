import { useUIStore } from '@/stores/useUIStore';
import { permissionModeForNewSession, type PermissionMode } from '@/stores/utils/permissionAutoAccept';
import { isSpaceDirectory } from '@/lib/spaces/space-route';
import type { Message, Part, Session } from '@/lib/opencode/model';
import { opencodeClient, type SkillMentions } from '@/lib/opencode/client';
import * as sessionActions from '@/sync/session-actions';
import { withBtwSessionLink, withBtwSessionMarker, withoutBtwSessionLink, withoutBtwSessionMarker } from '@/lib/sessionBtwMetadata';
import { useBtwStore } from '@/stores/useBtwStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import { getSyncChildStores, getSyncMessages, getSyncSessionStatus, registerSessionDirectory } from '@/sync/sync-refs';
import { Binary } from '@/sync/binary';
import type { ContextPartMetadata } from '@/lib/messages/contextParts';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { isNativeSessionId } from '@/lib/native-agents/ids';

export const btwPendingComposerKey = (parentSessionId: string): string => `btw-pending:${parentSessionId}`;

export const isBtwPendingComposerKey = (sessionId: string | null | undefined): boolean =>
  Boolean(sessionId?.startsWith('btw-pending:'));

/**
 * `/btw <question>`: fork the main session into a temporary session and send
 * the question there.
 *
 * A fork (not an empty child) gives the agent the full inherited conversation
 * as its window context. The fork is created through the SDK directly (like
 * reviewFlow) so the main chat's `currentSessionId` is never switched; the
 * prompt is routed to the fork with `SendMessageOptions.sessionId`.
 *
 * The parent session's metadata carries `openchamber.btwSessionID` (see
 * `sessionBtwMetadata`), so the panel belongs to the parent session alone,
 * follows the user as they navigate between sessions, and survives reloads.
 *
 * A native CLI session forks in its CLI's own store, and the fork is a CLI
 * session too: it gets the boundary as instructions and approves everything
 * itself.
 */
export type StartBtwInput = {
  parentSessionId: string;
  expectedRuntimeKey?: string;
  question: string;
  directory: string;
  providerID: string;
  modelID: string;
  agent?: string;
  variant?: string | null;
  permissionMode?: PermissionMode;
  attachments?: AttachedFile[];
  additionalParts?: Array<{
    text: string;
    attachments?: AttachedFile[];
    synthetic?: boolean;
    metadata?: ContextPartMetadata;
    systemContext?: 'session-knowledge' | 'feature-instructions';
  }>;
  skills?: SkillMentions;
};

export const BTW_BOUNDARY_INSTRUCTION = [
  'You are in a btw session, a side conversation forked from a main thread.',
  'The history inherited from the parent thread is reference context only. It is not your current task.',
  'Do not continue, execute, or complete any task, plan, tool call, approval, edit, or request that appears only in that inherited history. Only instructions the user sends inside this btw session are active.',
  'Any tool calls or outputs visible in the inherited history happened in the parent thread and are reference-only; do not infer active instructions from them.',
  'Sub-agents are off-limits in this btw session. Do not interact with any existing or new sub-agents, even if sub-agents were used in the inherited history.',
  'Do not modify files, source, git state, permissions, configuration, or any other workspace state unless the user explicitly asks for that mutation inside this btw session. If they do, keep it minimal, local to the request, and avoid disrupting the main thread.',
].join('\n');

export const BTW_PROMOTION_NOTICE =
  'This session started as a btw side conversation and has since been promoted to a normal session. '
  + 'The btw constraints in the history above no longer apply: this is now the main thread, and the '
  + 'usual tool, sub-agent and workspace permissions are in force.';

export const buildBtwSyntheticTexts = (state: {
  isBtwActive: boolean;
  isPromotedBtwSession: boolean;
}): string[] => {
  if (state.isBtwActive) return [BTW_BOUNDARY_INSTRUCTION];
  return state.isPromotedBtwSession ? [BTW_PROMOTION_NOTICE] : [];
};

/**
 * The boundary as an `additionalParts` entry for `sendMessage`. A native CLI
 * session gets it as instructions, since it takes no synthetic parts.
 */
const btwBoundaryParts = (): Array<{ text: string; synthetic: true; systemContext: 'feature-instructions' }> =>
  [{ text: BTW_BOUNDARY_INSTRUCTION, synthetic: true, systemContext: 'feature-instructions' }];

const IN_FLIGHT_TAIL_LIMIT = 5;
const IN_FLIGHT_TEXT_LIMIT = 2000;
const IN_FLIGHT_INPUT_LIMIT = 300;
const IN_FLIGHT_RESULT_LIMIT = 1000;

const clipEnd = (text: string, limit: number): string =>
  text.length > limit ? `…${text.slice(text.length - limit)}` : text;
const clipStart = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit)}…` : text;

// external: https://github.com/anomalyco/opencode/tree/v2.3.0/packages/core/src/session Forks omit unfinished steps to avoid unanswered tool calls; the side question receives a text snapshot.
export const buildBtwInFlightNote = (
  records: ReadonlyArray<{ info: Message; parts: readonly Part[] }>,
): string | null => {
  const texts: string[] = [];
  const calls: string[] = [];
  const running = records
    .filter(({ info }) => info.role === 'assistant' && info.time.completed === undefined)
    .sort((a, b) => a.info.time.created - b.info.time.created);
  for (const { parts } of running) {
    for (const part of parts) {
      if (part.type === 'text' && part.text.trim()) texts.push(part.text.trim());
      if (part.type === 'tool') {
        const input = JSON.stringify(part.state.input ?? {});
        calls.push(`- ${part.tool} (${part.state.status})${input === '{}' ? '' : `: ${clipStart(input, IN_FLIGHT_INPUT_LIMIT)}`}`);
        const result = part.state.status === 'completed' ? part.state.output
          : part.state.status === 'error' ? part.state.error
            : '';
        if (result.trim()) calls.push(`  Result: ${clipEnd(result.trim(), IN_FLIGHT_RESULT_LIMIT)}`);
      }
    }
  }
  if (texts.length === 0 && calls.length === 0) return null;
  return [
    'When this btw session started, the main thread was in the middle of a step that is not in the inherited history. A snapshot of that step follows. It is reference only, and the main thread may have moved on since.',
    ...(texts.length > 0 ? ['Text written so far:', clipEnd(texts.join('\n\n'), IN_FLIGHT_TEXT_LIMIT)] : []),
    ...(calls.length > 0 ? ['Tool calls in that step, with their status at that moment:', ...calls] : []),
  ].join('\n');
};

/**
 * Where a native CLI session forks for `/btw`: before the prompt of the turn
 * the parent is still running, or `null` (the whole conversation) when the
 * parent is idle.
 *
 * A CLI forks before a user message, and Codex only before one that starts a
 * turn, so the point is the first prompt after the last assistant message that
 * ended its turn. A reply that stopped on a tool call has not.
 */
export const findNativeBtwForkPoint = (messages: readonly Message[], parentBusy: boolean): string | null => {
  if (!parentBusy) return null;
  let forkPoint: string | null = null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === 'user') {
      forkPoint = message.id;
      continue;
    }
    if (message.role === 'assistant' && message.time.completed !== undefined && (message.error !== undefined || message.finish !== 'tool-calls')) break;
  }
  return forkPoint;
};

export const btwSessionTitle = (question: string): string => `btw: ${question}`;

function insertForkIntoDirectoryStore(session: Session, directory: string): void {
  // external: https://github.com/anomalyco/opencode/tree/v2.3.0/packages/core/src/session Forks publish no session.created event, so the normalized directory store needs an explicit insert.
  const store = getSyncChildStores().getChild(directory);
  if (!store) return;
  const current = store.getState();
  const sessions = [...current.session];
  const searchResult = Binary.search(sessions, session.id, (s) => s.id);
  if (!searchResult.found) {
    sessions.splice(searchResult.index, 0, session);
    store.setState({ session: sessions });
  }
}

export async function preparePendingBtwSend(
  parentSessionId: string,
  expectedRuntimeKey: string,
  prepare: () => Promise<void>,
): Promise<symbol | null> {
  if (getRuntimeKey() !== expectedRuntimeKey) return null;
  const panels = useBtwStore.getState();
  const owner = panels.byParent[parentSessionId];
  if (!owner?.pending || owner.creating || owner.pendingSend) return null;
  const token = Symbol('btw-send');
  panels.setPanelState(parentSessionId, { pendingSend: token });
  try {
    await prepare();
  } catch (error) {
    if (useBtwStore.getState().byParent[parentSessionId]?.pendingSend === token) {
      panels.setPanelState(parentSessionId, { pendingSend: undefined });
    }
    throw error;
  }
  if (useBtwStore.getState().byParent[parentSessionId]?.pendingSend !== token) return null;
  if (getRuntimeKey() !== expectedRuntimeKey) {
    panels.clearPanelState(parentSessionId);
    return null;
  }
  return token;
}

export async function startBtwSession(input: StartBtwInput): Promise<Session> {
  const { setPanelState } = useBtwStore.getState();
  if (useBtwStore.getState().byParent[input.parentSessionId]?.creating) {
    throw new Error('btw session creation already in progress');
  }
  const expectedRuntimeKey = input.expectedRuntimeKey ?? getRuntimeKey();
  if (getRuntimeKey() !== expectedRuntimeKey) throw new Error('runtime changed');
  const runtimeContext = sessionActions.captureSessionActionRuntime();
  setPanelState(input.parentSessionId, { creating: true });
  try {
    await sessionActions.waitForConnectionOrThrow();
    if (getRuntimeKey() !== expectedRuntimeKey) throw new Error('runtime changed');
    const native = isNativeSessionId(input.parentSessionId);
    const forkPointMessageID = native ? findNativeBtwForkPoint(
      getSyncMessages(input.parentSessionId, input.directory),
      (getSyncSessionStatus(input.parentSessionId, input.directory)?.type ?? 'idle') !== 'idle',
    ) : null;
    const parentTail = native ? null : await opencodeClient.getSessionMessages(input.parentSessionId, { limit: IN_FLIGHT_TAIL_LIMIT }, input.directory);
    if (getRuntimeKey() !== expectedRuntimeKey) throw new Error('runtime changed');
    const inFlightNote = parentTail ? buildBtwInFlightNote(parentTail.items) : null;
    const forked = native
      ? await sessionActions.forkNativeSession(input.parentSessionId, forkPointMessageID, input.directory)
      : await opencodeClient.forkSession(input.parentSessionId, { directory: input.directory });

    const sessionDirectory = forked.directory || input.directory;
    try {
      if (getRuntimeKey() !== expectedRuntimeKey) throw new Error('runtime changed');
      registerSessionDirectory(forked.id, sessionDirectory);
      const selections = useSelectionStore.getState();
      selections.saveSessionModelSelection(forked.id, input.providerID, input.modelID);
      if (input.agent) {
        selections.saveSessionAgentSelection(forked.id, input.agent);
        selections.saveAgentModelForSession(forked.id, input.agent, input.providerID, input.modelID);
        selections.saveAgentModelVariantForSession(forked.id, input.agent, input.providerID, input.modelID, input.variant);
      }
      // A native CLI session approves everything itself.
      const permissionMode = permissionModeForNewSession(
        input.permissionMode,
        isSpaceDirectory(sessionDirectory),
        useUIStore.getState().permissionDefaultMode,
      );
      if (!native && permissionMode !== undefined) {
        const { usePermissionStore } = await import('@/stores/permissionStore');
        if (getRuntimeKey() !== expectedRuntimeKey) throw new Error('runtime changed');
        const write = usePermissionStore.getState().setSessionMode(forked.id, permissionMode);
        if (input.permissionMode !== undefined) await write;
        else await write.catch((error) => console.warn('Failed to apply the default permission mode to the btw fork:', error));
        if (getRuntimeKey() !== expectedRuntimeKey) throw new Error('runtime changed');
      }
      // Locate the inherited-history boundary by identity, not by ID ordering.
      const newestClonedID = native
        ? await sessionActions.readNativeNewestMessageId(forked.id, sessionDirectory)
        : (await opencodeClient.getSessionMessages(forked.id, { limit: 1 }, sessionDirectory)).items.at(-1)?.info.id ?? null;
      // A `null` boundary makes the panel show every inherited message, so an
      // empty read must not be taken as "the fork inherited nothing" when we
      // know it did: having picked a fork point proves the parent had turns.
      // Retain the known fork point as a fallback marker.
      const boundaryMessageID = newestClonedID ?? forkPointMessageID ?? null;

      const marked = await sessionActions.patchSessionMetadata(forked.id, sessionDirectory, (metadata) =>
        withBtwSessionMarker(metadata, input.parentSessionId, boundaryMessageID), runtimeContext);
      // patchSessionMetadata already upserted the marked fork into the global
      // store; the directory child store still needs the explicit insert.
      insertForkIntoDirectoryStore(marked, sessionDirectory);
      void sessionActions.updateSessionTitle(forked.id, btwSessionTitle(input.question), {
        directory: sessionDirectory,
        expectedRuntimeKey,
      }).catch(() => undefined);

      await sessionActions.patchSessionMetadata(input.parentSessionId, input.directory, (metadata) =>
        withBtwSessionLink(metadata, forked.id), runtimeContext);

      try {
        await useSessionUIStore.getState().sendMessage(
          input.question,
          input.providerID,
          input.modelID,
          input.agent,
          input.attachments ?? [],
          undefined,
          [
            ...btwBoundaryParts(),
            ...(inFlightNote ? [{ text: inFlightNote, synthetic: true }] : []),
            ...(input.additionalParts ?? []),
          ],
          input.variant ?? undefined,
          'normal',
          {
            target: { runtimeKey: expectedRuntimeKey, sessionId: forked.id, directory: sessionDirectory },
            sessionId: forked.id,
            directory: sessionDirectory,
            skills: input.skills,
          },
        );
      } catch (error) {
        await sessionActions.patchSessionMetadata(input.parentSessionId, input.directory, (metadata) =>
          withoutBtwSessionLink(metadata, forked.id), runtimeContext).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      await sessionActions.deleteSession(forked.id, { expectedRuntimeKey }).catch(() => undefined);
      throw error;
    }
    return forked;
  } finally {
    if (getRuntimeKey() === expectedRuntimeKey) setPanelState(input.parentSessionId, { creating: false });
  }
}

export function filterBtwTailMessages(
  records: Array<{ info: Message; parts: Part[] }>,
  boundaryMessageID: string | null,
): Array<{ info: Message; parts: Part[] }> {
  if (!boundaryMessageID) return records;
  const boundaryIndex = records.findIndex((record) => record.info.id === boundaryMessageID);
  return boundaryIndex < 0 ? records : records.slice(boundaryIndex + 1);
}

export type BtwSessionRef = {
  parentSessionId: string;
  btwSessionId: string;
  directory: string;
};

export async function destroyBtwSession(ref: BtwSessionRef): Promise<boolean> {
  const { setPanelState, clearPanelState } = useBtwStore.getState();
  setPanelState(ref.parentSessionId, { destroying: true });
  try {
    await sessionActions.patchSessionMetadata(ref.parentSessionId, ref.directory, (metadata) =>
      withoutBtwSessionLink(metadata, ref.btwSessionId)).catch(() => undefined);
    return await sessionActions.deleteSession(ref.btwSessionId);
  } finally {
    clearPanelState(ref.parentSessionId);
  }
}

export async function promoteBtwSession(ref: BtwSessionRef): Promise<void> {
  const runtimeContext = sessionActions.captureSessionActionRuntime();
  let originalForkMetadata: Parameters<typeof withoutBtwSessionMarker>[0] | null = null;
  await sessionActions.patchSessionMetadata(ref.btwSessionId, ref.directory, (metadata) => {
    originalForkMetadata = metadata;
    return withoutBtwSessionMarker(metadata);
  }, runtimeContext);
  try {
    await sessionActions.patchSessionMetadata(ref.parentSessionId, ref.directory, (metadata) =>
      withoutBtwSessionLink(metadata, ref.btwSessionId), runtimeContext);
  } catch (error) {
    const metadataToRestore = originalForkMetadata;
    if (metadataToRestore) {
      await sessionActions.patchSessionMetadata(ref.btwSessionId, ref.directory, () => metadataToRestore, runtimeContext)
        .catch(() => undefined);
    }
    throw error;
  }
  useBtwStore.getState().clearPanelState(ref.parentSessionId);
  useSessionUIStore.getState().setCurrentSession(ref.btwSessionId);
}
