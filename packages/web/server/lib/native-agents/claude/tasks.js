// Claude Code's task list, as OpenCode todos. The CLI keeps a session's list
// as one JSON file per task under `<config dir>/tasks/<session uuid>/`, which
// its TaskCreate and TaskUpdate tools write; TodoWrite carries the whole list
// in its input instead.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

const taskFileSchema = z.object({
  id: z.string(),
  subject: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
}).passthrough();

const todoWriteInputSchema = z.object({
  todos: z.array(z.object({
    content: z.string(),
    status: z.enum(['pending', 'in_progress', 'completed']),
  }).passthrough()),
}).passthrough();

const errorCode = z.object({ code: z.string() }).passthrough();

/** @typedef {{ id: string, content: string, status: 'pending' | 'in_progress' | 'completed', priority: 'medium' }} Todo */

// A task file the CLI is rewriting or has just removed is left out, as is one
// in a format this reader does not know.
const readTask = async (file) => {
  try {
    const task = taskFileSchema.safeParse(JSON.parse(await fs.readFile(file, 'utf8')));
    return task.success ? task.data : null;
  } catch {
    return null;
  }
};

/** The directory Claude Code keeps its state in, for the environment it runs with. */
export const claudeConfigDir = (env) => env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

/**
 * The session's task list, oldest task first. A session that never used the
 * task tools has none. A task file that cannot be parsed is left out; a
 * directory that cannot be read throws.
 * @param {{ configDir: string, sessionUuid: string }} input
 * @returns {Promise<Todo[]>}
 */
export const readClaudeTaskList = async ({ configDir, sessionUuid }) => {
  const directory = path.join(configDir, 'tasks', sessionUuid);
  let names;
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if (errorCode.safeParse(error).data?.code === 'ENOENT') return [];
    throw error;
  }
  const tasks = [];
  for (const name of names.filter((entry) => entry.endsWith('.json'))) {
    const task = await readTask(path.join(directory, name));
    if (task) tasks.push(task);
  }
  tasks.sort((left, right) => (Number(left.id) - Number(right.id)) || left.id.localeCompare(right.id));
  return tasks.map((task) => ({ id: task.id, content: task.subject, status: task.status, priority: 'medium' }));
};

/**
 * The list a TodoWrite call sets, or null when its input is not one.
 * @returns {Todo[] | null}
 */
export const todosFromTodoWrite = (input) => {
  const parsed = todoWriteInputSchema.safeParse(input);
  if (!parsed.success) return null;
  return parsed.data.todos.map((todo, index) => ({ id: `todo-${index + 1}`, content: todo.content, status: todo.status, priority: 'medium' }));
};
