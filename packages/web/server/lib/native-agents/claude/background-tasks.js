// Per-query task details. Only background_tasks_changed owns membership;
// the edge stream enriches records without deciding activity or completion.
import { randomUUID } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { NativeAgentError } from '../errors.js';

const MAX_RECENT = 100;
const OUTPUT_BYTES = 256 * 1024;
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const text = z.string().max(32_000);
const status = z.enum(['pending', 'running', 'paused', 'completed', 'failed', 'killed', 'stopped']);
const terminal = new Set(['completed', 'failed', 'stopped']);
const usage = z.object({ total_tokens: z.number().nonnegative(), tool_uses: z.number().nonnegative(), duration_ms: z.number().nonnegative() });
const outputPath = z.string().min(1).max(4096);
const fullSet = z.object({ tasks: z.array(z.object({
  task_id: id, task_type: text.default(''), description: text.default(''), ambient: z.boolean().optional(),
})) });
const edge = z.discriminatedUnion('subtype', [
  z.object({ subtype: z.literal('task_started'), task_id: id, tool_use_id: id.optional(), task_type: text.optional(), description: text.optional(), ambient: z.boolean().optional() }),
  z.object({ subtype: z.literal('task_progress'), task_id: id, tool_use_id: id.optional(), description: text.optional(), usage: usage.optional(), last_tool_name: text.optional(), summary: text.optional() }),
  z.object({ subtype: z.literal('task_updated'), task_id: id, patch: z.object({ status: status.optional(), description: text.optional(), end_time: z.number().optional(), error: text.optional() }) }),
  z.object({ subtype: z.literal('task_notification'), task_id: id, tool_use_id: id.optional(), status: z.enum(['completed', 'failed', 'stopped']), summary: text.optional(), output_file: outputPath.optional(), usage: usage.optional(), ambient: z.boolean().optional() }),
]);
const method = z.function();
const hasMethod = (value) => method.safeParse(value).success;
const taskError = (message, code, statusCode = 409) => new NativeAgentError(message, { code, status: statusCode });

/** Official env-vars docs: macOS defaults to /tmp; other OSes use os.tmpdir(). */
export const claudeTaskOutputRoot = (env, platform = process.platform) => {
  const base = env.CLAUDE_CODE_TMPDIR || (platform === 'darwin' ? '/tmp' : (env.TMPDIR || env.TEMP || env.TMP || os.tmpdir()));
  return path.resolve(base, platform === 'win32' ? 'claude' : `claude-${process.getuid?.() ?? 0}`);
};

export const createClaudeBackgroundTasks = ({ sessionUuid, query, outputRoot, publish, nextRevision, childSessionForTool = () => null, openFile = fs.open }) => {
  const generation = randomUUID();
  const records = new Map();
  const outputs = new Map();
  const recentOrder = new Map();
  const stops = new Map();
  let members = new Map();
  let supported = false;
  let closed = false;
  let omitted = 0;
  let snapshot = { state: 'unknown', generation, revision: nextRevision(), tasks: [], omitted: 0 };
  const recordFor = (taskId) => {
    let record = records.get(taskId);
    if (!record) {
      record = { id: taskId, type: '', description: '', active: false, ambient: false, status: 'unknown', canStop: false, outputAvailable: false };
      records.set(taskId, record);
      recentOrder.set(taskId, true);
    }
    return record;
  };
  const prune = () => {
    const ended = [...recentOrder.keys()].filter((taskId) => !members.has(taskId));
    for (const taskId of ended.slice(0, Math.max(0, ended.length - MAX_RECENT))) {
      records.delete(taskId);
      outputs.delete(taskId);
      recentOrder.delete(taskId);
      omitted += 1;
    }
  };
  const commit = () => {
    prune();
    const tasks = [...records.values()].map((record) => {
      const member = members.get(record.id);
      const { edgeDescription, edgeType, ...details } = record;
      return {
        ...details,
        description: edgeDescription ?? record.description,
        type: edgeType ?? record.type,
        ambient: member ? member.ambient === true : record.ambient,
        active: Boolean(member),
        canStop: Boolean(member) && hasMethod(query.stopTask),
        outputAvailable: outputs.has(record.id) && hasMethod(query.readFile),
      };
    });
    const value = closed
      ? { state: 'inactive', generation: null, tasks: [], omitted: 0 }
      : supported ? { state: 'active', generation, tasks, omitted }
        : { state: 'unknown', generation, tasks, omitted };
    const previous = { state: snapshot.state, generation: snapshot.generation, tasks: snapshot.tasks, omitted: snapshot.omitted };
    if (JSON.stringify(previous) === JSON.stringify(value)) return;
    snapshot = { ...value, revision: nextRevision() };
    publish(structuredClone(snapshot));
  };
  const link = (record, toolUseId) => {
    if (!toolUseId) return;
    record.toolUseId = toolUseId;
    const child = childSessionForTool(toolUseId);
    if (child) record.childSessionId = child;
  };
  // Claude Code 2.1.293 constructs <temp>/<project>/<session>/tasks/<id>.output.
  // The structured CLI field supplies the path. This validates it, never builds
  // a guessed output filename to read or scans the task/transcript directories.
  const isOwnedOutput = (taskId, file, root) => {
    if (!path.isAbsolute(file) || file.includes('\0') || file.split(path.sep).some((piece) => piece === '.' || piece === '..')) return false;
    const relative = path.relative(root, file);
    const pieces = relative.split(path.sep);
    return pieces.length === 4 && pieces[0] !== '..' && pieces[0] !== '.'
      && pieces[1] === sessionUuid && pieces[2] === 'tasks' && pieces[3] === `${taskId}.output`;
  };
  const canonicalRoot = () => path.join(realpathSync(path.dirname(outputRoot)), path.basename(outputRoot));
  const canonicalOutput = (taskId, file) => {
    const root = canonicalRoot();
    if (isOwnedOutput(taskId, file, outputRoot)) return path.join(root, path.relative(outputRoot, file));
    if (isOwnedOutput(taskId, file, root)) return file;
    return null;
  };
  const bindOutput = (taskId, file) => {
    if (!outputPath.safeParse(file).success) return;
    try {
      const normalized = canonicalOutput(taskId, file);
      if (normalized) outputs.set(taskId, normalized);
    } catch { /* No verified root yet. A later structured notification can grant it. */ }
  };
  const owned = (taskId, requestedGeneration) => {
    if (requestedGeneration !== generation) throw taskError('This task belongs to another query', 'NATIVE_TASK_GENERATION_MISMATCH');
    const record = records.get(taskId);
    if (!record) throw taskError('Task not found in this session', 'NATIVE_TASK_NOT_FOUND', 404);
    return record;
  };
  const checkedFile = async (taskId, file) => {
    // /tmp -> /private/tmp is an OS root alias. Below the trusted root every
    // component must be a real directory/file, not a symlink into user logs.
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
      if (closed || frame.type !== 'system' || (frame.session_id && frame.session_id !== sessionUuid)) return false;
      if (frame.subtype === 'background_tasks_changed') {
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
      link(record, event.tool_use_id);
      if (event.description !== undefined) record.edgeDescription = event.description;
      if (event.ambient !== undefined && !members.has(record.id)) record.ambient = event.ambient;
      if (event.summary !== undefined) record.summary = event.summary;
      if (event.usage) record.usage = { totalTokens: event.usage.total_tokens, toolUses: event.usage.tool_uses, durationMs: event.usage.duration_ms };
      if (event.subtype === 'task_started') {
        if (event.task_type !== undefined) record.edgeType = event.task_type;
        // A late start edge cannot reopen a task with a known outcome.
        if (!terminal.has(record.status)) record.status = 'running';
      } else if (event.subtype === 'task_progress') {
        if (event.last_tool_name !== undefined) record.lastToolName = event.last_tool_name;
      } else if (event.subtype === 'task_updated') {
        const patch = event.patch;
        if (patch.status && (!terminal.has(record.status) || terminal.has(patch.status) || patch.status === 'killed')) record.status = patch.status === 'killed' ? 'stopped' : patch.status;
        if (patch.description !== undefined) record.edgeDescription = patch.description;
        if (patch.error !== undefined) record.error = patch.error;
        if (patch.end_time !== undefined) record.endedAt = patch.end_time;
      } else {
        record.status = event.status;
        bindOutput(record.id, event.output_file);
      }
      recentOrder.delete(record.id);
      recentOrder.set(record.id, true);
      commit();
      return false;
    },
    outputFromTool({ taskId, toolUseId, file }) {
      if (closed || !id.safeParse(taskId).success) return;
      const record = recordFor(taskId);
      link(record, toolUseId);
      bindOutput(taskId, file);
      commit();
    },
    async output(taskId, requestedGeneration) {
      if (closed) return { state: 'unavailable', reason: 'query_closed' };
      owned(taskId, requestedGeneration);
      const file = outputs.get(taskId);
      if (!file || !hasMethod(query.readFile)) return { state: 'unavailable', reason: 'not_recorded' };
      let handle;
      try {
        const before = await checkedFile(taskId, file);
        if (closed) return { state: 'unavailable', reason: 'query_closed' };
        // SDK readFile reopens a path, leaving a symlink-swap window after our
        // checks. Pin the verified artifact instead; a replaced parent/leaf
        // cannot change which inode supplies bytes after this identity check.
        handle = await openFile(before.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('Task output changed');
        const bytes = Buffer.alloc(OUTPUT_BYTES + 1);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        if (closed) return { state: 'unavailable', reason: 'query_closed' };
        const after = await checkedFile(taskId, file);
        if (after.dev !== before.dev || after.ino !== before.ino) throw new Error('Task output changed');
        const truncated = bytesRead > OUTPUT_BYTES || opened.size > OUTPUT_BYTES;
        const text = new TextDecoder().decode(bytes.subarray(0, Math.min(bytesRead, OUTPUT_BYTES)), { stream: truncated });
        return { state: 'ready', text, truncated };
      } catch {
        return { state: 'unavailable', reason: closed ? 'query_closed' : 'unreadable' };
      } finally {
        await handle?.close();
      }
    },
    async stop(taskId, requestedGeneration) {
      if (closed) throw taskError('The task query is closed', 'NATIVE_TASK_QUERY_CLOSED');
      const record = owned(taskId, requestedGeneration);
      if (!members.has(taskId) || !hasMethod(query.stopTask)) throw taskError('This task cannot be stopped', 'NATIVE_TASK_STOP_UNAVAILABLE');
      if (stops.has(taskId)) return stops.get(taskId);
      const pending = (async () => {
        try {
          await query.stopTask(taskId);
          return { accepted: true };
        } catch {
          if (!closed) { record.error = 'Could not stop this task'; commit(); }
          throw taskError('Could not stop this task', 'NATIVE_TASK_STOP_FAILED', 502);
        } finally { stops.delete(taskId); }
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
