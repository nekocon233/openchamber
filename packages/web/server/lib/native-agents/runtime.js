// Native CLI sessions: OpenChamber as a frontend for Claude Code and Codex.
//
// The CLIs own their sessions; this runtime reads them, projects them into
// the records the UI renders, drives turns, and publishes live changes as the
// events OpenCode sessions produce. Each backend is independent: one that
// cannot be read reports its own failure and never hides or blocks the other.
//
// Reverts follow OpenCode's model (see revert.js): files go back at once, a
// session record carries `revert` while the revert can be undone, and the
// next prompt commits it by rewinding the CLI's conversation.

import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { z } from 'zod';

import { claudeModels, codexVariantSettings } from './catalog.js';
import { createClaudeLiveSessions } from './claude/live.js';
import { loadClaudeSdk } from './claude/sdk.js';
import { createClaudeSessionStore } from './claude/store.js';
import { claudeConfigDir, readClaudeTaskList } from './claude/tasks.js';
import { createCodexAppServer } from './codex/app-server.js';
import { createCodexCatalog } from './codex/catalog.js';
import { createCodexLiveThreads } from './codex/live.js';
import { createCodexSessionStore } from './codex/store.js';
import { createCodexUtility } from './codex/utility.js';
import {
  invalidRequestError,
  NativeAgentError,
  revertFirstMessageError,
  sessionBusyError,
  sessionNotFoundError,
} from './errors.js';
import {
  claudeUserMessageId,
  decodeNativeSessionId,
  encodeClaudeSessionId,
  encodeCodexSessionId,
  NATIVE_BACKEND_CLAUDE,
  NATIVE_BACKEND_CODEX,
  nativeBackendOfProviderId,
} from './ids.js';
import { claudePromptBlocks, codexPromptInput, withInstructions } from './prompt-parts.js';
import { createNativeEventPublisher } from './publisher.js';
import { createQuestionRegistry } from './questions.js';
import { unconfirmedSessionRecord } from './records.js';
import { createNativeRegistry } from './registry.js';
import { createNativeReverts } from './revert.js';
import { createSnapshotStore } from './snapshots.js';

const CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const STOP_TIMEOUT_MS = 10_000;
// Listing Claude Code's commands starts a CLI process; the list changes only
// with the user's and the project's skills and commands.
const COMMANDS_CACHE_MS = 10 * 60_000;
const threadResponseSchema = z.object({
  thread: z.object({ id: z.string() }).passthrough(),
  // The tier the thread starts on; absent for the standard tier.
  serviceTier: z.string().nullish(),
}).passthrough();

const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

const settled = async (promise) => {
  try {
    return { status: 'ok', value: await promise };
  } catch (error) {
    return { status: 'error', message: errorMessage(error) };
  }
};

// Live records replace history records with the same id; records only a
// running turn knows about yet join in creation order.
const overlay = (history, live) => {
  if (!live || live.length === 0) return history;
  const liveById = new Map(live.map((record) => [record.info.id, record]));
  const merged = history.map((record) => liveById.get(record.info.id) ?? record);
  const known = new Set(history.map((record) => record.info.id));
  for (const record of live) if (!known.has(record.info.id)) merged.push(record);
  return merged
    .map((record, index) => ({ record, index }))
    .sort((left, right) => (left.record.info.time.created - right.record.info.time.created) || (left.index - right.index))
    .map(({ record }) => record);
};

// A committed revert the transcript does not show yet: for the user, the
// reverted prompt and everything after it are gone already.
const untilRewound = (records, pending) => {
  if (pending?.phase !== 'committed') return records;
  const index = records.findIndex((record) => record.info.id === pending.messageId);
  return index === -1 ? records : records.slice(0, index);
};

/**
 * @typedef {{ type: 'text', text: string } | { type: 'file', mime: string, url: string, filename?: string }} PromptPart
 * @typedef {{ directory: string, messageID: string, parts: PromptPart[], model: { providerID: string, modelID: string }, variant?: string, agent: 'build' | 'plan' }} PromptRequest
 */

/**
 * @param {object} options
 * @param {string} options.dataDir OpenChamber data directory
 * @param {(cli: 'claude' | 'codex') => Promise<string | null>} options.resolveExecutable
 * @param {() => Record<string, string>} options.buildChildEnv
 * @param {string} options.clientVersion OpenChamber version reported to the CLIs
 * @param {(event: { directory: string, payload: object }) => void} options.publishNativeEvent
 * @param {() => Promise<import('@anthropic-ai/claude-agent-sdk')>} [options.loadSdk]
 * @param {() => number} [options.now]
 */
const openChamberNamespace = z.record(z.string(), z.unknown()).catch({});

/** The `openchamber` namespace of stored session metadata; empty when absent or malformed. */
const storedOpenChamber = (metadata) => openChamberNamespace.parse(metadata.openchamber ?? {});

/** Metadata as a client sent it, minus `openchamber.native`, which only the server writes. */
const withoutServerMetadata = (metadata) => {
  const namespace = storedOpenChamber(metadata);
  delete namespace.native;
  return { ...metadata, openchamber: namespace };
};

export const createNativeAgentsRuntime = ({
  dataDir,
  resolveExecutable,
  buildChildEnv,
  clientVersion,
  publishNativeEvent,
  // The global instructions every CLI session gets (OpenChamber's global AGENTS.md).
  readGlobalInstructions = async () => null,
  loadSdk = loadClaudeSdk,
  now = Date.now,
}) => {
  const registry = createNativeRegistry({ filePath: path.join(dataDir, 'native-agents', 'registry.json'), now });
  const reverts = createNativeReverts({ registry, snapshots: createSnapshotStore({ dataDir }) });
  const publisher = createNativeEventPublisher({ publishNativeEvent, now });
  const questions = createQuestionRegistry({
    publish: (directory, payload) => publisher.emit(directory, payload.type, payload.properties),
  });

  // The functions below run only after a turn or a request, once every store
  // further down exists.

  // Session records carry a revert that can still be undone the way
  // OpenCode's do, so the UI hides the reverted messages and offers them back.
  const withRevert = async (record) => {
    const pending = await reverts.pending(record.id);
    return pending?.phase === 'pending' ? { ...record, revert: { messageID: pending.messageId } } : record;
  };

  // OpenChamber's own metadata for a session lives in the registry; records
  // carry it as OpenCode sessions carry theirs. `openchamber.native` is the
  // server's and always wins.
  const withMetadata = async (record) => {
    const stored = (await registry.getSession(record.id))?.metadata;
    if (!stored) return record;
    const storedNamespace = storedOpenChamber(stored);
    return {
      ...record,
      metadata: { ...stored, openchamber: { ...storedNamespace, native: record.metadata.openchamber.native } },
    };
  };

  const decorate = async (record) => withMetadata(await withRevert(record));

  // OpenChamber's own notes about a session need a registry entry; a session
  // the CLI created gets one the first time. Metadata is written only for a
  // session the user has open, so the CLI has recorded it by then.
  const adoptSession = (sessionId, directory) => {
    const decoded = decodeOwnSession(sessionId);
    const createdAt = now();
    return registry.registerSession(sessionId, {
      backend: decoded.backend,
      nativeId: decoded.backend === NATIVE_BACKEND_CLAUDE ? decoded.sessionUuid : decoded.threadId,
      directory,
      origin: 'adopted',
      createdAt,
      confirmedAt: createdAt,
    });
  };

  const publishSession = async (sessionId, directory) => {
    const session = await storeFor(sessionId).getSession(sessionId, directory);
    if (!session) return null;
    const record = await decorate(session);
    publisher.session(directory, record, { created: false });
    return record;
  };

  // A committed Claude revert ends once the conversation the CLI resumes no
  // longer holds the reverted prompt. Returns the revert still in effect.
  const settleClaudeRewind = async (sessionId, directory) => {
    const pending = await reverts.pending(sessionId);
    if (pending?.phase !== 'committed') return pending;
    if (await claude.chainHolds(sessionId, directory, pending.messageId)) return pending;
    await reverts.finishCommit(sessionId);
    return null;
  };

  // A finished turn confirms a session OpenChamber created and changes its
  // record (title from the first prompt, update time), which goes out the way
  // OpenCode announces a session after each message. A Claude session given a
  // title at creation gets it written to its new transcript, whose title wins
  // from then on.
  const onTurnFinished = (sessionId, directory) => {
    void (async () => {
      try {
        const entry = await registry.getSession(sessionId);
        await registry.confirmSession(sessionId);
        if (decode(sessionId).backend === NATIVE_BACKEND_CLAUDE) {
          if (entry?.confirmedAt === undefined && entry?.title !== undefined) await claude.rename(sessionId, directory, entry.title);
          await settleClaudeRewind(sessionId, directory);
        }
        await publishSession(sessionId, directory);
      } catch (error) {
        console.warn('[native-agents] could not refresh the session after a turn:', sessionId, errorMessage(error));
      }
    })();
  };

  // What the turns changed on disk, for reverting them.
  const onIdle = (sessionId) => {
    void reverts.afterTurn(sessionId);
  };

  // The app-server and the live threads call each other; the live threads
  // exist before the app-server can deliver anything.
  let codexLive = null;
  const codexCatalog = createCodexCatalog({ request: (method, params) => appServer.request(method, params), buildEnv: buildChildEnv });
  const codexUtility = createCodexUtility({ request: (method, params) => appServer.request(method, params), catalog: codexCatalog });
  const appServer = createCodexAppServer({
    resolveExecutable: () => resolveExecutable('codex'),
    buildEnv: buildChildEnv,
    onNotification: (method, params) => {
      if (!codexUtility.handleNotification(method, params)) codexLive.handleNotification(method, params);
    },
    onServerRequest: (method, params) => {
      if (codexUtility.ownsRequest(params)) return Promise.reject(new Error('Tools are unavailable for utility generation'));
      return codexLive.handleServerRequest(method, params);
    },
    onExit: (error) => {
      codexUtility.handleExit(error);
      codexLive.handleExit(errorMessage(error));
    },
    clientVersion,
  });
  codexLive = createCodexLiveThreads({
    request: (method, params) => appServer.request(method, params),
    readGlobalInstructions,
    publisher,
    questions,
    onTurnFinished,
    onIdle,
    now,
  });
  const claude = createClaudeSessionStore({ loadSdk, registry });
  const codex = createCodexSessionStore({ appServer, registry, readGlobalInstructions });
  const claudeLive = createClaudeLiveSessions({
    loadSdk,
    resolveExecutable: () => resolveExecutable('claude'),
    buildEnv: buildChildEnv,
    readGlobalInstructions,
    hasTranscript: claude.hasTranscript,
    publisher,
    questions,
    onTurnFinished,
    onIdle,
    readTaskList: (sessionUuid) => readClaudeTaskList({ configDir: claudeConfigDir(buildChildEnv()), sessionUuid }),
    now,
  });

  const decode = (sessionId) => {
    const decoded = decodeNativeSessionId(sessionId);
    if (!decoded) throw invalidRequestError(`Not a native session id: ${sessionId}`);
    return decoded;
  };
  // A Claude subagent session is part of its parent's transcript, so it
  // cannot be renamed, archived or deleted on its own.
  const decodeOwnSession = (sessionId) => {
    const decoded = decode(sessionId);
    if (decoded.backend === NATIVE_BACKEND_CLAUDE && decoded.toolUseId !== null) {
      throw invalidRequestError('A Claude Code subagent session belongs to its parent session');
    }
    return decoded;
  };
  const storeFor = (sessionId) => (decode(sessionId).backend === NATIVE_BACKEND_CLAUDE ? claude : codex);
  const liveFor = (sessionId) => (decode(sessionId).backend === NATIVE_BACKEND_CLAUDE ? claudeLive : codexLive);

  // Runs the step that hands a prompt to the CLI. A pending revert counts as
  // committed from the start, so a history read meanwhile already leaves the
  // reverted messages out, and goes back to pending if the step fails.
  const committing = async (sessionId, directory, pending, step) => {
    if (pending?.phase !== 'pending') {
      await step();
      return;
    }
    await reverts.beginCommit(sessionId);
    try {
      await step();
    } catch (error) {
      await reverts.cancelCommit(sessionId);
      await publishSession(sessionId, directory);
      throw error;
    }
    await publishSession(sessionId, directory);
  };

  const assertSessionBackend = (backend, providerID) => {
    if (nativeBackendOfProviderId(providerID) !== backend) {
      throw new NativeAgentError('A native session keeps the CLI it started with', { code: 'NATIVE_BACKEND_MISMATCH', status: 409 });
    }
  };

  // What the user message of a prompt shows: the model, effort and agent it was sent with.
  const sendRecordOf = (request) => {
    const send = { modelID: request.model.modelID, agent: request.agent };
    if (request.variant !== undefined) send.variant = request.variant;
    return send;
  };

  /** @type {Map<string, { at: number, commands: Promise<Array<{ name: string, description: string, argumentHint: string }>> }>} */
  const claudeCommands = new Map();

  // Hands a prompt to Claude Code. The query resumes at a pending revert's
  // entry, and the revert ends once the transcript shows the rewind. A hidden
  // prompt, such as /compact, shows no user message: its effect does.
  const sendToClaude = async (sessionId, request, send, { visible }) => {
    const { directory, messageID } = request;
    const blocks = claudePromptBlocks(request.parts);
    const pending = await settleClaudeRewind(sessionId, directory);
    await committing(sessionId, directory, pending, async () => {
      await reverts.beforePrompt(sessionId, directory, messageID);
      await claudeLive.prompt({
        sessionId,
        directory,
        messageId: messageID,
        content: visible ? { kind: 'blocks', blocks } : null,
        sdkContent: blocks,
        config: {
          model: request.model.modelID,
          effort: request.variant !== undefined && CLAUDE_EFFORTS.has(request.variant) ? request.variant : null,
          permissionMode: request.agent === 'plan' ? 'plan' : 'bypassPermissions',
        },
        send,
        rewind: pending?.resumeAt === undefined ? null : { messageId: pending.messageId, resumeAt: pending.resumeAt },
      });
    });
  };

  // A pending Codex revert commits before the next turn: the thread drops
  // the reverted turns.
  const commitCodexRevert = async (sessionId, directory) => {
    const pending = await reverts.pending(sessionId);
    await committing(sessionId, directory, pending, async () => {
      if (pending?.beforeTurnId === undefined) return;
      await codexLive.revertThread(sessionId, pending.beforeTurnId);
      await reverts.finishCommit(sessionId);
    });
  };

  // Stops a running turn and waits until the CLI has settled it.
  const stopTurn = async (sessionId) => {
    const live = liveFor(sessionId);
    await live.abort(sessionId);
    let timer = null;
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => resolve(true), STOP_TIMEOUT_MS);
    });
    try {
      if (await Promise.race([live.whenIdle(sessionId).then(() => false), timedOut])) throw sessionBusyError();
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * A new session in its CLI. Claude Code creates the transcript with the
   * first turn; Codex starts the thread now.
   * @param {{ backend: 'claude' | 'codex', directory: string, title?: string }} input
   */
  const createSession = async ({ backend, directory, title }) => {
    let sessionId;
    let nativeId;
    if (backend === NATIVE_BACKEND_CLAUDE) {
      nativeId = randomUUID();
      sessionId = encodeClaudeSessionId(nativeId);
    } else {
      const started = threadResponseSchema.parse(await appServer.request('thread/start', {
        cwd: directory,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        developerInstructions: (await readGlobalInstructions()) ?? undefined,
      }));
      nativeId = started.thread.id;
      sessionId = encodeCodexSessionId(nativeId);
      codexLive.threadStarted(sessionId, directory, started.serviceTier ?? null);
      // Codex keeps a name from before the first turn; a failed naming leaves the preview.
      if (title !== undefined) {
        await codex.rename(sessionId, title).catch((error) => {
          console.warn('[native-agents] could not name the new Codex thread:', sessionId, errorMessage(error));
        });
      }
    }
    const entry = { backend, nativeId, directory, origin: 'openchamber', createdAt: now() };
    if (title !== undefined) entry.title = title;
    await registry.registerSession(sessionId, entry);
    const record = unconfirmedSessionRecord({ sessionId, ...entry });
    publisher.session(directory, record, { created: true });
    return record;
  };


  return {
    async capabilities() {
      const [claudeCli, codexCli] = await Promise.all([resolveExecutable('claude'), resolveExecutable('codex')]);
      return {
        supported: true,
        backends: {
          [NATIVE_BACKEND_CLAUDE]: { cli: claudeCli !== null },
          [NATIVE_BACKEND_CODEX]: { cli: codexCli !== null },
        },
        registry: registry.status(),
      };
    },

    /** Models per backend; a backend whose catalog cannot be read says why. */
    async catalog() {
      const codexList = await settled(codexCatalog());
      return {
        backends: {
          [NATIVE_BACKEND_CLAUDE]: { status: 'ok', models: claudeModels() },
          [NATIVE_BACKEND_CODEX]: codexList.status === 'ok'
            ? { status: 'ok', models: codexList.value }
            : codexList,
        },
      };
    },

    /**
     * Root sessions of a directory per backend. A backend that fails reports
     * `{ status: 'error' }` so the UI keeps what it had for that backend.
     * @param {string} directory
     */
    async listSessions(directory) {
      const [claudeSessions, codexSessions] = await Promise.all([
        settled(claude.listRootSessions(directory)),
        settled(codex.listRootSessions(directory)),
      ]);
      const partition = async (result) => (result.status === 'ok'
        ? { status: 'ok', sessions: await Promise.all(result.value.map(decorate)) }
        : result);
      return {
        backends: {
          [NATIVE_BACKEND_CLAUDE]: await partition(claudeSessions),
          [NATIVE_BACKEND_CODEX]: await partition(codexSessions),
        },
      };
    },

    /** @throws when the session does not exist */
    async getSession(sessionId, directory) {
      const session = await storeFor(sessionId).getSession(sessionId, directory);
      if (!session) throw sessionNotFoundError(sessionId);
      return decorate(session);
    },

    createSession,

    /**
     * Sends a prompt; returns once the CLI accepted it. The turn streams as
     * events. A session keeps the CLI it started with.
     * @param {string} sessionId
     * @param {PromptRequest} request
     */
    async prompt(sessionId, request) {
      const { backend } = decode(sessionId);
      assertSessionBackend(backend, request.model.providerID);
      const send = sendRecordOf(request);
      const parts = withInstructions(request.parts, request.instructions);
      if (backend === NATIVE_BACKEND_CLAUDE) {
        await sendToClaude(sessionId, { ...request, parts }, send, { visible: true });
      } else {
        const input = codexPromptInput(parts);
        await commitCodexRevert(sessionId, request.directory);
        await reverts.beforePrompt(sessionId, request.directory, request.messageID);
        await codexLive.prompt({
          sessionId,
          directory: request.directory,
          messageId: request.messageID,
          input,
          config: { model: request.model.modelID, ...codexVariantSettings(request.variant), mode: request.agent === 'plan' ? 'plan' : 'default' },
          send,
        });
      }
      await registry.recordSend(sessionId, { ...send, messageId: request.messageID, providerID: request.model.providerID, sentAt: now() });
    },

    /**
     * Compacts a session's context the way the CLI's own /compact does; it
     * shows as a compaction message. Claude Code can take instructions for
     * its summary; Codex takes none.
     * @param {string} sessionId
     * @param {Omit<PromptRequest, 'messageID' | 'parts'> & { instructions?: string }} request
     */
    async compact(sessionId, request) {
      const { backend } = decodeOwnSession(sessionId);
      assertSessionBackend(backend, request.model.providerID);
      if (backend === NATIVE_BACKEND_CLAUDE) {
        const text = request.instructions === undefined ? '/compact' : `/compact ${request.instructions}`;
        const command = { ...request, messageID: claudeUserMessageId(randomUUID()), parts: [{ type: 'text', text }] };
        await sendToClaude(sessionId, command, sendRecordOf(request), { visible: false });
        return;
      }
      if (request.instructions !== undefined) throw invalidRequestError('Codex compacts without instructions');
      await commitCodexRevert(sessionId, request.directory);
      await codexLive.compact(sessionId, request.directory);
    },

    /**
     * The slash commands a CLI offers in a directory. Codex runs its commands
     * in its own terminal UI and offers none here; OpenChamber maps `/compact`.
     * @param {'claude' | 'codex'} backend
     * @param {string} directory
     */
    async commands(backend, directory) {
      if (backend !== NATIVE_BACKEND_CLAUDE) return { commands: [] };
      const cached = claudeCommands.get(directory);
      if (cached && now() - cached.at < COMMANDS_CACHE_MS) return { commands: await cached.commands };
      const listing = { at: now(), commands: claudeLive.commands(directory) };
      claudeCommands.set(directory, listing);
      try {
        return { commands: await listing.commands };
      } catch (error) {
        // A failed listing is asked again next time rather than remembered.
        if (claudeCommands.get(directory) === listing) claudeCommands.delete(directory);
        throw error;
      }
    },

    /** Stops the running turn; false when none runs. */
    abort(sessionId) {
      return liveFor(sessionId).abort(sessionId);
    },

    /**
     * Renames, archives or restores a session in its CLI. Claude Code has no
     * archive, so the registry keeps that flag, adopting a terminal session
     * when needed. Archiving stops a running turn.
     * @param {string} sessionId
     * @param {string} directory
     * @param {{ title?: string, archived?: boolean }} patch
     */
    async updateSession(sessionId, directory, patch) {
      const decoded = decodeOwnSession(sessionId);
      const { backend } = decoded;
      if (patch.archived === true) await stopTurn(sessionId);
      if (backend === NATIVE_BACKEND_CLAUDE) {
        const { sessionUuid } = decoded;
        const hasTranscript = await claude.hasTranscript(sessionUuid, directory);
        if (patch.title !== undefined) {
          if (hasTranscript) await claude.rename(sessionId, directory, patch.title);
          else await registry.updateSession(sessionId, { title: patch.title });
        }
        if (patch.archived !== undefined) {
          const createdAt = now();
          const adopted = { backend, nativeId: sessionUuid, directory, origin: 'adopted', createdAt };
          if (hasTranscript) adopted.confirmedAt = createdAt;
          await registry.registerSession(sessionId, adopted);
          await registry.updateSession(sessionId, { archivedAt: patch.archived ? createdAt : null });
          // Its subagent sessions follow it.
          for (const child of (await claude.loadHistory(sessionId, directory))?.childSessions ?? []) {
            publisher.session(directory, child, { created: false });
          }
        }
      } else {
        if (patch.title !== undefined) await codex.rename(sessionId, patch.title);
        if (patch.archived !== undefined) await codex.setArchived(sessionId, patch.archived);
      }
      if (patch.metadata !== undefined) {
        await adoptSession(sessionId, directory);
        await registry.updateSession(sessionId, { metadata: withoutServerMetadata(patch.metadata) });
      }
      const session = await publishSession(sessionId, directory);
      if (!session) throw sessionNotFoundError(sessionId);
      return session;
    },

    /**
     * Stores the recap and next-step suggestion the session assist generated
     * for the session's last answer, next to the rest of the session's
     * metadata, and announces the session.
     * @param {string} sessionId
     * @param {string} directory
     * @param {{ recap: string, suggestion: string, forMessageID: string, generatedAt: number }} assist
     */
    async setSessionAssist(sessionId, directory, assist) {
      await adoptSession(sessionId, directory);
      const stored = (await registry.getSession(sessionId))?.metadata ?? {};
      await registry.updateSession(sessionId, {
        metadata: { ...stored, openchamber: { ...storedOpenChamber(stored), assist } },
      });
      const session = await publishSession(sessionId, directory);
      if (!session) throw sessionNotFoundError(sessionId);
      return session;
    },

    /**
     * Deletes a session from its CLI's store, as the CLI's own delete does,
     * and everything OpenChamber kept about it. A running turn is stopped and
     * a Claude process exits first, so nothing writes the session afterwards.
     */
    async deleteSession(sessionId, directory) {
      const { backend } = decodeOwnSession(sessionId);
      const session = await storeFor(sessionId).getSession(sessionId, directory);
      if (!session) throw sessionNotFoundError(sessionId);
      await stopTurn(sessionId);
      // Claude subagent transcripts go with their parent's.
      let children = [];
      if (backend === NATIVE_BACKEND_CLAUDE) {
        children = (await claude.loadHistory(sessionId, directory))?.childSessions ?? [];
        await claudeLive.closeSession(sessionId);
        await claude.deleteTranscript(sessionId, directory);
      } else {
        await codex.deleteThread(sessionId);
        codexLive.forget(sessionId);
      }
      await registry.removeSession(sessionId);
      for (const child of children) publisher.sessionDeleted(directory, child);
      publisher.sessionDeleted(directory, session);
      return { deleted: true };
    },

    /**
     * Reverts a user message and everything after it. The files the
     * reverted OpenChamber turns changed go back now; the conversation
     * rewinds when the next prompt commits the revert. A running turn is
     * stopped first.
     * @returns {Promise<{ session: object, filesRestored: number, conversationOnly: boolean }>}
     */
    async revert(sessionId, messageId, directory) {
      const { backend } = decode(sessionId);
      await stopTurn(sessionId);
      let revert;
      if (backend === NATIVE_BACKEND_CLAUDE) {
        await settleClaudeRewind(sessionId, directory);
        const target = await claude.rewindTarget(sessionId, directory, messageId);
        if (target.resumeAt === null) throw revertFirstMessageError();
        revert = { sessionId, messageId, messageIds: target.messageIds, rewind: { resumeAt: target.resumeAt } };
      } else {
        const target = await codex.rewindTarget(sessionId, messageId);
        revert = { sessionId, messageId, messageIds: target.messageIds, rewind: { beforeTurnId: target.beforeTurnId } };
      }
      const { filesRestored, conversationOnly } = await reverts.revert(revert);
      const session = await publishSession(sessionId, directory);
      if (!session) throw sessionNotFoundError(sessionId);
      return { session, filesRestored, conversationOnly };
    },

    /** Puts back what a pending revert restored; returns the session either way. */
    async unrevert(sessionId, directory) {
      decode(sessionId);
      await reverts.unrevert(sessionId);
      const session = await publishSession(sessionId, directory);
      if (!session) throw sessionNotFoundError(sessionId);
      return session;
    },

    /**
     * A new session holding the conversation before a user message, or the
     * whole conversation when `messageId` is null. Forking at a session's
     * first message starts an empty session. The fork has no file snapshots,
     * so its reverts rewind the conversation only.
     * @param {string} sessionId
     * @param {string | null} messageId
     * @param {string} directory
     */
    async fork(sessionId, messageId, directory) {
      const { backend } = decode(sessionId);
      let forkedId;
      if (backend === NATIVE_BACKEND_CLAUDE) {
        const target = messageId === null ? { resumeAt: undefined } : await claude.rewindTarget(sessionId, directory, messageId);
        if (target.resumeAt === null) return createSession({ backend, directory });
        const nativeId = await claude.fork(sessionId, directory, target.resumeAt);
        forkedId = encodeClaudeSessionId(nativeId);
        const createdAt = now();
        await registry.registerSession(forkedId, { backend, nativeId, directory, origin: 'openchamber', createdAt, confirmedAt: createdAt });
      } else {
        const { beforeTurnId } = messageId === null ? { beforeTurnId: undefined } : await codex.rewindTarget(sessionId, messageId);
        const nativeId = await codex.fork(sessionId, directory, beforeTurnId);
        forkedId = encodeCodexSessionId(nativeId);
        // The fork is loaded and may have no rollout yet; it stays
        // unconfirmed until its first turn, like a new thread.
        codexLive.threadStarted(forkedId, directory);
        await registry.registerSession(forkedId, { backend, nativeId, directory, origin: 'openchamber', createdAt: now() });
      }
      const session = await storeFor(forkedId).getSession(forkedId, directory);
      if (!session) throw sessionNotFoundError(forkedId);
      publisher.session(directory, session, { created: true });
      return session;
    },

    /**
     * A page of a session's history, newest last, with a running turn's live
     * state laid over it. `before` is the id of the oldest message of the
     * previous page; ids stay valid while the conversation grows.
     * @param {string} sessionId
     * @param {string} directory
     * @param {{ limit: number, before?: string }} page
     */
    async loadMessages(sessionId, directory, { limit, before }) {
      const history = await storeFor(sessionId).loadHistory(sessionId, directory);
      if (!history) throw sessionNotFoundError(sessionId);
      const pending = await reverts.pending(sessionId);
      const records = overlay(untilRewound(history.records, pending), liveFor(sessionId).liveRecords(sessionId));
      let end = records.length;
      if (before !== undefined) {
        end = records.findIndex((record) => record.info.id === before);
        if (end === -1) throw invalidRequestError(`Unknown message cursor: ${before}`);
      }
      const start = Math.max(0, end - limit);
      return {
        records: records.slice(start, end),
        cursor: start > 0 ? records[start].info.id : null,
        complete: start === 0,
        childSessions: history.childSessions,
      };
    },

    /** Throws when the backend cannot answer, so callers never treat failure as deletion. */
    sessionExists(sessionId, directory) {
      return storeFor(sessionId).sessionExists(sessionId, directory);
    },

    /** Sessions of a directory with a running turn; every other session is idle. */
    async statuses(directory) {
      const busy = [...claudeLive.busySessionIds(directory), ...codexLive.busySessionIds(directory)];
      return Object.fromEntries(busy.map((sessionId) => [sessionId, { type: 'busy' }]));
    },

    /** Questions native sessions of a directory are waiting on. */
    async questions(directory) {
      return questions.list(directory);
    },

    /**
     * @param {string} requestId
     * @param {string[][]} answers
     */
    replyQuestion(requestId, answers) {
      questions.reply(requestId, answers);
    },

    rejectQuestion(requestId) {
      questions.reject(requestId);
    },

    smallModel: {
      available: codexUtility.available,
      describe: codexUtility.describe,
      generate: codexUtility.generate,
    },

    async shutdown() {
      codexUtility.handleExit(new Error('Codex runtime is shutting down'));
      await claudeLive.shutdown();
      await appServer.stop();
    },
  };
};
