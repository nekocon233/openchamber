// Native Claude checklists. File lists are shared by config directory + list ID;
// TodoWrite belongs to the conversation that issued it, never its parent.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const MAX_ITEMS = 2000;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const safeId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const status = z.enum(['pending', 'in_progress', 'completed']);
const taskFileSchema = z.object({
  id: safeId,
  subject: z.string().max(4000),
  status,
  description: z.string().max(32_000).optional(),
  activeForm: z.string().max(4000).optional(),
  owner: z.string().max(1000).optional(),
  blocks: z.array(safeId).max(MAX_ITEMS).default([]),
  blockedBy: z.array(safeId).max(MAX_ITEMS).default([]),
});
const todoWriteInputSchema = z.object({
  todos: z.array(z.object({
    content: z.string().max(4000), status,
    activeForm: z.string().max(4000).optional(),
  })).max(MAX_ITEMS),
});
const errorCode = z.object({ code: z.string() });
const unavailable = () => ({ state: 'unavailable', reason: 'source_unknown' });

export const claudeConfigDir = (env) => env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude');

/** Capture only the source, not the connection environment or its credentials. */
export const claudeChecklistSource = ({ env, sessionUuid, directory }) => {
  const listId = safeId.safeParse(env.CLAUDE_CODE_TASK_LIST_ID || sessionUuid);
  if (!listId.success) return null;
  const configDir = path.resolve(directory, claudeConfigDir(env));
  return {
    configDir, listId: listId.data,
    identity: createHash('sha256').update(JSON.stringify([configDir, listId.data])).digest('hex'),
  };
};

const assertDirectory = async (directory) => {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Claude checklist source is not a directory');
};

/** Missing is distinct from successful empty. Directory failures always throw. */
export const readClaudeTaskList = async ({ configDir, listId }) => {
  safeId.parse(listId);
  const root = await fs.realpath(configDir).catch((error) => {
    if (errorCode.safeParse(error).data?.code === 'ENOENT') return null;
    throw error;
  });
  const missing = { exists: false, complete: true, unreadable: 0, items: [] };
  if (root === null) return missing;
  const parent = path.join(root, 'tasks');
  const directory = path.join(parent, listId);
  let entries;
  try {
    await assertDirectory(parent);
    await assertDirectory(directory);
    entries = await fs.opendir(directory);
  } catch (error) {
    if (errorCode.safeParse(error).data?.code === 'ENOENT') return missing;
    throw error;
  }
  const items = [];
  let unreadable = 0;
  let bytes = 0;
  let count = 0;
  for await (const entry of entries) {
    if (++count > MAX_ITEMS * 2) { unreadable += 1; break; }
    if (!entry.name.endsWith('.json')) continue;
    if (!entry.isFile() || !safeId.safeParse(entry.name.slice(0, -5)).success || items.length >= MAX_ITEMS) {
      unreadable += 1;
      continue;
    }
    let file;
    try {
      const name = path.join(directory, entry.name);
      // Check the parent again before opening: a moved/replaced list is partial,
      // not permission to follow a newly installed link outside the config root.
      if (await fs.realpath(directory) !== directory) throw new Error('Checklist directory changed');
      file = await fs.open(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = await file.stat();
      if (!before.isFile() || before.size > MAX_FILE_BYTES || bytes + before.size > MAX_TOTAL_BYTES) throw new Error('Checklist limit exceeded');
      bytes += before.size;
      const buffer = Buffer.alloc(before.size + 1);
      const read = await file.read(buffer, 0, buffer.length, 0);
      const after = await file.stat();
      if (read.bytesRead !== before.size || before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw new Error('Checklist changed while reading');
      const task = taskFileSchema.parse(JSON.parse(buffer.subarray(0, read.bytesRead).toString('utf8')));
      if (task.id !== entry.name.slice(0, -5)) throw new Error('Checklist identity mismatch');
      items.push(task);
    } catch {
      unreadable += 1;
    } finally {
      await file?.close();
    }
  }
  items.sort((left, right) => (Number(left.id) - Number(right.id)) || left.id.localeCompare(right.id));
  return { exists: true, complete: unreadable === 0, unreadable, items };
};

export const todosFromTodoWrite = (input) => {
  const parsed = todoWriteInputSchema.safeParse(input);
  if (!parsed.success) return null;
  return parsed.data.todos.map(({ content, ...todo }, index) => ({
    id: `todo-${index + 1}`, subject: content, ...todo, blocks: [], blockedBy: [],
  }));
};

/** Only a confirmed TodoWrite-only transcript is a fallback for absent files. */
const checklistFromHistory = (records) => {
  let items = null;
  for (const record of records) {
    // A compacted/partial history cannot establish that this was TodoWrite-only.
    if (record.info?.summary || record.parts.some((part) => part.type === 'compaction')) return null;
    for (const part of record.parts) {
      if (part.type !== 'tool') continue;
      if (['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'].includes(part.tool)) return null;
      if (part.tool === 'todowrite' && part.state.status === 'completed') {
        const next = todosFromTodoWrite(part.state.input);
        if (next !== null) items = next;
      }
    }
  }
  return items;
};

const sameIds = (left, right) => {
  if (left === null || right === null) return left === right;
  return left.size === right.size && [...left].every((id) => right.has(id));
};

const sameProjection = (left, right) => sameIds(left.baseline, right.baseline) && sameIds(left.hidden, right.hidden);

/** The tasks one read still shows, minus the finished ones a later plan retired. */
const filterHidden = (projection, result) => {
  if (projection === null || projection.hidden.size === 0) return result;
  const items = result.items.filter((item) => !projection.hidden.has(item.id));
  return items.length === result.items.length ? result : { ...result, items };
};

/**
 * One publication owner for GETs, tool mutations, and shared-list consumers.
 * @param {object} options
 * @param {(identity: string) => Promise<{ baseline: string[] | null, hidden: string[], pendingCreated: string[] } | null>} [options.readProjection]
 * @param {(identity: string, projection: { baseline: string[] | null, hidden: string[], pendingCreated: string[] }) => Promise<unknown>} [options.writeProjection]
 */
export const createClaudeChecklists = ({
  publisher,
  readFiles = readClaudeTaskList,
  readProjection = async () => null,
  writeProjection = async () => {},
  now = Date.now,
}) => {
  const bindings = new Map();
  const lists = new Map();
  let revision = 0;
  const listFor = (source) => {
    let list = lists.get(source.identity);
    if (!list) {
      list = {
        source, snapshot: null, fileObserved: false, fileToolsObserved: false, inFlight: null, mutation: 0,
        projection: null, projectionLoading: null, created: new Set(),
      };
      lists.set(source.identity, list);
    }
    return list;
  };

  // A TodoWrite-only list has no file identity and keeps its own conversation's
  // list, so only captured file sources carry a projection. A failed load is
  // not an empty projection: it rejects, and the next read tries again.
  const projectionReady = (list) => {
    if (list.source.todoOnly) return Promise.resolve();
    if (!list.projectionLoading) {
      const loading = (async () => {
        const stored = await readProjection(list.source.identity);
        if (stored === null) list.projection = { baseline: null, hidden: new Set() };
        else {
          list.projection = { baseline: stored.baseline === null ? null : new Set(stored.baseline), hidden: new Set(stored.hidden) };
          for (const id of stored.pendingCreated) list.created.add(id);
        }
      })();
      list.projectionLoading = loading;
      loading.catch(() => { if (list.projectionLoading === loading) list.projectionLoading = null; });
    }
    return list.projectionLoading;
  };

  /**
   * Saves the projection the read produced, then shows the tasks the current
   * plan still holds. A failed save keeps the previous projection in effect
   * and lets the next read try again; it never empties or re-expands the list.
   */
  const commitProjection = async (list, next, consumed, result) => {
    const held = list.projection;
    const unchanged = consumed === null && held !== null && sameProjection(held, next);
    // A list nobody references anymore must not write over the state a rebound
    // list of the same identity is about to read.
    if (unchanged || lists.get(list.source.identity) !== list) return filterHidden(held, result);
    try {
      await writeProjection(list.source.identity, {
        baseline: next.baseline === null ? null : [...next.baseline],
        hidden: [...next.hidden],
        pendingCreated: [...list.created],
      });
    } catch {
      console.warn('[native-agents] Claude checklist projection could not be saved; the previous list stays in effect');
      return filterHidden(held, result);
    }
    for (const id of consumed ?? []) list.created.delete(id);
    list.projection = next;
    return filterHidden(next, result);
  };

  /**
   * A task list holds every task its conversation ever created, and the model
   * starts a new plan by creating new ones. So an arrival of tasks that were
   * not in the last complete read means the finished tasks before it belong to
   * a plan the user has left, and they stop being published. Unfinished tasks
   * always stay, and so does a task created in this very batch.
   */
  const project = async (list, result) => {
    // A missing directory is not a read that could confirm a new plan.
    if (list.source.todoOnly || !result.exists) return result;
    await projectionReady(list);
    const held = list.projection;
    if (held === null) return result;
    const ids = new Set(result.items.map((item) => item.id));
    const hidden = new Set(held.hidden);
    let reopened = false;
    // A task that runs again is part of the current plan whatever it did
    // before. A partial read states this too: reopening is a fact a listed
    // task carries, unlike a missing file, which states nothing.
    for (const item of result.items) {
      if (item.status !== 'completed' && hidden.delete(item.id)) reopened = true;
    }
    // A partial read cannot prove what the list holds, so it retires no
    // finished task and does not move the baseline.
    if (!result.complete) {
      if (!reopened) return result;
      return commitProjection(list, { ...held, hidden }, null, result);
    }
    const consumed = new Set([...list.created].filter((id) => ids.has(id)));
    const added = new Set(consumed);
    if (held.baseline !== null) for (const id of ids) if (!held.baseline.has(id)) added.add(id);
    // Everything the batch did not create was already there, whether the
    // baseline names it or the creation signal is the first evidence of the
    // list at all.
    if (added.size > 0) {
      for (const item of result.items) {
        if (item.status === 'completed' && !added.has(item.id)) hidden.add(item.id);
      }
    }
    // A task the files no longer hold cannot stay hidden.
    for (const id of hidden) if (!ids.has(id)) hidden.delete(id);
    return commitProjection(list, { baseline: ids, hidden }, consumed.size > 0 ? consumed : null, result);
  };
  const publish = (list, value) => {
    const previous = list.snapshot;
    if (previous && previous.source === value.source && previous.complete === value.complete
      && previous.unreadable === value.unreadable && JSON.stringify(previous.items) === JSON.stringify(value.items)) return previous;
    const snapshot = { state: 'ready', identity: list.source.identity, ...value, revision: ++revision, observedAt: now() };
    list.snapshot = snapshot;
    for (const [sessionId, binding] of bindings) {
      if (binding.visible === list) publisher.checklist(binding.directory, sessionId, snapshot);
    }
    return snapshot;
  };
  const loadFiles = (list) => {
    if (list.inFlight) return list.inFlight;
    const pending = (async () => {
      // A tool mutation during an open read requires one fresh trailing read,
      // and one that arrives while the projection is saved does too: a task
      // created meanwhile must not be consumed as this pass's own addition.
      // Repeated mutations coalesce; no stale snapshot is granted authority.
      while (true) {
        const mutation = list.mutation;
        const result = await readFiles(list.source);
        if (mutation !== list.mutation) continue;
        if (result.exists) list.fileObserved = true;
        const projected = await project(list, result);
        if (mutation !== list.mutation) continue;
        return projected;
      }
    })();
    list.inFlight = pending;
    return pending.finally(() => { if (list.inFlight === pending) list.inFlight = null; });
  };
  const todoList = (sessionId, binding) => listFor({ ...binding.files.source, identity: `todo:${binding.files.source.identity}:${sessionId}`, todoOnly: true });
  const read = async (sessionId, history) => {
    const binding = bindings.get(sessionId);
    if (!binding) return unavailable();
    const list = binding.files;
    const result = list.source.todoOnly ? null : await loadFiles(list);
    if (bindings.get(sessionId) !== binding) return unavailable();
    if (result?.exists || list.fileObserved || list.fileToolsObserved) {
      for (const current of bindings.values()) if (current.files === list) current.visible = list;
      return publish(list, { source: 'files', complete: result?.complete ?? true, unreadable: result?.unreadable ?? 0, items: result?.items ?? [] });
    }
    if (!binding.historyRead && history) {
      const mutation = binding.mutation;
      const records = await history();
      if (bindings.get(sessionId) !== binding) return unavailable();
      if (mutation === binding.mutation) {
        binding.fallback = checklistFromHistory(records);
        binding.historyRead = true;
      }
    }
    if (binding.fallback !== null) {
      binding.visible = todoList(sessionId, binding);
      return publish(binding.visible, { source: 'history', complete: true, unreadable: 0, items: binding.fallback });
    }
    if (list.source.todoOnly) return unavailable();
    binding.visible = list;
    return publish(list, { source: 'files', complete: true, unreadable: 0, items: [] });
  };
  return {
    bind(sessionId, directory, source) {
      if (!source) { bindings.delete(sessionId); return; }
      const previous = bindings.get(sessionId);
      if (previous?.files.source.identity === source.identity && previous.directory === directory) return;
      const files = listFor(source);
      bindings.set(sessionId, { directory, files, visible: files, fallback: null, historyRead: false, mutation: 0 });
    },
    source(sessionId) { return bindings.get(sessionId)?.files.source ?? null; },
    directory(sessionId) { return bindings.get(sessionId)?.directory ?? null; },
    async read(sessionId, history) { return structuredClone(await read(sessionId, history)); },
    changed(sessionId) {
      const binding = bindings.get(sessionId);
      if (!binding) return Promise.resolve(unavailable());
      binding.files.mutation += 1;
      binding.files.fileToolsObserved = true;
      return read(sessionId);
    },
    /**
     * A TaskCreate result named a task the list holds. The ID stays pending
     * until the complete read that shows it consumes the signal, so a read
     * that ran before the task's own file existed still counts it as this
     * batch's creation instead of retiring it with the tasks before it.
     */
    created(sessionId, taskId) {
      const binding = bindings.get(sessionId);
      if (!binding || binding.files.source.todoOnly || !safeId.safeParse(taskId).success) {
        return Promise.resolve(unavailable());
      }
      binding.files.mutation += 1;
      binding.files.fileToolsObserved = true;
      binding.files.created.add(taskId);
      return read(sessionId);
    },
    todoWrite(sessionId, items) {
      const binding = bindings.get(sessionId);
      if (!binding) return;
      // File evidence wins, including a successful empty list. Legacy TodoWrite
      // cannot replace it or publish into another session sharing Task tools.
      if (binding.files.fileObserved || binding.files.fileToolsObserved) return;
      binding.mutation += 1;
      binding.historyRead = true;
      binding.fallback = items;
      binding.visible = todoList(sessionId, binding);
      publish(binding.visible, { source: 'history', complete: true, unreadable: 0, items });
    },
    forget(sessionId) {
      const binding = bindings.get(sessionId);
      bindings.delete(sessionId);
      for (const list of [binding?.files, binding?.visible]) {
        if (list && ![...bindings.values()].some((current) => current.files === list || current.visible === list)) lists.delete(list.source.identity);
      }
    },
  };
};
