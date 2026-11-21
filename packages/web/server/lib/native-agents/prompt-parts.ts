import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

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

const fileTextBlock = (name: string, text: string): string => `Attached file ${name}:\n\n${text}`;

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
      if (part.text !== '') blocks.push({ type: 'text', text: part.text });
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
      blocks.push({ type: 'text', text: fileTextBlock(part.filename ?? 'file', Buffer.from(data.base64, 'base64').toString('utf8')) });
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
      if (part.text !== '') input.push({ type: 'text', text: part.text });
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
      input.push({ type: 'text', text: fileTextBlock(part.filename ?? 'file', Buffer.from(data.base64, 'base64').toString('utf8')) });
    } else {
      throw unsupported('Codex', part);
    }
  }
  if (input.length === 0) throw invalidRequestError('A prompt needs text or an attachment');
  return input;
};

export const antigravityPromptText = (parts: ReadonlyArray<PromptPart>): string => {
  const blocks: string[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      if (part.text !== '') blocks.push(part.text);
      continue;
    }
    const filePath = pathOf(part.url);
    if (filePath !== null) {
      if (part.mime.startsWith('image/')) throw unsupported('Antigravity', part);
      blocks.push(`Attached file: ${filePath}`);
      continue;
    }
    const data = decodeDataUrl(part.url);
    if (data?.mime.startsWith('text/')) {
      blocks.push(fileTextBlock(part.filename ?? 'file', Buffer.from(data.base64, 'base64').toString('utf8')));
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
