import { randomUUID } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { NativeAgentError } from '../errors.js';

const MAX_RECENT = 100;
const OUTPUT_BYTES = 256 * 1024;
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const text = z.string().max(32_000);
const statusSchema = z.enum(['pending', 'running', 'paused', 'completed', 'failed', 'killed', 'stopped']);
const terminal = new Set<string>(['completed', 'failed', 'stopped']);
const usageSchema = z.object({ total_tokens: z.number().nonnegative(), tool_uses: z.number().nonnegative(), duration_ms: z.number().nonnegative() });
const outputPath = z.string().min(1).max(4096);
const fullSet = z.object({ tasks: z.array(z.object({
  task_id: id, task_type: text.default(''), description: text.default(''), ambient: z.boolean().optional(),
})) });
const edge = z.discriminatedUnion('subtype', [
  z.object({ subtype: z.literal('task_started'), task_id: id, tool_use_id: id.optional(), task_type: text.optional(), description: text.optional(), ambient: z.boolean().optional() }),
  z.object({ subtype: z.literal('task_progress'), task_id: id, tool_use_id: id.optional(), description: text.optional(), usage: usageSchema.optional(), last_tool_name: text.optional(), summary: text.optional() }),
  z.object({ subtype: z.literal('task_updated'), task_id: id, patch: z.object({ status: statusSchema.optional(), description: text.optional(), end_time: z.number().optional(), error: text.optional() }) }),
  z.object({ subtype: z.literal('task_notification'), task_id: id, tool_use_id: id.optional(), status: z.enum(['completed', 'failed', 'stopped']), summary: text.optional(), output_file: outputPath.optional(), usage: usageSchema.optional(), ambient: z.boolean().optional() }),
]);

type TaskMember = z.infer<typeof fullSet>['tasks'][number];

export type ClaudeBackgroundTaskStatus = 'unknown' | 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'stopped';

export type ClaudeBackgroundTaskUsage = {
  totalTokens: number;
  toolUses: number;
  durationMs: number;
};

export type ClaudeBackgroundTaskRecord = {
  id: string;
  type: string;
  description: string;
  active: boolean;
  ambient: boolean;
  status: ClaudeBackgroundTaskStatus;
  canStop: boolean;
  outputAvailable: boolean;
  toolUseId?: string;
  childSessionId?: string;
  summary?: string;
  usage?: ClaudeBackgroundTaskUsage;
  lastToolName?: string;
  error?: string;
  endedAt?: number;
};

type InternalTaskRecord = ClaudeBackgroundTaskRecord & {
  edgeDescription?: string;
  edgeType?: string;
};

export type ClaudeBackgroundTaskSnapshot = {
  state: 'unknown' | 'active' | 'inactive';
  generation: string | null;
  revision: number;
  tasks: ClaudeBackgroundTaskRecord[];
  omitted: number;
};

export type ClaudeBackgroundTaskActivity = {
  id: string;
  type: string;
  description: string;
};

export type ClaudeBackgroundTaskOutput =
  | { state: 'ready'; text: string; truncated: boolean }
  | { state: 'unavailable'; reason: 'query_closed' | 'not_recorded' | 'unreadable' };

export interface ClaudeBackgroundTaskQuery {
  stopTask?: ((taskId: string) => Promise<void>) | undefined;
  readFile?: ((filePath: string) => Promise<object | null>) | undefined;
}

export type ClaudeBackgroundTaskFrame =
  | SDKMessage
  | { type: string; subtype?: string; session_id?: string };

export interface ClaudeBackgroundTasksOptions {
  sessionUuid: string;
  query: ClaudeBackgroundTaskQuery;
  outputRoot: string;
  publish: (snapshot: ClaudeBackgroundTaskSnapshot) => void;
  nextRevision: () => number;
  childSessionForTool?: ((toolUseId: string) => string | null) | undefined;
  openFile?: ((filePath: string, flags: number) => Promise<FileHandle>) | undefined;
}

export interface ClaudeBackgroundTasks {
  snapshot: () => ClaudeBackgroundTaskSnapshot;
  activity: () => ClaudeBackgroundTaskActivity[];
  observe: (frame: ClaudeBackgroundTaskFrame) => boolean;
  outputFromTool: (input: { taskId?: string | undefined; toolUseId?: string | undefined; file?: string | undefined }) => void;
  output: (taskId: string, requestedGeneration: string) => Promise<ClaudeBackgroundTaskOutput>;
  stop: (taskId: string, requestedGeneration: string) => Promise<{ accepted: true }>;
  close: () => void;
}

const method = z.function();

const isStopTask = (
  value: ClaudeBackgroundTaskQuery['stopTask'],
): value is NonNullable<ClaudeBackgroundTaskQuery['stopTask']> => method.safeParse(value).success;

const hasReadFile = (
  value: ClaudeBackgroundTaskQuery['readFile'],
): value is NonNullable<ClaudeBackgroundTaskQuery['readFile']> => method.safeParse(value).success;

const taskError = (message: string, code: string, statusCode = 409): NativeAgentError => new NativeAgentError(message, { code, status: statusCode });

export const claudeTaskOutputRoot = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string => {
  const base = env.CLAUDE_CODE_TMPDIR || (platform === 'darwin' ? '/tmp' : (env.TMPDIR || env.TEMP || env.TMP || os.tmpdir()));
  return path.resolve(base, platform === 'win32' ? 'claude' : `claude-${process.getuid?.() ?? 0}`);
};

export const createClaudeBackgroundTasks = ({
  sessionUuid,
  query,
  outputRoot,
  publish,
  nextRevision,
  childSessionForTool = () => null,
  openFile = (filePath, flags) => fs.open(filePath, flags),
}: ClaudeBackgroundTasksOptions): ClaudeBackgroundTasks => {
  const generation = randomUUID();
  const records = new Map<string, InternalTaskRecord>();
  const outputs = new Map<string, string>();
  const recentOrder = new Map<string, true>();
  const stops = new Map<string, Promise<{ accepted: true }>>();
  let members = new Map<string, TaskMember>();
  let supported = false;
  let closed = false;
  let omitted = 0;
  let snapshot: ClaudeBackgroundTaskSnapshot = { state: 'unknown', generation, revision: nextRevision(), tasks: [], omitted: 0 };

  const recordFor = (taskId: string): InternalTaskRecord => {
    let record = records.get(taskId);
    if (!record) {
      record = { id: taskId, type: '', description: '', active: false, ambient: false, status: 'unknown', canStop: false, outputAvailable: false };
      records.set(taskId, record);
      recentOrder.set(taskId, true);
    }
    return record;
  };

  const prune = (): void => {
    const ended = [...recentOrder.keys()].filter((taskId) => !members.has(taskId));
    for (const taskId of ended.slice(0, Math.max(0, ended.length - MAX_RECENT))) {
      records.delete(taskId);
      outputs.delete(taskId);
      recentOrder.delete(taskId);
      omitted += 1;
    }
  };

  const commit = (): void => {
    prune();
    const canStopQuery = isStopTask(query.stopTask);
    const canReadQuery = hasReadFile(query.readFile);
    const tasks: ClaudeBackgroundTaskRecord[] = [...records.values()].map((record) => {
      const member = members.get(record.id);
      const { edgeDescription, edgeType, ...details } = record;
      return {
        ...details,
        description: edgeDescription ?? record.description,
        type: edgeType ?? record.type,
        ambient: member ? member.ambient === true : record.ambient,
        active: Boolean(member),
        canStop: Boolean(member) && canStopQuery,
        outputAvailable: outputs.has(record.id) && canReadQuery,
      };
    });
    const value: Omit<ClaudeBackgroundTaskSnapshot, 'revision'> = closed
      ? { state: 'inactive', generation: null, tasks: [], omitted: 0 }
      : supported ? { state: 'active', generation, tasks, omitted }
        : { state: 'unknown', generation, tasks, omitted };
    const previous = { state: snapshot.state, generation: snapshot.generation, tasks: snapshot.tasks, omitted: snapshot.omitted };
    if (JSON.stringify(previous) === JSON.stringify(value)) return;
    snapshot = { ...value, revision: nextRevision() };
    publish(structuredClone(snapshot));
  };

  const link = (record: InternalTaskRecord, toolUseId?: string): void => {
    if (!toolUseId) return;
    record.toolUseId = toolUseId;
    const child = childSessionForTool(toolUseId);
    if (child) record.childSessionId = child;
  };

  const isOwnedOutput = (taskId: string, file: string, root: string): boolean => {
    if (!path.isAbsolute(file) || file.includes('\0') || file.split(path.sep).some((piece) => piece === '.' || piece === '..')) return false;
    const relative = path.relative(root, file);
    const pieces = relative.split(path.sep);
    return pieces.length === 4 && pieces[0] !== '..' && pieces[0] !== '.'
      && pieces[1] === sessionUuid && pieces[2] === 'tasks' && pieces[3] === `${taskId}.output`;
  };

  const canonicalRoot = (): string => path.join(realpathSync(path.dirname(outputRoot)), path.basename(outputRoot));

  const canonicalOutput = (taskId: string, file: string): string | null => {
    const root = canonicalRoot();
    if (isOwnedOutput(taskId, file, outputRoot)) return path.join(root, path.relative(outputRoot, file));
    if (isOwnedOutput(taskId, file, root)) return file;
    return null;
  };

  const bindOutput = (taskId: string, file?: string): void => {
    const parsedFile = outputPath.safeParse(file);
    if (!parsedFile.success) return;
    try {
      const normalized = canonicalOutput(taskId, parsedFile.data);
      if (normalized) outputs.set(taskId, normalized);
    } catch {
      return;
    }
  };

  const owned = (taskId: string, requestedGeneration: string): InternalTaskRecord => {
    if (requestedGeneration !== generation) throw taskError('This task belongs to another query', 'NATIVE_TASK_GENERATION_MISMATCH');
    const record = records.get(taskId);
    if (!record) throw taskError('Task not found in this session', 'NATIVE_TASK_NOT_FOUND', 404);
    return record;
  };

  const checkedFile = async (taskId: string, file: string): Promise<{ file: string; dev: number; ino: number }> => {
    const rootStat = await fs.lstat(outputRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('Untrusted task output root');
    const root = await fs.realpath(outputRoot);
    const normalized = canonicalOutput(taskId, file);
    if (!normalized || !isOwnedOutput(taskId, normalized, root)) throw new Error('Untrusted task output');
    let current = root;
    const pieces = path.relative(root, normalized).split(path.sep);
    for (const [index, piece] of pieces.entries()) {
      current = path.join(current, piece);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || (index === pieces.length - 1 ? !stat.isFile() : !stat.isDirectory())) throw new Error('Untrusted task output');
    }
    if (await fs.realpath(normalized) !== normalized) throw new Error('Task output changed');
    const stat = await fs.stat(normalized);
    return { file: normalized, dev: stat.dev, ino: stat.ino };
  };

  return {
    snapshot() { return structuredClone(snapshot); },
    activity() {
      return [...members.values()].filter((task) => !task.ambient)
        .map((task) => ({ id: task.task_id, type: task.task_type, description: task.description }));
    },
    observe(frame) {
      if (closed || frame.type !== 'system' || ('session_id' in frame && frame.session_id && frame.session_id !== sessionUuid)) return false;
      if ('subtype' in frame && frame.subtype === 'background_tasks_changed') {
        const parsed = fullSet.safeParse(frame);
        if (!parsed.success || new Set(parsed.data.tasks.map((task) => task.task_id)).size !== parsed.data.tasks.length) return false;
        members = new Map(parsed.data.tasks.map((task) => [task.task_id, task]));
        supported = true;
        for (const task of members.values()) {
          const record = recordFor(task.task_id);
          record.type = task.task_type;
          record.description = task.description;
          record.ambient = task.ambient === true;
        }
        commit();
        return true;
      }
      const parsed = edge.safeParse(frame);
      if (!parsed.success) return false;
      const event = parsed.data;
      const record = recordFor(event.task_id);
      if (event.subtype === 'task_started') {
        link(record, event.tool_use_id);
        if (event.description !== undefined) record.edgeDescription = event.description;
        if (event.ambient !== undefined && !members.has(record.id)) record.ambient = event.ambient;
        if (event.task_type !== undefined) record.edgeType = event.task_type;
        if (!terminal.has(record.status)) record.status = 'running';
      } else if (event.subtype === 'task_progress') {
        link(record, event.tool_use_id);
        if (event.description !== undefined) record.edgeDescription = event.description;
        if (event.summary !== undefined) record.summary = event.summary;
        if (event.usage) record.usage = { totalTokens: event.usage.total_tokens, toolUses: event.usage.tool_uses, durationMs: event.usage.duration_ms };
        if (event.last_tool_name !== undefined) record.lastToolName = event.last_tool_name;
      } else if (event.subtype === 'task_updated') {
        const patch = event.patch;
        if (patch.status && (!terminal.has(record.status) || terminal.has(patch.status) || patch.status === 'killed')) {
          record.status = patch.status === 'killed' ? 'stopped' : patch.status;
        }
        if (patch.description !== undefined) record.edgeDescription = patch.description;
        if (patch.error !== undefined) record.error = patch.error;
        if (patch.end_time !== undefined) record.endedAt = patch.end_time;
      } else {
        link(record, event.tool_use_id);
        if (event.ambient !== undefined && !members.has(record.id)) record.ambient = event.ambient;
        if (event.summary !== undefined) record.summary = event.summary;
        if (event.usage) record.usage = { totalTokens: event.usage.total_tokens, toolUses: event.usage.tool_uses, durationMs: event.usage.duration_ms };
        record.status = event.status;
        bindOutput(record.id, event.output_file);
      }
      recentOrder.delete(record.id);
      recentOrder.set(record.id, true);
      commit();
      return false;
    },
    outputFromTool({ taskId, toolUseId, file }) {
      const parsedId = id.safeParse(taskId);
      if (closed || !parsedId.success) return;
      const record = recordFor(parsedId.data);
      link(record, toolUseId);
      bindOutput(parsedId.data, file);
      commit();
    },
    async output(taskId, requestedGeneration) {
      if (closed) return { state: 'unavailable', reason: 'query_closed' };
      owned(taskId, requestedGeneration);
      const file = outputs.get(taskId);
      if (!file || !hasReadFile(query.readFile)) return { state: 'unavailable', reason: 'not_recorded' };
      let handle: FileHandle | undefined;
      try {
        const before = await checkedFile(taskId, file);
        if (closed) return { state: 'unavailable', reason: 'query_closed' };
        handle = await openFile(before.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('Task output changed');
        const bytes = Buffer.alloc(OUTPUT_BYTES + 1);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        if (closed) return { state: 'unavailable', reason: 'query_closed' };
        const after = await checkedFile(taskId, file);
        if (after.dev !== before.dev || after.ino !== before.ino) throw new Error('Task output changed');
        const truncated = bytesRead > OUTPUT_BYTES || opened.size > OUTPUT_BYTES;
        const decoded = new TextDecoder().decode(bytes.subarray(0, Math.min(bytesRead, OUTPUT_BYTES)), { stream: truncated });
        return { state: 'ready', text: decoded, truncated };
      } catch {
        return { state: 'unavailable', reason: closed ? 'query_closed' : 'unreadable' };
      } finally {
        await handle?.close();
      }
    },
    async stop(taskId, requestedGeneration) {
      if (closed) throw taskError('The task query is closed', 'NATIVE_TASK_QUERY_CLOSED');
      const record = owned(taskId, requestedGeneration);
      const stopTask = query.stopTask;
      if (!members.has(taskId) || !isStopTask(stopTask)) throw taskError('This task cannot be stopped', 'NATIVE_TASK_STOP_UNAVAILABLE');
      const existing = stops.get(taskId);
      if (existing) return existing;
      const pending = (async (): Promise<{ accepted: true }> => {
        try {
          await stopTask(taskId);
          return { accepted: true };
        } catch {
          if (!closed) {
            record.error = 'Could not stop this task';
            commit();
          }
          throw taskError('Could not stop this task', 'NATIVE_TASK_STOP_FAILED', 502);
        } finally {
          stops.delete(taskId);
        }
      })();
      stops.set(taskId, pending);
      return pending;
    },
    close() {
      if (closed) return;
      closed = true;
      records.clear();
      outputs.clear();
      recentOrder.clear();
      members.clear();
      stops.clear();
      commit();
    },
  };
};
