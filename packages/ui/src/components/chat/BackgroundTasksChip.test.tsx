import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'bun:test';

import { I18nProvider } from '@/lib/i18n';
import type { SessionBackgroundTask } from '@/lib/opencode/events';
import { BackgroundTasksChip } from './BackgroundTasksChip';

const task = (id: string, description: string): SessionBackgroundTask => ({ id, type: 'local_bash', description });

const render = (tasks: SessionBackgroundTask[]) => renderToStaticMarkup(
  <I18nProvider><BackgroundTasksChip tasks={tasks} /></I18nProvider>,
);

test('names the first task and counts the rest', () => {
  const one = render([task('bwait', 'Wait for the training job')]);
  expect(one).toContain('Waiting on background work');
  expect(one).toContain('Wait for the training job');
  expect(one).not.toContain('+');

  const three = render([task('bwait', 'Wait for the training job'), task('b2', 'Tag images'), task('b3', 'Upscale frames')]);
  expect(three).toContain('Wait for the training job');
  expect(three).toContain('+2');
  expect(three).not.toContain('Tag images');
});

test('a task without a description still reads as a task', () => {
  expect(render([task('bwait', '  ')])).toContain('Unnamed task');
});

test('renders nothing without tasks', () => {
  expect(render([])).toBe('');
});
