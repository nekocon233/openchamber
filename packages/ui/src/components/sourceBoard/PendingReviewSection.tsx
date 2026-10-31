import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { useI18n } from '@/lib/i18n';
import type { GitHubPendingReviewAction, GitHubPendingReviewComment } from '@/lib/source-control/pendingReview';
import { usePendingReviewDraftStore } from '@/stores/usePendingReviewDraftStore';
import type { PendingReviewController } from './usePendingReview';

const ReviewComment: React.FC<{ comment: GitHubPendingReviewComment; controller: PendingReviewController }> = ({ comment, controller }) => {
  const { t } = useI18n();
  const [editing, setEditing] = React.useState(false);
  const draftKey = `${controller.key}:edit:${comment.id}`;
  const saved = usePendingReviewDraftStore(state => state.texts[draftKey]);
  const text = saved ?? comment.body;
  const review = controller.data?.review;
  const write = async (kind: 'edit' | 'delete') => {
    if (!review || !controller.data) return;
    const action: GitHubPendingReviewAction = kind === 'edit'
      ? { kind, reviewId: review.id, version: review.version, commentId: comment.id, body: text }
      : { kind, reviewId: review.id, version: review.version, commentId: comment.id };
    if (await controller.mutate(action, controller.data.headSha)) {
      usePendingReviewDraftStore.getState().clearText(draftKey);
      setEditing(false);
    }
  };
  return <div className="rounded-md border border-border/60 p-2.5">
    <div className="mb-2 flex min-w-0 items-center gap-2 typography-micro text-muted-foreground">
      <span dir="ltr" className="min-w-0 flex-1 break-all font-mono">{comment.path}{comment.line ? `:${comment.startLine && comment.startLine !== comment.line ? `${comment.startLine}-` : ''}${comment.line}` : ''}</span>
      {comment.outdated ? <span>{t('pendingReview.outdated')}</span> : null}
      <Button size="icon" variant="ghost" disabled={controller.busy} onClick={() => setEditing(true)} aria-label={t('inlineComment.actions.editComment')}>
        <Icon name="edit" className="size-3.5" />
      </Button>
      <Button size="icon" variant="ghost" disabled={controller.busy || Boolean(controller.readError)} onClick={() => void write('delete')} aria-label={t('inlineComment.actions.deleteComment')}>
        <Icon name="delete-bin" className="size-3.5" />
      </Button>
    </div>
    {editing ? <>
      <Textarea value={text} disabled={controller.busy} rows={3} aria-label={t('inlineComment.actions.editComment')} onChange={event => {
        if (!usePendingReviewDraftStore.getState().setText(draftKey, event.target.value)) toast.error(t('pendingReview.draftLimit'));
      }} />
      <div className="mt-2 flex justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={controller.busy} onClick={() => { setEditing(false); usePendingReviewDraftStore.getState().clearText(draftKey); }}>{t('references.picker.actions.cancel')}</Button>
        <Button size="sm" disabled={controller.busy || Boolean(controller.readError) || !text.trim()} onClick={() => void write('edit')}>{t('pendingReview.save')}</Button>
      </div>
    </> : <SimpleMarkdownRenderer content={comment.body} enableFileReferences={false} />}
  </div>;
};

/** A review is submitted once, with every saved inline comment and its summary. */
export const PendingReviewSection: React.FC<{ controller: PendingReviewController; onSubmitted: () => void }> = ({ controller, onSubmitted }) => {
  const { t } = useI18n();
  const confirmation = useConfirmDialog();
  const summaryKey = `${controller.key}:summary`;
  const saved = usePendingReviewDraftStore(state => state.texts[summaryKey]);
  const { data, busy, readError, error } = controller;
  const review = data?.review;
  const text = saved ?? review?.body ?? '';
  if (!controller.key) return null;
  if (!review || !data) return readError ? <div className="flex items-center gap-2 border-t border-border/60 pt-3 typography-meta text-muted-foreground">
    <span className="flex-1">{t('pendingReview.loadFailed')}</span>
    <Button size="sm" variant="outline" onClick={() => void controller.refresh()}>{t('references.picker.actions.retry')}</Button>
  </div> : null;
  const submit = async (verdict: 'comment' | 'approve' | 'request-changes') => {
    const action: GitHubPendingReviewAction = { kind: 'submit', reviewId: review.id, version: review.version, verdict };
    if (text.trim()) action.body = text;
    if (await controller.mutate(action, data.headSha)) {
      usePendingReviewDraftStore.getState().clearText(summaryKey);
      toast.success(t('pendingReview.submitted'));
      onSubmitted();
    }
  };
  const discard = async () => {
    const approved = await confirmation.confirm({ title: t('pendingReview.discard'), message: t('pendingReview.discardConfirm'), action: t('pendingReview.discard'), destructive: true });
    if (!approved) return;
    if (await controller.mutate({ kind: 'discard', reviewId: review.id, version: review.version }, data.headSha)) {
      usePendingReviewDraftStore.getState().clearText(summaryKey); onSubmitted();
    }
  };
  return <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface-elevated p-3" aria-label={t('pendingReview.title')}>
    <div className="flex items-center gap-2">
      <Icon name={busy ? 'loader-4' : 'git-pull-request'} className={`size-4 text-muted-foreground${busy ? ' animate-spin' : ''}`} />
      <h4 className="flex-1 typography-ui-label font-semibold">{t('pendingReview.title')}</h4>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void discard()}>{t('pendingReview.discard')}</Button>
    </div>
    <p className="typography-meta text-muted-foreground">{t('pendingReview.private')}</p>
    {review.headSha !== data.headSha ? <p className="typography-meta text-[var(--status-warning-text)]">{t('pendingReview.older')}</p> : null}
    <details>
      <summary className="cursor-pointer typography-ui-label">{t('pendingReview.comments', { count: review.comments.length })}</summary>
      <div className="mt-2 flex flex-col gap-2">{review.comments.map(comment => <ReviewComment key={comment.id} comment={comment} controller={controller} />)}</div>
    </details>
    <Textarea value={text} rows={3} disabled={busy} aria-label={t('pendingReview.summary')} placeholder={t('pendingReview.placeholder')} onChange={event => {
      if (!usePendingReviewDraftStore.getState().setText(summaryKey, event.target.value)) toast.error(t('pendingReview.draftLimit'));
    }} />
    {readError ? <div className="flex items-center gap-2 typography-meta text-[var(--status-error-text)]">
      <span className="flex-1">{t('pendingReview.loadFailed')}</span>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void controller.refresh()}>{t('references.picker.actions.retry')}</Button>
    </div> : null}
    {error ? <p role="alert" className="typography-meta text-[var(--status-error-text)]">{error}</p> : null}
    {data.ownPull ? <p className="typography-meta text-muted-foreground">{t('pendingReview.ownPull')}</p> : null}
    <div className="flex flex-wrap justify-end gap-2">
      <Button size="sm" variant="outline" disabled={busy || !data.open || Boolean(readError)} onClick={() => void submit('comment')}>{t('pendingReview.submitComment')}</Button>
      <Button size="sm" variant="outline" disabled={busy || !data.open || data.ownPull || Boolean(readError)} onClick={() => void submit('approve')}>{t('sourceBoard.reply.approve')}</Button>
      <Button size="sm" disabled={busy || !data.open || data.ownPull || Boolean(readError) || !text.trim()} onClick={() => void submit('request-changes')}>
        {t('sourceBoard.reply.requestChanges')}
      </Button>
    </div>
    {confirmation.dialog}
  </section>;
};
