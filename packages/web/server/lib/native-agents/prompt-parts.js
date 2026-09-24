// Converts the parts of a prompt sent to a native session into what each CLI
// accepts. Text passes through. An image goes as an image; Claude also takes
// a PDF as a document. A text file sent inline is decoded into the prompt, and
// a file referenced by path is named in the prompt for the agent to read. An
// attachment the CLI cannot take is refused rather than dropped.

import { fileURLToPath } from 'node:url';

import { invalidRequestError } from './errors.js';

const DATA_URL = /^data:([^;,]+)(;base64)?,(.*)$/s;

/** @typedef {{ type: 'text', text: string } | { type: 'file', mime: string, url: string, filename?: string }} PromptPart */

const decodeDataUrl = (url) => {
  const match = DATA_URL.exec(url);
  if (!match) return null;
  const [, mime, base64, payload] = match;
  return { mime, base64: base64 ? payload : Buffer.from(decodeURIComponent(payload)).toString('base64') };
};

const fileTextBlock = (name, text) => `Attached file ${name}:\n\n${text}`;

// Instructions an OpenChamber feature sends with a prompt, such as the btw
// boundary. They go after what the user wrote, so the user's parts keep their
// ids, and the projectors leave the block out of the conversation, as OpenCode
// hides a synthetic part. OpenChamber's general context never goes this way.
const INSTRUCTIONS_OPEN = '<openchamber-instructions>';
const INSTRUCTIONS_CLOSE = '</openchamber-instructions>';

/** Whether a prompt text block holds a feature's instructions. */
export const isInstructionsBlock = (text) => text.startsWith(INSTRUCTIONS_OPEN) && text.trimEnd().endsWith(INSTRUCTIONS_CLOSE);

/**
 * The prompt's parts with a feature's instructions appended.
 * @param {PromptPart[]} parts
 * @param {string | undefined} instructions
 * @returns {PromptPart[]}
 */
export const withInstructions = (parts, instructions) => (instructions === undefined
  ? parts
  : [...parts, { type: 'text', text: `${INSTRUCTIONS_OPEN}\n${instructions}\n${INSTRUCTIONS_CLOSE}` }]);

const pathOf = (url) => {
  try {
    return url.startsWith('file://') ? fileURLToPath(url) : null;
  } catch {
    return null;
  }
};

const unsupported = (cli, part) => invalidRequestError(
  `${cli} cannot take ${part.filename ?? 'this attachment'} (${part.mime}). Send images${cli === 'Claude Code' ? ', PDFs' : ''} or text files.`,
);

/**
 * Claude content blocks, which the projector also renders the user message
 * from, so the prompt looks the same live and in history.
 * @param {PromptPart[]} parts
 */
export const claudePromptBlocks = (parts) => {
  const blocks = [];
  for (const part of parts) {
    if (part.type === 'text') {
      if (part.text !== '') blocks.push({ type: 'text', text: part.text });
      continue;
    }
    const path = pathOf(part.url);
    if (path !== null) {
      blocks.push({ type: 'text', text: `Attached file: ${path}` });
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

/**
 * Codex user input items.
 * @param {PromptPart[]} parts
 */
export const codexPromptInput = (parts) => {
  const input = [];
  for (const part of parts) {
    if (part.type === 'text') {
      if (part.text !== '') input.push({ type: 'text', text: part.text });
      continue;
    }
    const path = pathOf(part.url);
    if (path !== null) {
      input.push(part.mime.startsWith('image/') ? { type: 'localImage', path } : { type: 'text', text: `Attached file: ${path}` });
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
