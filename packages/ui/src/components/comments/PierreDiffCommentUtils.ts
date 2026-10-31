import type { AnnotationSide, DiffLineAnnotation, SelectedLineRange } from '@pierre/diffs';
import type { InlineCommentDraft } from '@/stores/useInlineCommentDraftStore';
import type { GitHubPendingReviewComment } from '@/lib/source-control/pendingReview';

export type PierreAnnotationData =
  | { type: 'saved' | 'edit'; draft: InlineCommentDraft }
  | { type: 'review'; comment: GitHubPendingReviewComment }
  | { type: 'new'; selection: SelectedLineRange };

export const toPierreAnnotationId = (meta: PierreAnnotationData): string => {
  if (meta.type === 'review') return `review-${meta.comment.id}`;
  if (meta.type === 'new') {
    const start = Math.min(meta.selection.start, meta.selection.end);
    const end = Math.max(meta.selection.start, meta.selection.end);
    const side = meta.selection.side ?? 'additions';
    return `new-comment-${side}-${start}-${end}`;
  }

  return `draft-${meta.draft.id}`;
};

interface BuildPierreLineAnnotationsOptions {
  drafts: InlineCommentDraft[];
  editingDraftId: string | null;
  selection: SelectedLineRange | null;
  reviewComments?: readonly GitHubPendingReviewComment[];
}

export const buildPierreLineAnnotations = (
  options: BuildPierreLineAnnotationsOptions
): DiffLineAnnotation<PierreAnnotationData>[] => {
  const { drafts, editingDraftId, selection } = options;
  const annotations: DiffLineAnnotation<PierreAnnotationData>[] = [];
  for (const comment of options.reviewComments ?? []) {
    if (comment.line === null) continue;
    annotations.push({ lineNumber: comment.line, side: comment.side === 'LEFT' ? 'deletions' : 'additions', metadata: { type: 'review', comment } });
  }

  for (const draft of drafts) {
    if (!Number.isFinite(draft.endLine)) {
      continue;
    }

    const lineNumber = Math.max(1, Math.floor(draft.endLine));
    const side: AnnotationSide = draft.side === 'original' ? 'deletions' : 'additions';
    annotations.push({
      lineNumber,
      side,
      metadata: {
        type: draft.id === editingDraftId ? 'edit' : 'saved',
        draft,
      },
    });
  }

  if (selection && !editingDraftId) {
    annotations.push({
      lineNumber: Math.max(selection.start, selection.end),
      side: selection.side ?? 'additions',
      metadata: { type: 'new', selection },
    });
  }

  return annotations;
};
