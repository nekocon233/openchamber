import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { claudeConfigDir, readClaudeTaskList, todosFromTodoWrite } from './tasks.js';

const SESSION_UUID = 'f1033b7a-88c5-4b77-bbec-6d63ec3a1188';
const directories = [];
afterEach(() => {
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const writeTasks = (files) => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-claude-tasks-'));
  directories.push(configDir);
  const directory = path.join(configDir, 'tasks', SESSION_UUID);
  fs.mkdirSync(directory, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), content);
  return configDir;
};

const task = (id, subject, status) => JSON.stringify({ id, subject, description: `Task ${subject}`, status, blocks: [], blockedBy: [] });

describe('Claude Code task list', () => {
  it('reads the tasks in creation order and leaves out what it cannot read', async () => {
    const configDir = writeTasks({
      '10.json': task('10', 'tenth', 'pending'),
      '2.json': task('2', 'beta', 'completed'),
      '1.json': task('1', 'alpha', 'in_progress'),
      '3.json': '{"id": "3", "subj',
      '.lock': '',
    });
    expect(await readClaudeTaskList({ configDir, sessionUuid: SESSION_UUID })).toEqual([
      { id: '1', content: 'alpha', status: 'in_progress', priority: 'medium' },
      { id: '2', content: 'beta', status: 'completed', priority: 'medium' },
      { id: '10', content: 'tenth', status: 'pending', priority: 'medium' },
    ]);
  });

  it('has no tasks for a session that never used the task tools', async () => {
    const configDir = writeTasks({});
    expect(await readClaudeTaskList({ configDir, sessionUuid: '22222222-2222-4222-8222-222222222222' })).toEqual([]);
  });

  it('takes the list a TodoWrite call sets, and finds the config directory the CLI uses', () => {
    expect(todosFromTodoWrite({ todos: [{ content: 'Plan', status: 'completed', activeForm: 'Planning' }, { content: 'Build', status: 'in_progress', activeForm: 'Building' }] })).toEqual([
      { id: 'todo-1', content: 'Plan', status: 'completed', priority: 'medium' },
      { id: 'todo-2', content: 'Build', status: 'in_progress', priority: 'medium' },
    ]);
    expect(todosFromTodoWrite({ todos: 'none' })).toBeNull();
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/custom/claude' })).toBe('/custom/claude');
    expect(claudeConfigDir({})).toBe(path.join(os.homedir(), '.claude'));
  });
});
