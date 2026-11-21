import { z } from 'zod';
import { isRecord, isString } from '../shared/object-guards.js';
import type { ScheduledTaskProvenance } from '../scheduled-tasks/existing-session.js';

const CONTENT_CHAR_LIMIT = 200_000;

const ATTACHMENT_SOURCES = new Set(['local', 'server', 'vscode']);

const CONTEXT_PART_KINDS = new Set(['context', 'instruction', 'synthetic']);

const MESSAGE_ID_PATTERN = /^msg_[A-Za-z0-9]{8,64}$/;

export interface QueueSendConfig {
  providerID?: string;
  modelID?: string;
  agent?: string;
  variant?: string;
}

export interface QueuedGoal {
  tokenBudget: number | null;
  objective?: string;
}

export interface QueuedAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  source: 'local' | 'server' | 'vscode';
  serverPath?: string;
  agentPath?: string;
  dataUrl: string;
}

export type QueuedContextPart =
  | { kind: 'context'; text: string; metadata: QueueRecord; instructions?: string }
  | { kind: 'instruction' | 'synthetic'; text: string; metadata?: never };

export interface QueuedItemInput {
  content: string;
  text: string;
  agentMention?: string;
  attachments: QueuedAttachment[];
  context: QueuedContextPart[];
  contextPreview?: string;
  sendConfig: QueueSendConfig;
  goal?: QueuedGoal;
  scheduledTask?: ScheduledTaskProvenance;
}

export interface QueuedItem extends QueuedItemInput {
  id: string;
  createdAt: number;
  syntheticIds?: string[];
  deliveryId?: string;
}

export interface PublicQueuedItem extends Omit<QueuedItem, 'context' | 'syntheticIds' | 'deliveryId' | 'attachments'> {
  attachments: Omit<QueuedAttachment, 'dataUrl'>[];
}

export interface SessionQueue {
  directory: string;
  items: QueuedItem[];
}

const textSchema = z.unknown().transform((value) => isString(value) ? value : '');

export const asNonEmptyString = z.unknown().transform((value) => isString(value) && value.trim() ? value.trim() : '').parse;

const asText = textSchema.parse;

const recordSchema = z.unknown().transform((value) => isRecord(value) ? value : null);

export const asRecord = recordSchema.parse;

export type QueueRecord = NonNullable<z.output<typeof recordSchema>>;

export const isList = (value: unknown): value is unknown[] => Array.isArray(value);

export const listSchema = z.unknown().transform((value) => isList(value) ? value : null);

export const asList = listSchema.parse;

const isFiniteNumber = (value: unknown): value is number => Number.isFinite(value);

export const asCount = z.unknown().transform((value) => isFiniteNumber(value) && value >= 0 ? Math.floor(value) : null).parse;

export const hasReadableFields = (value: unknown): value is { agent?: unknown; code?: unknown; message?: unknown; status?: unknown; statusCode?: unknown } => value !== null && typeof value === 'object';

export const isInteger = (value: unknown): value is number => Number.isInteger(value);

const sendConfigSchema = z.unknown().transform((value): QueueSendConfig | null => {
  const raw = asRecord(value);
  if (!raw) return null;
  const providerID = asNonEmptyString(raw.providerID);
  const modelID = asNonEmptyString(raw.modelID);
  if (!providerID || !modelID) return null;
  const sendConfig: QueueSendConfig = { providerID, modelID };
  const agent = asNonEmptyString(raw.agent);
  if (agent) sendConfig.agent = agent;
  const variant = asNonEmptyString(raw.variant);
  if (variant) sendConfig.variant = variant;
  return sendConfig;
});

const parseSendConfig = sendConfigSchema.parse;

const goalSchema = z.unknown().transform((value): QueuedGoal | null => {
  if (value === undefined) return null;
  const raw = asRecord(value);
  if (!raw) throw new TypeError('invalid goal');
  const tokenBudget = raw.tokenBudget ?? null;
  if (tokenBudget !== null && !(isInteger(tokenBudget) && tokenBudget > 0)) throw new TypeError('invalid goal tokenBudget');
  const goal: QueuedGoal = { tokenBudget };
  const objective = asNonEmptyString(raw.objective);
  if (objective) goal.objective = objective;
  return goal;
});

const parseGoal = goalSchema.parse;

const isAttachmentSource = (value: unknown): value is QueuedAttachment['source'] => isString(value) && ATTACHMENT_SOURCES.has(value);

const isContextKind = (value: unknown): value is QueuedContextPart['kind'] => isString(value) && CONTEXT_PART_KINDS.has(value);

const attachmentSchema = z.unknown().transform((value): QueuedAttachment | null => {
  const raw = asRecord(value);
  if (!raw) return null;
  const filename = asNonEmptyString(raw.filename);
  const mimeType = asNonEmptyString(raw.mimeType);
  const dataUrl = asText(raw.dataUrl);
  if (!filename || !mimeType || !dataUrl) return null;
  const attachment: Omit<QueuedAttachment, 'dataUrl'> = {
    id: asNonEmptyString(raw.id) || `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    filename,
    mimeType,
    size: asCount(raw.size) ?? 0,
    source: isAttachmentSource(raw.source) ? raw.source : 'local',
  };
  const serverPath = asNonEmptyString(raw.serverPath);
  if (serverPath) attachment.serverPath = serverPath;
  const agentPath = asNonEmptyString(raw.agentPath);
  if (agentPath) attachment.agentPath = agentPath;
  return Object.assign(attachment, { dataUrl });
});

const parseAttachment = attachmentSchema.parse;

const contextPartSchema = z.unknown().transform((value): QueuedContextPart | null => {
  const raw = asRecord(value);
  if (!raw || !isContextKind(raw.kind)) return null;
  const text = asText(raw.text);
  if (raw.kind !== 'context') return { kind: raw.kind, text };
  const metadata = asRecord(raw.metadata);
  if (!metadata) return null;
  const part: QueuedContextPart = { kind: 'context', text, metadata };
  const instructions = asNonEmptyString(raw.instructions);
  if (instructions) part.instructions = instructions;
  return part;
});

const parseContextPart = contextPartSchema.parse;

const queuedItemInputSchema = z.unknown().transform((value): QueuedItemInput => {
  const raw = asRecord(value);
  if (!raw) throw new TypeError('item is required');
  const content = asText(raw.content).replace(/^\n+|\n+$/g, '');
  if (content.length > CONTENT_CHAR_LIMIT) throw new TypeError('item content is too long');
  const text = raw.text === undefined ? content : asText(raw.text);
  const attachments = (asList(raw.attachments) ?? []).map((entry) => parseAttachment(entry));
  if (!attachments.every((attachment) => attachment !== null)) throw new TypeError('invalid attachment');
  const context = (asList(raw.context) ?? []).map((entry) => parseContextPart(entry));
  if (!context.every((part) => part !== null)) throw new TypeError('invalid context part');
  if (!text.trim() && attachments.length === 0 && context.length === 0) {
    throw new TypeError('item needs text, attachments, or context');
  }
  const sendConfig = parseSendConfig(raw.sendConfig);
  const provenance = asRecord(raw.scheduledTask);
  const projectId = asNonEmptyString(provenance?.projectId);
  const taskId = asNonEmptyString(provenance?.taskId);
  if (provenance && (!projectId || !taskId)) throw new TypeError('invalid scheduledTask provenance');
  if (!sendConfig && !provenance) throw new TypeError('item sendConfig with providerID and modelID is required');
  const goal = parseGoal(raw.goal);
  if (goal && !text.trim()) throw new TypeError('a goal needs message text');
  const item: Omit<QueuedItemInput, 'attachments' | 'context' | 'sendConfig'> & Partial<Pick<QueuedItemInput, 'attachments' | 'context' | 'sendConfig'>> = { content, text };
  const agentMention = asNonEmptyString(raw.agentMention);
  if (agentMention) item.agentMention = agentMention;
  item.attachments = attachments;
  item.context = context;
  const contextPreview = asNonEmptyString(raw.contextPreview).slice(0, 103);
  if (contextPreview) item.contextPreview = contextPreview;
  item.sendConfig = sendConfig ?? {};
  if (goal) item.goal = goal;
  if (provenance) {
    item.scheduledTask = { projectId, taskId };
    const agent = asNonEmptyString(hasReadableFields(raw.sendConfig) ? raw.sendConfig.agent : undefined);
    if (agent) item.sendConfig.agent = agent;
  }
  return Object.assign(item, { attachments: item.attachments, context: item.context, sendConfig: item.sendConfig });
});

export const parseQueuedItemInput = queuedItemInputSchema.parse;

const storedItemSchema = z.unknown().transform((value): QueuedItem | null => {
  const raw = asRecord(value);
  const id = raw ? asNonEmptyString(raw.id) : '';
  if (!raw || !id) return null;
  try {
    const item: QueuedItem = { id, createdAt: asCount(raw.createdAt) ?? Date.now(), ...parseQueuedItemInput(raw) };
    const syntheticIds = asList(raw.syntheticIds) ?? [];
    if (syntheticIds.length > 0 && syntheticIds.every((entry): entry is string => MESSAGE_ID_PATTERN.test(asText(entry)))) item.syntheticIds = syntheticIds;
    const deliveryId = asNonEmptyString(raw.deliveryId);
    if (MESSAGE_ID_PATTERN.test(deliveryId)) item.deliveryId = deliveryId;
    return item;
  } catch {
    return null;
  }
});

export const parseStoredItem = storedItemSchema.parse;

const toPublicAttachment = ({ dataUrl: _dataUrl, ...attachment }: QueuedAttachment) => attachment;

export const toPublicItem = (item: QueuedItem) => {
  const publicItem: Omit<PublicQueuedItem, 'attachments' | 'sendConfig'> & Partial<Pick<PublicQueuedItem, 'attachments' | 'sendConfig'>> = { id: item.id, createdAt: item.createdAt, content: item.content, text: item.text };
  if (item.agentMention) publicItem.agentMention = item.agentMention;
  publicItem.attachments = item.attachments.map(toPublicAttachment);
  const contextPreview = item.contextPreview || item.context
    .filter((part) => part.kind !== 'instruction')
    .map((part) => asNonEmptyString(asRecord(part.metadata?.openchamberContext)?.text) || part.text.trim())
    .find(Boolean);
  if (contextPreview) {
    const [firstLine = ''] = contextPreview.split('\n', 1);
    publicItem.contextPreview = firstLine.slice(0, 100)
      + (contextPreview.length > firstLine.length || firstLine.length > 100 ? '...' : '');
  }
  publicItem.sendConfig = { ...item.sendConfig };
  if (item.goal) publicItem.goal = { ...item.goal };
  if (item.scheduledTask) publicItem.scheduledTask = { ...item.scheduledTask };
  return Object.assign(publicItem, { attachments: publicItem.attachments, sendConfig: publicItem.sendConfig });
};
