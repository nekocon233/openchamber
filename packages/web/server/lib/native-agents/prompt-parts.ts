import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { invalidRequestError } from './errors.js';
import type { NativeAgentError } from './errors.js';

const DATA_URL = /^data:([^;,]+)(;base64)?,(.*)$/s;

export type PromptFilePart = {
  type: 'file';
  mime: string;
  url: string;
  filename?: string | undefined;
};

export type PromptTextPart = {
  type: 'text';
  text: string;
};

export type PromptPart = PromptTextPart | PromptFilePart;

export type ClaudePromptBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string }; title: string };

export type CodexPromptInputItem =
  | { type: 'text'; text: string }
  | { type: 'localImage'; path: string }
  | { type: 'image'; url: string };

const decodeDataUrl = (url: string): { mime: string; base64: string } | null => {
  const match = DATA_URL.exec(url);
  if (!match) return null;
  const [, mime, base64, payload] = match;
  if (mime === undefined || payload === undefined) return null;
  return { mime, base64: base64 ? payload : Buffer.from(decodeURIComponent(payload)).toString('base64') };
};

const ATTACHMENT_TAG = 'openchamber-attachment-';
const USER_TEXT_TAG = 'openchamber-user-text-';
const LEGACY_ATTACHMENT_HEADER = /^Attached file ([^\r\n]+):\r?\n\r?\n/;
const attachmentFieldsSchema = z.object({ filename: z.string(), mime: z.string().regex(/^text\/[\w.+-]+$/) });

export type PromptTextAttachment = { type: 'file'; filename: string; mime: string; text: string | null };

const framedText = (prefix: string, fields: string, text: string): string => {
  const tag = prefix + createHash('sha256').update(text).digest('hex').slice(0, 16);
  return `<${tag}>${fields}\n${text}\n</${tag}>`;
};

const fileTextBlock = (filename: string, { mime, base64 }: { mime: string; base64: string }): string => (
  framedText(ATTACHMENT_TAG, JSON.stringify({ filename, mime }), Buffer.from(base64, 'base64').toString('utf8'))
);

const userTextBlock = (text: string): string => (
  text.includes(`<${ATTACHMENT_TAG}`) || text.includes(`<${USER_TEXT_TAG}`) || LEGACY_ATTACHMENT_HEADER.test(text)
    ? framedText(USER_TEXT_TAG, '', text)
    : text
);

export const promptTextAttachmentFile = ({ filename, mime, text }: PromptTextAttachment): PromptFilePart & { filename: string } => ({
  type: 'file',
  filename: filename.trim() ? filename : 'file',
  mime,
  url: text === null ? '' : `data:${mime};base64,${Buffer.from(text).toString('base64')}`,
});

const attachmentFields = (fields: string) => {
  try { return attachmentFieldsSchema.safeParse(JSON.parse(fields)).data ?? null; }
  catch { return null; }
};

const splitPromptTextAttachments = (text: string) => {
  const header = /<(openchamber-(?:attachment|user-text)-[0-9a-f]{16})>([^\r\n]*)\r?\n/g;
  const attachments: PromptTextAttachment[] = [];
  const visible: string[] = [];
  let cursor = 0;
  for (let match = header.exec(text); match; match = header.exec(text)) {
    const [, tag, fields] = match;
    if (!tag || fields === undefined) continue;
    const isUserText = tag.startsWith(USER_TEXT_TAG);
    if (isUserText && fields !== '') continue;
    const metadata = isUserText ? null : attachmentFields(fields);
    if (!isUserText && !metadata) continue;
    const start = header.lastIndex;
    const closing = `\n</${tag}>`;
    const end = text.indexOf(closing, start);
    const payload = end === -1 ? null : text.slice(start, end);
    visible.push(text.slice(cursor, match.index));
    cursor = end === -1 ? text.length : end + closing.length;
    if (metadata) {
      attachments.push({ type: 'file', ...metadata, text: payload });
      if (text.startsWith('\n\n', cursor)) cursor += 2;
    } else {
      visible.push(payload ?? text.slice(start));
    }
    header.lastIndex = cursor;
  }
  return { text: cursor === 0 ? text : visible.join('') + text.slice(cursor), attachments };
};

export const readPromptTextBlock = (text: string, allowLegacy: boolean): PromptTextAttachment | PromptTextPart | null => {
  if (text.startsWith(`<${USER_TEXT_TAG}`)) {
    const visible = splitPromptTextAttachments(text).text;
    return isInstructionsBlock(visible) ? null : { type: 'text', text: visible };
  }
  if (isInstructionsBlock(text)) return null;
  if (text.startsWith(`<${ATTACHMENT_TAG}`)) {
    const split = splitPromptTextAttachments(text);
    if (split.text === '' && split.attachments[0] && split.attachments.length === 1) return split.attachments[0];
  }
  const header = allowLegacy ? LEGACY_ATTACHMENT_HEADER.exec(text) : null;
  const filename = header?.[1];
  return filename && header ? { type: 'file', filename, mime: 'text/plain', text: text.slice(header[0].length) } : { type: 'text', text };
};

export const inlinePromptFileText = (part: Pick<PromptFilePart, 'mime' | 'url'>): string | null => {
  if (!part.mime.startsWith('text/') || !part.url.startsWith('data:text/')) return null;
  try {
    const data = decodeDataUrl(part.url);
    return data ? Buffer.from(data.base64, 'base64').toString('utf8') : null;
  } catch {
    return null;
  }
};

const INSTRUCTIONS_OPEN = '<openchamber-instructions>';
const INSTRUCTIONS_CLOSE = '</openchamber-instructions>';

export const isInstructionsBlock = (text: string): boolean => text.startsWith(INSTRUCTIONS_OPEN) && text.trimEnd().endsWith(INSTRUCTIONS_CLOSE);

export const withInstructions = (parts: PromptPart[], instructions: string | undefined): PromptPart[] => (instructions === undefined
  ? parts
  : [...parts, { type: 'text', text: `${INSTRUCTIONS_OPEN}\n${instructions}\n${INSTRUCTIONS_CLOSE}` }]);

const pathOf = (url: string): string | null => {
  try {
    return url.startsWith('file://') ? fileURLToPath(url) : null;
  } catch {
    return null;
  }
};

const unsupported = (cli: 'Claude Code' | 'Codex' | 'Antigravity', part: PromptFilePart): NativeAgentError => invalidRequestError(
  cli === 'Antigravity'
    ? `Antigravity cannot take ${part.filename ?? 'this attachment'} (${part.mime}). Send text files or file references.`
    : `${cli} cannot take ${part.filename ?? 'this attachment'} (${part.mime}). Send images${cli === 'Claude Code' ? ', PDFs' : ''} or text files.`,
);

export const claudePromptBlocks = (parts: ReadonlyArray<PromptPart>): ClaudePromptBlock[] => {
  const blocks: ClaudePromptBlock[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      if (part.text !== '') blocks.push({ type: 'text', text: userTextBlock(part.text) });
      continue;
    }
    const filePath = pathOf(part.url);
    if (filePath !== null) {
      blocks.push({ type: 'text', text: `Attached file: ${filePath}` });
      continue;
    }
    const data = decodeDataUrl(part.url);
    if (data?.mime.startsWith('image/')) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: data.mime, data: data.base64 } });
    } else if (data?.mime === 'application/pdf') {
      blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: data.base64 }, title: part.filename ?? 'document.pdf' });
    } else if (data?.mime.startsWith('text/')) {
      blocks.push({ type: 'text', text: fileTextBlock(part.filename ?? 'file', data) });
    } else {
      throw unsupported('Claude Code', part);
    }
  }
  if (blocks.length === 0) throw invalidRequestError('A prompt needs text or an attachment');
  return blocks;
};

export const codexPromptInput = (parts: ReadonlyArray<PromptPart>): CodexPromptInputItem[] => {
  const input: CodexPromptInputItem[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      if (part.text !== '') input.push({ type: 'text', text: userTextBlock(part.text) });
      continue;
    }
    const filePath = pathOf(part.url);
    if (filePath !== null) {
      input.push(part.mime.startsWith('image/') ? { type: 'localImage', path: filePath } : { type: 'text', text: `Attached file: ${filePath}` });
      continue;
    }
    const data = decodeDataUrl(part.url);
    if (data?.mime.startsWith('image/')) {
      input.push({ type: 'image', url: part.url });
    } else if (data?.mime.startsWith('text/')) {
      input.push({ type: 'text', text: fileTextBlock(part.filename ?? 'file', data) });
    } else {
      throw unsupported('Codex', part);
    }
  }
  if (input.length === 0) throw invalidRequestError('A prompt needs text or an attachment');
  return input;
};

export const antigravityImageReference = (path: string): string => (
  `Attached image: ${path}
Open it with read_file if you need to inspect it.`
);

export const antigravityPromptText = (
  parts: ReadonlyArray<PromptPart>,
  embeddedImage?: (part: PromptFilePart, data: { mime: string; base64: string }) => string,
): string => {
  const blocks: string[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      if (part.text !== '') blocks.push(userTextBlock(part.text));
      continue;
    }
    const filePath = pathOf(part.url);
    if (filePath !== null) {
      blocks.push(part.mime.startsWith('image/') ? antigravityImageReference(filePath) : `Attached file: ${filePath}`);
      continue;
    }
    const data = decodeDataUrl(part.url);
    if (data?.mime.startsWith('text/')) {
      blocks.push(fileTextBlock(part.filename ?? 'file', data));
    } else if (data?.mime.startsWith('image/') && embeddedImage) {
      blocks.push(embeddedImage(part, data));
    } else {
      throw unsupported('Antigravity', part);
    }
  }
  if (blocks.length === 0) throw invalidRequestError('A prompt needs text or an attachment');
  return blocks.join('\n\n');
};

export const antigravityVisiblePromptText = (text: string, expectedPlanFingerprint?: string): string => {
  const closed = /^\s*<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>\s*(?:<(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)\b[\s\S]*)?$/.exec(text);
  const closedBody = closed?.[1];
  const unclosed = closed ? null : /^\s*<USER_REQUEST>\s*([\s\S]*)$/.exec(text)?.[1];
  const request = (closedBody !== undefined ? closedBody : unclosed ?? text)
    .replace(/<openchamber-instructions>[\s\S]*?(?:<\/openchamber-instructions>|$)/g, '');
  const visible = (closed
    ? request.replace(/(?:\r?\n)?<truncated \d+ bytes>\r?\n(?:(?!<truncated \d+ bytes>)[\s\S])*?<\/openchamber-instructions>\s*$/, '')
    : unclosed !== null && unclosed !== undefined && !unclosed.includes(INSTRUCTIONS_OPEN)
      ? request.replace(/(?:\r?\n)?<truncated \d+ bytes>\r?\n(?:(?!<truncated \d+ bytes>)[\s\S])*$/, '')
      : request)
    .replace(/\r\n/g, '\n')
    .trim();
  if (expectedPlanFingerprint === undefined) return visible;
  const original = visible === '/plan' ? '' : visible.startsWith('/plan ') ? visible.slice(6) : null;
  return original !== null && antigravityPromptFingerprint(original) === expectedPlanFingerprint ? original : visible;
};

export const antigravityPromptFingerprint = (text: string): string => createHash('sha256')
  .update(antigravityVisiblePromptText(text))
  .digest('hex');

export const antigravityDisplayPromptParts = (text: string, expectedPlanFingerprint?: string): PromptPart[] => {
  const split = splitPromptTextAttachments(text);
  let visible = antigravityVisiblePromptText(split.text, expectedPlanFingerprint);
  if (split.text !== text && expectedPlanFingerprint !== undefined && /^\/plan(?: |$)/.test(visible)
    && antigravityVisiblePromptText(text, expectedPlanFingerprint) !== antigravityVisiblePromptText(text)) {
    visible = visible.replace(/^\/plan(?: |$)/, '').trimStart();
  }
  return [
    ...(visible ? [{ type: 'text' as const, text: visible }] : []),
    ...split.attachments.map(promptTextAttachmentFile),
  ];
};
