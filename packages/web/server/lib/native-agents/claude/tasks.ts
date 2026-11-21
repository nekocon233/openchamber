import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import type { Dir } from 'node:fs';
import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { JsonValue } from '../../shared/json-values.js';
import type { NativeEventPublisher } from '../publisher.js';
import type { NativeMessageRecord } from '../records.js';

const MAX_ITEMS = 2000;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const safeId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const statusSchema = z.enum(['pending', 'in_progress', 'completed']);
const taskFileSchema = z.object({
  id: safeId,
  subject: z.string().max(4000),
  status: statusSchema,
  description: z.string().max(32_000).optional(),
  activeForm: z.string().max(4000).optional(),
  owner: z.string().max(1000).optional(),
  blocks: z.array(safeId).max(MAX_ITEMS).default([]),
  blockedBy: z.array(safeId).max(MAX_ITEMS).default([]),
});
const todoWriteInputSchema = z.object({
  todos: z.array(z.object({
    content: z.string().max(4000),
    status: statusSchema,
    activeForm: z.string().max(4000).optional(),
  })).max(MAX_ITEMS),
});
const errorCode = z.object({ code: z.string() });

export type ClaudeTaskStatus = z.infer<typeof statusSchema>;

export type ClaudeTaskItem = {
  id: string;
  subject: string;
  status: ClaudeTaskStatus;
  description?: string;
  activeForm?: string;
  owner?: string;
  blocks: string[];
  blockedBy: string[];
};

export type ClaudeFileChecklistSource = {
  configDir: string;
  listId: string;
  identity: string;
  todoOnly?: false;
};

export type ClaudeTodoChecklistSource = {
  identity: string;
  todoOnly: true;
  configDir?: string;
  listId?: string;
};

export type ClaudeChecklistSource = ClaudeFileChecklistSource | ClaudeTodoChecklistSource;

export type ClaudeChecklistFileResult = {
  exists: boolean;
  complete: boolean;
  unreadable: number;
  items: ClaudeTaskItem[];
};

export type StoredClaudeChecklistProjection = {
  baseline: string[] | null;
  hidden: string[];
  pendingCreated: string[];
};

export type ClaudeChecklistSnapshot =
  | { state: 'unavailable'; reason: 'source_unknown' }
  | {
    state: 'ready';
    identity: string;
    source: 'files' | 'history';
    revision: number;
    observedAt: number;
    complete: boolean;
    unreadable: number;
    items: ClaudeTaskItem[];
  };

export interface ClaudeChecklistsOptions {
  publisher: Pick<NativeEventPublisher, 'checklist'>;
  readFiles?: ((source: { configDir: string; listId: string }) => Promise<ClaudeChecklistFileResult>) | undefined;
  readProjection?: ((identity: string) => Promise<StoredClaudeChecklistProjection | null>) | undefined;
  writeProjection?: ((identity: string, projection: StoredClaudeChecklistProjection) => Promise<void>) | undefined;
  now?: (() => number) | undefined;
}

export interface ClaudeChecklists {
  bind: (sessionId: string, directory: string, source: ClaudeChecklistSource | null) => void;
  source: (sessionId: string) => ClaudeChecklistSource | null;
  directory: (sessionId: string) => string | null;
  read: (sessionId: string, history?: (() => Promise<ReadonlyArray<NativeMessageRecord>>) | undefined) => Promise<ClaudeChecklistSnapshot>;
  changed: (sessionId: string) => Promise<ClaudeChecklistSnapshot>;
  created: (sessionId: string, taskId: string) => Promise<ClaudeChecklistSnapshot>;
  todoWrite: (sessionId: string, items: ClaudeTaskItem[]) => void;
  forget: (sessionId: string) => void;
}

type ChecklistProjectionState = {
  baseline: Set<string> | null;
  hidden: Set<string>;
};

type ChecklistListState = {
  source: ClaudeChecklistSource;
  snapshot: Extract<ClaudeChecklistSnapshot, { state: 'ready' }> | null;
  fileObserved: boolean;
  fileToolsObserved: boolean;
  inFlight: Promise<ClaudeChecklistFileResult> | null;
  mutation: number;
  projection: ChecklistProjectionState | null;
  projectionLoading: Promise<void> | null;
  created: Set<string>;
};

type ChecklistBindingState = {
  directory: string;
  files: ChecklistListState;
  visible: ChecklistListState;
  fallback: ClaudeTaskItem[] | null;
  historyRead: boolean;
  mutation: number;
};

const unavailable = (): Extract<ClaudeChecklistSnapshot, { state: 'unavailable' }> => ({
  state: 'unavailable',
  reason: 'source_unknown',
});

export const claudeConfigDir = (env: NodeJS.ProcessEnv): string => env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude');

export const claudeChecklistSource = ({
  env,
  sessionUuid,
  directory,
}: {
  env: NodeJS.ProcessEnv;
  sessionUuid: string;
  directory: string;
}): ClaudeFileChecklistSource | null => {
  const listId = safeId.safeParse(env.CLAUDE_CODE_TASK_LIST_ID || sessionUuid);
  if (!listId.success) return null;
  const configDir = path.resolve(directory, claudeConfigDir(env));
  return {
    configDir,
    listId: listId.data,
    identity: createHash('sha256').update(JSON.stringify([configDir, listId.data])).digest('hex'),
  };
};

const assertDirectory = async (directory: string): Promise<void> => {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Claude checklist source is not a directory');
};

export const readClaudeTaskList = async ({ configDir, listId }: { configDir: string; listId: string }): Promise<ClaudeChecklistFileResult> => {
  safeId.parse(listId);
  const root = await fs.realpath(configDir).catch((error) => {
    if (errorCode.safeParse(error).data?.code === 'ENOENT') return null;
    throw error;
  });
  const missing: ClaudeChecklistFileResult = { exists: false, complete: true, unreadable: 0, items: [] };
  if (root === null) return missing;
  const parent = path.join(root, 'tasks');
  const directory = path.join(parent, listId);
  let entries: Dir;
  try {
    await assertDirectory(parent);
    await assertDirectory(directory);
    entries = await fs.opendir(directory);
  } catch (error) {
    if (errorCode.safeParse(error).data?.code === 'ENOENT') return missing;
    throw error;
  }
  const items: ClaudeTaskItem[] = [];
  let unreadable = 0;
  let bytes = 0;
  let count = 0;
  for await (const entry of entries) {
    if (++count > MAX_ITEMS * 2) {
      unreadable += 1;
      break;
    }
    if (!entry.name.endsWith('.json')) continue;
    if (!entry.isFile() || !safeId.safeParse(entry.name.slice(0, -5)).success || items.length >= MAX_ITEMS) {
      unreadable += 1;
      continue;
    }
    let file: FileHandle | undefined;
    try {
      const name = path.join(directory, entry.name);
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
      const item: ClaudeTaskItem = {
        id: task.id,
        subject: task.subject,
        status: task.status,
        blocks: task.blocks,
        blockedBy: task.blockedBy,
      };
      if (task.description !== undefined) item.description = task.description;
      if (task.activeForm !== undefined) item.activeForm = task.activeForm;
      if (task.owner !== undefined) item.owner = task.owner;
      items.push(item);
    } catch {
      unreadable += 1;
    } finally {
      await file?.close();
    }
  }
  items.sort((left, right) => (Number(left.id) - Number(right.id)) || left.id.localeCompare(right.id));
  return { exists: true, complete: unreadable === 0, unreadable, items };
};

export const todosFromTodoWrite = (input?: JsonValue): ClaudeTaskItem[] | null => {
  const parsed = todoWriteInputSchema.safeParse(input);
  if (!parsed.success) return null;
  return parsed.data.todos.map(({ content, status, activeForm }, index) => {
    const item: ClaudeTaskItem = {
      id: `todo-${index + 1}`,
      subject: content,
      status,
      blocks: [],
      blockedBy: [],
    };
    if (activeForm !== undefined) item.activeForm = activeForm;
    return item;
  });
};

const checklistFromHistory = (records: ReadonlyArray<NativeMessageRecord>): ClaudeTaskItem[] | null => {
  let items: ClaudeTaskItem[] | null = null;
  for (const record of records) {
    const info = record.info;
    if ((info && 'summary' in info && info.summary) || record.parts.some((part) => part.type === 'compaction')) return null;
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

const sameIds = (left: Set<string> | null, right: Set<string> | null): boolean => {
  if (left === null || right === null) return left === right;
  return left.size === right.size && [...left].every((value) => right.has(value));
};

const sameProjection = (left: ChecklistProjectionState, right: ChecklistProjectionState): boolean => (
  sameIds(left.baseline, right.baseline) && sameIds(left.hidden, right.hidden)
);

const filterHidden = (projection: ChecklistProjectionState | null, result: ClaudeChecklistFileResult): ClaudeChecklistFileResult => {
  if (projection === null || projection.hidden.size === 0) return result;
  const items = result.items.filter((item) => !projection.hidden.has(item.id));
  return items.length === result.items.length ? result : { ...result, items };
};

export const createClaudeChecklists = ({
  publisher,
  readFiles = readClaudeTaskList,
  readProjection = async () => null,
  writeProjection = async () => {},
  now = Date.now,
}: ClaudeChecklistsOptions): ClaudeChecklists => {
  const bindings = new Map<string, ChecklistBindingState>();
  const lists = new Map<string, ChecklistListState>();
  let revision = 0;

  const listFor = (source: ClaudeChecklistSource): ChecklistListState => {
    let list = lists.get(source.identity);
    if (!list) {
      list = {
        source,
        snapshot: null,
        fileObserved: false,
        fileToolsObserved: false,
        inFlight: null,
        mutation: 0,
        projection: null,
        projectionLoading: null,
        created: new Set(),
      };
      lists.set(source.identity, list);
    }
    return list;
  };

  const projectionReady = (list: ChecklistListState): Promise<void> => {
    if (list.source.todoOnly) return Promise.resolve();
    if (!list.projectionLoading) {
      const loading = (async () => {
        const stored = await readProjection(list.source.identity);
        if (stored === null) list.projection = { baseline: null, hidden: new Set() };
        else {
          list.projection = { baseline: stored.baseline === null ? null : new Set(stored.baseline), hidden: new Set(stored.hidden) };
          for (const itemId of stored.pendingCreated) list.created.add(itemId);
        }
      })();
      list.projectionLoading = loading;
      loading.catch(() => { if (list.projectionLoading === loading) list.projectionLoading = null; });
    }
    return list.projectionLoading;
  };

  const commitProjection = async (
    list: ChecklistListState,
    next: ChecklistProjectionState,
    consumed: Set<string> | null,
    result: ClaudeChecklistFileResult,
  ): Promise<ClaudeChecklistFileResult> => {
    const held = list.projection;
    const unchanged = consumed === null && held !== null && sameProjection(held, next);
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
    for (const itemId of consumed ?? []) list.created.delete(itemId);
    list.projection = next;
    return filterHidden(next, result);
  };

  const project = async (list: ChecklistListState, result: ClaudeChecklistFileResult): Promise<ClaudeChecklistFileResult> => {
    if (list.source.todoOnly || !result.exists) return result;
    await projectionReady(list);
    const held = list.projection;
    if (held === null) return result;
    const ids = new Set(result.items.map((item) => item.id));
    const hidden = new Set(held.hidden);
    let reopened = false;
    for (const item of result.items) {
      if (item.status !== 'completed' && hidden.delete(item.id)) reopened = true;
    }
    if (!result.complete) {
      if (!reopened) return result;
      return commitProjection(list, { ...held, hidden }, null, result);
    }
    const consumed = new Set([...list.created].filter((itemId) => ids.has(itemId)));
    const added = new Set(consumed);
    if (held.baseline !== null) for (const itemId of ids) if (!held.baseline.has(itemId)) added.add(itemId);
    if (added.size > 0) {
      for (const item of result.items) {
        if (item.status === 'completed' && !added.has(item.id)) hidden.add(item.id);
      }
    }
    for (const itemId of hidden) if (!ids.has(itemId)) hidden.delete(itemId);
    return commitProjection(list, { baseline: ids, hidden }, consumed.size > 0 ? consumed : null, result);
  };

  const publish = (
    list: ChecklistListState,
    value: { source: 'files' | 'history'; complete: boolean; unreadable: number; items: ClaudeTaskItem[] },
  ): Extract<ClaudeChecklistSnapshot, { state: 'ready' }> => {
    const previous = list.snapshot;
    if (previous && previous.source === value.source && previous.complete === value.complete
      && previous.unreadable === value.unreadable && JSON.stringify(previous.items) === JSON.stringify(value.items)) return previous;
    const snapshot: Extract<ClaudeChecklistSnapshot, { state: 'ready' }> = {
      state: 'ready',
      identity: list.source.identity,
      ...value,
      revision: ++revision,
      observedAt: now(),
    };
    list.snapshot = snapshot;
    for (const [sessionId, binding] of bindings) {
      if (binding.visible === list) publisher.checklist(binding.directory, sessionId, snapshot);
    }
    return snapshot;
  };

  const loadFiles = (list: ChecklistListState, source: ClaudeFileChecklistSource): Promise<ClaudeChecklistFileResult> => {
    if (list.inFlight) return list.inFlight;
    const pending = (async () => {
      while (true) {
        const mutation = list.mutation;
        const result = await readFiles(source);
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

  const todoList = (sessionId: string, binding: ChecklistBindingState): ChecklistListState => listFor({
    ...binding.files.source,
    identity: `todo:${binding.files.source.identity}:${sessionId}`,
    todoOnly: true,
  });

  const read = async (
    sessionId: string,
    history?: (() => Promise<ReadonlyArray<NativeMessageRecord>>) | undefined,
  ): Promise<ClaudeChecklistSnapshot> => {
    const binding = bindings.get(sessionId);
    if (!binding) return unavailable();
    const list = binding.files;
    const result = list.source.todoOnly ? null : await loadFiles(list, list.source);
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
      if (!source) {
        bindings.delete(sessionId);
        return;
      }
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
