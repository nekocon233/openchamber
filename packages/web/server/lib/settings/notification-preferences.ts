import type { SettingsDocument } from './settings-helpers.js';
import { isString } from '../shared/object-guards.js';

type NotificationTemplate = { title: string; message: string };

type NotificationTemplates = Record<string, NotificationTemplate>;

export const hasFields = (value: unknown): value is SettingsDocument => Boolean(value && typeof value === 'object');

const hasTemplateFields = (value: unknown): value is { title?: unknown; message?: unknown } => value != null;

const EMPTY_NOTIFICATION_TEMPLATES = {
  completion: { title: '', message: '' },
  error: { title: '', message: '' },
  question: { title: '', message: '' },
  subtask: { title: '', message: '' },
};

export const emptyNotificationTemplates = () => Object.fromEntries(
  Object.entries(EMPTY_NOTIFICATION_TEMPLATES).map(([event, template]) => [event, { ...template }]),
);

const LEGACY_SEEDED_NOTIFICATION_TEMPLATES = {
  completion: { title: '{agent_name} is ready', message: '{model_name} completed the task' },
  error: { title: 'Tool error', message: '{last_message}' },
  question: { title: 'Input needed', message: '{last_message}' },
  subtask: { title: '{agent_name} is ready', message: '{model_name} completed the task' },
};

export const isLegacySeededNotificationTemplates = (templates: NotificationTemplates) => (
  Object.entries(LEGACY_SEEDED_NOTIFICATION_TEMPLATES).every(([event, legacy]) => {
    const candidate = templates?.[event];
    return candidate?.title === legacy.title && candidate?.message === legacy.message;
  })
);

export const normalizeNotificationTemplates = (templates: SettingsDocument[string]) => {
  const input = hasFields(templates) ? templates : {};
  let changed = false;
  const next: NotificationTemplates = {};

  for (const [event, base] of Object.entries(EMPTY_NOTIFICATION_TEMPLATES)) {
    const currentEntry = input[event];
    const currentTitle = hasTemplateFields(currentEntry) && isString(currentEntry.title) ? currentEntry.title : base.title;
    const currentMessage = hasTemplateFields(currentEntry) && isString(currentEntry.message) ? currentEntry.message : base.message;
    if (!currentEntry || !hasTemplateFields(currentEntry) || !isString(currentEntry.title) || !isString(currentEntry.message)) {
      changed = true;
    }
    next[event] = { title: currentTitle, message: currentMessage };
  }

  return { templates: next, changed };
};
