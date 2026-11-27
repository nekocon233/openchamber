import { z } from 'zod';

import type { PromptPart } from '../prompt-parts.js';

const CONTEXT_TITLE = 'Source control change request context (JSON)';
const CONTEXT_HEADER = CONTEXT_TITLE + '\n{\n  "identity": {';
const SEPARATOR = '\n\n';
const CONTEXT_START = SEPARATOR + CONTEXT_HEADER;
const CHANGE_REQUEST_START = '\n  "changeRequest": {\n';
const TRUNCATED_CONTENT = /\n<truncated \d+ bytes>(?:\r?\n|$)/;

const referenceSchema = z.object({
  kind: z.literal('change-request'),
  provider: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  number: z.number().int().positive(),
  title: z.string(),
  url: z.url({ protocol: /^https?$/ }),
});

type ChangeRequestPart = { type: 'text'; text: string; reference: z.infer<typeof referenceSchema> };
export type AntigravityDisplayPromptPart = PromptPart | ChangeRequestPart;

const namesLinkedRequest = (text: string, url: string): boolean => {
  const target = new URL(url);
  const path = target.pathname.toLowerCase().replace(/\/$/, '');
  for (const link of text.matchAll(/https?:\/\/[^\s<>()[\]"`']+/gi)) {
    const parsed = URL.parse(link[0].replace(/[.,;:!?*_~]+$/, ''));
    if (parsed?.host !== target.host) continue;
    const candidate = parsed.pathname.toLowerCase();
    if (candidate === path || candidate.startsWith(`${path}/`)) return true;
  }
  return false;
};

const changeRequestPart = (text: string, prompt: string): ChangeRequestPart | null => {
  if (!text.startsWith(CONTEXT_HEADER)) return null;
  const start = text.indexOf(CHANGE_REQUEST_START);
  if (start === -1) return null;
  const fieldsStart = start + CHANGE_REQUEST_START.length;
  const end = text.indexOf('\n  }', fieldsStart);
  const fields = text.slice(fieldsStart, end === -1 ? undefined : end);
  const properties = fields.match(/^ {4}"(?:provider|number|title|url)": [^\n]+?(?=,?$)/gm);
  if (!properties) return null;
  try {
    const raw: unknown = JSON.parse(`{"kind":"change-request",${properties.join(',')}}`);
    const reference = referenceSchema.safeParse(raw).data;
    return reference && namesLinkedRequest(prompt, reference.url) ? { type: 'text', text, reference } : null;
  } catch {
    return null;
  }
};

export const antigravityLivePromptParts = (parts: readonly PromptPart[]): AntigravityDisplayPromptPart[] => {
  const primary = parts.find((part) => part.type === 'text');
  return parts.map((part) => (
    primary && part !== primary && part.type === 'text' ? changeRequestPart(part.text, primary.text) ?? part : part
  ));
};

export const literalChangeRequestHeaders = (parts: readonly PromptPart[]): number | undefined => {
  if (!parts.some((part) => part.type === 'text' && part.text.includes(CONTEXT_TITLE))) return undefined;
  const primary = parts.find((part) => part.type === 'text');
  return primary ? primary.text.trimStart().replaceAll('\r\n', '\n').split(CONTEXT_START).length - 1 : 0;
};

export const antigravitySavedPromptParts = (
  parts: PromptPart[],
  { content, truncated, literalHeaders }: { content: string; truncated: boolean; literalHeaders?: number | undefined },
): AntigravityDisplayPromptPart[] => {
  const primary = parts.find((part) => part.type === 'text');
  if (!primary) return parts;
  const { text } = primary;
  let firstStart = text.indexOf(CONTEXT_START);
  for (let skipped = 0; skipped < (literalHeaders ?? 0) && firstStart !== -1; skipped++) {
    firstStart = text.indexOf(CONTEXT_START, firstStart + CONTEXT_START.length);
  }
  if (firstStart === -1) return parts;
  const references: ChangeRequestPart[] = [];
  const visible: string[] = [];
  let prompt: string | undefined;
  let cursor = 0;
  let next = firstStart;
  while (next !== -1) {
    const start = next;
    next = text.indexOf(CONTEXT_START, start + CONTEXT_START.length);
    const close = text.indexOf('\n}', start + CONTEXT_START.length);
    const end = close === -1 ? text.length : close + 2;
    if (next !== -1 && next < end) continue;
    const clipped = close === -1 && (truncated || TRUNCATED_CONTENT.test(content));
    if (close === -1 && !clipped) break;
    if (!clipped && literalHeaders === undefined) continue;
    if (end !== text.length && !text.startsWith(SEPARATOR, end)) continue;
    const beforeContext = prompt ?? text.slice(0, start);
    const reference = changeRequestPart(text.slice(start + SEPARATOR.length, end), beforeContext);
    if (!reference) continue;
    prompt = beforeContext;
    references.push(reference);
    visible.push(text.slice(cursor, start));
    cursor = end;
  }
  if (!references.length) return parts;
  return [
    { type: 'text', text: visible.join('') + text.slice(cursor) },
    ...parts.filter((part) => part !== primary),
    ...references,
  ];
};
