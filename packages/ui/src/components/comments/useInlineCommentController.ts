import { WorkspaceViewScope, useWorkspaceViewState } from '@/hooks/useWorkspaceViewState';
import { useWorkspaceViewStateStore } from '@/stores/useWorkspaceViewStateStore';
import React from 'react';
import { toast } from '@/components/ui';
import {
  EMPTY_INLINE_COMMENT_DRAFTS,
  getInlineCommentDraftKey,
  useInlineCommentDraftStore,
  type InlineCommentDraft,
  type InlineCommentSource,
} from '@/stores/useInlineCommentDraftStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useI18n } from '@/lib/i18n';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useComposerDraftTarget } from '@/hooks/useComposerAddress';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { focusChatInput } from '@/components/chat/composer/editor/dom';
import { diffCommentOriginKey, type DiffCommentOrigin } from '@/lib/diffCommentOrigin';

type LineRangeBase = {
  start: number;
  end: number;
};

type StoreRange = {
  startLine: number;
  endLine: number;
  side?: 'original' | 'modified';
};

interface UseInlineCommentControllerOptions<TRange extends LineRangeBase> {
  source: InlineCommentSource;
  fileLabel: string | null;
  language: string;
  getCodeForRange: (range: TRange) => string;
  toStoreRange: (range: TRange) => StoreRange;
  fromDraftRange: (draft: InlineCommentDraft) => TRange;
  /** The diff these comments are written on; absent for uncommitted changes. */
  origin?: DiffCommentOrigin;
}

const normalizeStoreRange = (range: StoreRange): StoreRange => {
  const startLine = Math.min(range.startLine, range.endLine);
  const endLine = Math.max(range.startLine, range.endLine);
  return {
    ...range,
    startLine,
    endLine,
  };
};

export const normalizeLineRange = <TRange extends LineRangeBase>(range: TRange): TRange => {
  const start = Math.min(range.start, range.end);
  const end = Math.max(range.start, range.end);
  return {
    ...range,
    start,
    end,
  };
};

export function useInlineCommentController<TRange extends LineRangeBase>(
  options: UseInlineCommentControllerOptions<TRange>
) {
  const { t } = useI18n();
  const { source, fileLabel, language, getCodeForRange, toStoreRange, fromDraftRange, origin } = options;
  // The same path in a pull request and on disk are different lines, so a
  // comment shows only on the diff it was written on.
  const originKey = diffCommentOriginKey(origin);

  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const effectiveDirectory = useEffectiveDirectory();
  const sessionDirectory = useSessionUIStore(
    React.useCallback(
      (state) => currentSessionId ? state.getDirectoryForSession(currentSessionId) : null,
      [currentSessionId],
    ),
  );

  const addDraft = useInlineCommentDraftStore((state) => state.addDraft);
  const updateDraft = useInlineCommentDraftStore((state) => state.updateDraft);
  const removeDraft = useInlineCommentDraftStore((state) => state.removeDraft);

  const target = useComposerDraftTarget(sessionDirectory ?? effectiveDirectory);
  const targetKey = target
    ? getInlineCommentDraftKey(getRuntimeKey(), target.directory, target.sessionKey)
    : null;
  const viewScope = React.useContext(WorkspaceViewScope);
  const unfinishedKey = targetKey && fileLabel && (source === 'diff' || source === 'plan')
    ? JSON.stringify([targetKey, source, fileLabel, viewScope ?? originKey]) : null;
  const [storedRange, setStoredRange] = useWorkspaceViewState('comment', unfinishedKey, 'selection');
  const [commentText, setCommentText] = useWorkspaceViewState('comment', unfinishedKey, 'text');
  const [editingDraftId, setEditingDraftId] = useWorkspaceViewState('comment', unfinishedKey, 'editingDraftId');
  const [selectedCode, setSelectedCode] = useWorkspaceViewState('comment', unfinishedKey, 'code');
  const [selectedOrigin, setSelectedOrigin] = useWorkspaceViewState('comment', unfinishedKey, 'origin');
  const fromRangeRef = React.useRef(fromDraftRange);
  fromRangeRef.current = fromDraftRange;
  const candidate = React.useMemo(() => storedRange ? fromRangeRef.current({
    id: 'unfinished', sessionKey: '', source, fileLabel: fileLabel ?? '',
    ...storedRange, code: '', language, text: '', createdAt: 0,
  }) : null, [fileLabel, language, source, storedRange]);
  let currentCode: string | null = null;
  if (candidate) {
    try { currentCode = getCodeForRange(candidate); } catch { /* Wait for an available range. */ }
  }
  const changedCode = selectedCode !== null && (selectedCode !== currentCode || (selectedOrigin !== null && selectedOrigin !== originKey));
  const selection = changedCode ? null : candidate;
  const selectionRef = React.useRef(selection);
  selectionRef.current = selection;
  const rangeWriterRef = React.useRef({ getCodeForRange, toStoreRange });
  rangeWriterRef.current = { getCodeForRange, toStoreRange };
  const warned = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (unfinishedKey && changedCode && currentCode && warned.current !== unfinishedKey) {
      warned.current = unfinishedKey;
      toast.error(t('workspaceRestore.commentChanged'));
    }
  }, [changedCode, currentCode, t, unfinishedKey]);
  const setSelection = React.useCallback((update: React.SetStateAction<TRange | null>) => {
    const next = typeof update === 'function' ? update(selectionRef.current) : update;
    selectionRef.current = next;
    const range = next ? normalizeStoreRange(rangeWriterRef.current.toStoreRange(next)) : null;
    let code: string | null = null;
    if (next) { try { code = rangeWriterRef.current.getCodeForRange(next); } catch { /* A loading range has no baseline yet. */ } }
    if (unfinishedKey) useWorkspaceViewStateStore.getState().update('comment', unfinishedKey, previous => ({ ...previous, selection: range, code, origin: next ? originKey : null }));
    else { setStoredRange(range); setSelectedCode(code); setSelectedOrigin(next ? originKey : null); }
  }, [originKey, setSelectedCode, setSelectedOrigin, setStoredRange, unfinishedKey]);

  const sessionDrafts = useInlineCommentDraftStore(
    React.useCallback(
      (state) => targetKey ? state.drafts[targetKey] ?? EMPTY_INLINE_COMMENT_DRAFTS : EMPTY_INLINE_COMMENT_DRAFTS,
      [targetKey],
    ),
  );

  const drafts = React.useMemo(() => {
    if (!target || !fileLabel) return [];
    return sessionDrafts.filter((draft) => (
      draft.source === source && draft.fileLabel === fileLabel && diffCommentOriginKey(draft.origin) === originKey
    ));
  }, [fileLabel, originKey, sessionDrafts, source, target]);

  const reset = React.useCallback(() => {
    if (unfinishedKey) {
      useWorkspaceViewStateStore.getState().update('comment', unfinishedKey, previous =>
        previous.selection === null && previous.code === null && previous.origin === null && !previous.text && previous.editingDraftId === null
          ? previous : { ...previous, selection: null, code: null, origin: null, text: '', editingDraftId: null });
    } else {
      setStoredRange(null); setSelectedCode(null); setSelectedOrigin(null); setCommentText(''); setEditingDraftId(null);
    }
  }, [setCommentText, setEditingDraftId, setSelectedCode, setSelectedOrigin, setStoredRange, unfinishedKey]);

  const cancel = React.useCallback(() => {
    reset();
  }, [reset]);

  const startEdit = React.useCallback((draft: InlineCommentDraft) => {
    const draftRange = normalizeLineRange(fromRangeRef.current(draft));
    setSelection(draftRange);
    setCommentText(draft.text);
    setEditingDraftId(draft.id);
  }, [setCommentText, setEditingDraftId, setSelection]);

  const deleteDraft = React.useCallback((draft: InlineCommentDraft) => {
    if (!target) return;
    removeDraft(target, draft.id);
    if (editingDraftId === draft.id) {
      reset();
    }
  }, [editingDraftId, removeDraft, reset, target]);

  const saveComment = React.useCallback((textToSave: string, rangeOverride?: TRange) => {
    const targetRange = rangeOverride ?? selection;
    const trimmedText = textToSave.trim();
    if (!targetRange || !trimmedText || !fileLabel) return;

    if (!target) {
      toast.error(t('inlineComment.toast.selectSessionToSave'));
      return;
    }

    const normalizedRange = normalizeLineRange(targetRange);
    const normalizedStoreRange = normalizeStoreRange(toStoreRange(normalizedRange));
    const code = getCodeForRange(normalizedRange);

    const isNewComment = !editingDraftId;
    if (editingDraftId) {
      updateDraft(target, editingDraftId, {
        fileLabel,
        startLine: normalizedStoreRange.startLine,
        endLine: normalizedStoreRange.endLine,
        side: normalizedStoreRange.side,
        code,
        language,
        text: trimmedText,
        origin,
      });
    } else {
      addDraft(target, {
        source,
        fileLabel,
        startLine: normalizedStoreRange.startLine,
        endLine: normalizedStoreRange.endLine,
        side: normalizedStoreRange.side,
        code,
        language,
        text: trimmedText,
        origin,
      });
    }

    reset();
    if (isNewComment) {
      requestAnimationFrame(focusChatInput);
    }
  }, [addDraft, editingDraftId, fileLabel, getCodeForRange, language, origin, reset, selection, source, t, target, toStoreRange, updateDraft]);

  return {
    drafts,
    selection,
    setSelection,
    commentText,
    setCommentText,
    editingDraftId,
    setEditingDraftId,
    reset,
    cancel,
    startEdit,
    deleteDraft,
    saveComment,
    fromDraftRange,
  };
}
