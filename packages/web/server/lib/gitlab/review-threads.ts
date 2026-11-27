import type { JsonObject, JsonValue } from '../shared/json-values.js';
import { integer, isPlainObject, obj } from './merge-request-summary.js';
import type { Field, Reply } from './merge-request-summary.js';
import { isString } from './validation.js';

export type ReviewThreadPermissions = { resolve: Map<Field, boolean>; reply: boolean };

export function toReviewPerson(value: Reply | undefined) {
  const user = obj(value);
  return isString(user?.username) ? { login: user.username, avatarUrl: isString(user.avatar_url) ? user.avatar_url : undefined } : null;
}

export function positionOfNote(value: Field) {
  const position = obj(value);
  const path = position?.new_path ?? position?.old_path ?? '';
  if (position?.position_type === 'file') return { path, side: 'new', line: null, startLine: null };
  const side = Number.isInteger(position?.new_line) ? 'new' : 'old';
  const key = side === 'new' ? 'new_line' : 'old_line';
  const start = obj(obj(position?.line_range)?.start)?.[key];
  return { path, side, line: position?.[key] ?? null, startLine: integer(start) && start !== position?.[key] ? start : null };
}

export function discussionResolved(raw: Reply) {
  if (!isPlainObject(raw) || !Array.isArray(raw.notes)) return null;
  const resolvable = raw.notes.filter((note): note is JsonObject => isPlainObject(note) && note.resolvable === true);
  return resolvable.length > 0 && resolvable.every((note) => note.resolved === true);
}

export function projectReviewThreads(
  discussions: JsonValue[],
  { headSha, viewerId, requestUrl, permissions }: {
    headSha: Field;
    viewerId: Field;
    requestUrl: string;
    permissions: ReviewThreadPermissions | null;
  },
) {
  const viewerCommentedPaths = new Set<string>();
  const threads = discussions.flatMap((value) => {
    const discussion = obj(value);
    const entries = discussion?.notes;
    const notes = (Array.isArray(entries) ? entries : []).filter((note): note is JsonObject => isPlainObject(note) && note.system !== true);
    const [first] = notes;
    if (first?.type !== 'DiffNote' || !isPlainObject(first.position)) return [];
    const position = positionOfNote(first.position);
    if (isString(position.path) && viewerId != null && notes.some((note) => obj(note.author)?.id === viewerId)) {
      viewerCommentedPaths.add(position.path);
    }
    if (first.position.head_sha !== headSha) return [];
    return [{
      ...position,
      id: discussion?.id,
      resolved: discussionResolved(value) === true,
      canReply: permissions?.reply ?? false,
      canResolve: permissions?.resolve.get(discussion?.id) ?? false,
      comments: notes.map((note) => ({
        id: String(note.id),
        body: note.body,
        createdAt: note.created_at,
        url: `${requestUrl}#note_${note.id}`,
        author: toReviewPerson(note.author),
      })),
    }];
  });
  return { threads, viewerCommentedPaths: [...viewerCommentedPaths] };
}
