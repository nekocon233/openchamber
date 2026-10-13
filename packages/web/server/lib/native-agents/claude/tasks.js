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

/** One publication owner for GETs, tool mutations, and shared-list consumers. */
export const createClaudeChecklists = ({ publisher, readFiles = readClaudeTaskList, now = Date.now }) => {
  const bindings = new Map();
  const lists = new Map();
  let revision = 0;
  const listFor = (source) => {
    let list = lists.get(source.identity);
    if (!list) {
      list = { source, snapshot: null, fileObserved: false, fileToolsObserved: false, inFlight: null, mutation: 0 };
      lists.set(source.identity, list);
    }
    return list;
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
      // A tool mutation during an open read requires one fresh trailing read.
      // Repeated mutations coalesce; no stale snapshot is granted authority.
      while (true) {
        const mutation = list.mutation;
        const result = await readFiles(list.source);
        if (mutation !== list.mutation) continue;
        if (result.exists) list.fileObserved = true;
        return result;
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
