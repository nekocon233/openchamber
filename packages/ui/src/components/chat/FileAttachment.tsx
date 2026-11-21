import React, { memo } from 'react';
import { useDraftAttachedFiles, useInputStore } from '@/sync/input-store';
import { deleteWorkspaceUpload } from '@/sync/zip-attachments';
import type { ChatDraftIdentity } from '@/lib/chatDraftPersistence';
import type { AttachedFile } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { toast } from '@/components/ui';
import { cn } from '@/lib/utils';
import { formatFileSize } from '@/lib/fileSize';
import { isDrawioFile, isExcalidrawFile } from '@/lib/toolHelpers';
import { trackerPresentation } from '@/lib/trackers/presentation';
import { getIssueLinkKind, getRepositoryIssueLinkProvider, getTrackerItemLinkProvider, resolveAttachmentOpenTarget, type IssueLinkKind } from '@/lib/messages/attachmentPreview';
import { ProviderIcon } from '@/components/sourceControl/ProviderIcon';
import { useSourceControlProvider } from '@/lib/source-control/providers/registry';
import { useOpenAttachment } from './message/useOpenAttachment';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { StatusImage } from '@/components/ui/status-image';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Icon } from "@/components/icon/Icon";
import { useI18n } from '@/lib/i18n';
import { openExternalUrl } from '@/lib/url';
import { useMobileAppActions } from '@/apps/mobileAppContext';
import { parseChangeRequestReference } from '@/lib/source-control/changeRequestReference';
import { useOpenChatLink } from './useOpenChatLink';
import { useChatSessionSelection } from './chatColumnSession';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';

import type { ToolPopupContent } from './message/types';

interface ImagePreviewProps {
  file: AttachedFile;
  onRemove: () => void;
  onShowPopup?: (content: ToolPopupContent) => void;
  gallery?: NonNullable<ToolPopupContent['image']>['gallery'];
  index?: number;
}

const ImagePreview = memo(({ file, onRemove, onShowPopup, gallery, index = 0 }: ImagePreviewProps) => {
  const { t } = useI18n();
  const isLocalImagePreview =
    file.source !== 'server' &&
    file.mimeType.startsWith('image/') &&
    typeof file.dataUrl === 'string' &&
    file.dataUrl.startsWith('data:image/');

  const imageUrl = isLocalImagePreview ? file.dataUrl : (file.serverPath || '');

  const extractFilename = (path: string): string => {
    const normalized = path.replace(/\\/g, '/');
    const parts = normalized.split('/');
    return parts[parts.length - 1] || path;
  };

  const getFileExtension = (filename: string): string => {
    const parts = filename.split('.');
    return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
  };

  const displayName = extractFilename(file.filename);
  const extension = getFileExtension(file.filename);
  const handleOpenPreview = React.useCallback(() => {
    if (!onShowPopup || !imageUrl) return;

    onShowPopup({
      open: true,
      title: displayName || 'Image',
      content: '',
      metadata: {
        tool: 'image-preview',
        filename: displayName,
        mime: file.mimeType,
        size: file.size,
      },
      image: {
        url: imageUrl,
        mimeType: file.mimeType,
        filename: displayName,
        size: file.size,
        gallery,
        index,
      },
    });
  }, [displayName, file.mimeType, file.size, gallery, imageUrl, index, onShowPopup]);

  if (!imageUrl) {
    return (
      <button
        type="button"
        className="flex items-center gap-1.5 text-sm hover:opacity-80 transition-opacity text-start h-5"
      >
        <FileTypeIcon filePath={file.filename} extension={extension} className="h-4 w-4" />
        <span className="text-foreground truncate max-w-[200px]">
          {displayName}
        </span>
        <span
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="flex items-center justify-center h-5 w-5 flex-shrink-0 hover:bg-[var(--interactive-hover)] rounded-full transition-colors cursor-pointer"
          aria-label={t('chat.fileAttachment.actions.removeNamed', { name: displayName })}
        >
          <Icon name="close" className="h-4 w-4 text-muted-foreground" />
        </span>
      </button>
    );
  }

  return (
    <div
      role={onShowPopup ? 'button' : undefined}
      tabIndex={onShowPopup ? 0 : undefined}
      onClick={handleOpenPreview}
      onKeyDown={(event) => {
        if (!onShowPopup) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          handleOpenPreview();
        }
      }}
      className="relative h-16 w-16 rounded-lg border border-border/80 bg-background overflow-hidden flex-shrink-0 cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={displayName}
    >
      <img
        src={imageUrl}
        alt={displayName}
        className="h-full w-full object-cover"
        loading="lazy"
      />
      <button
        onClick={(event) => {
          event.stopPropagation();
          onRemove();
        }}
        className="absolute top-1 inset-e-1 h-5 w-5 rounded-md bg-background/80 text-foreground hover:bg-background flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        style={{ width: 20, height: 20, minWidth: 0, minHeight: 0 }}
        title={t('chat.fileAttachment.actions.removeImage')}
        aria-label={t('chat.fileAttachment.actions.removeNamed', { name: displayName })}
      >
        <Icon name="close" className="h-3.5 w-3.5" />
      </button>
    </div>
  );
});

ImagePreview.displayName = 'ImagePreview';

const useFileDetails = (file: AttachedFile) => {
  const getFileExtension = (filename: string): string => {
    const parts = filename.split('.');
    return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
  };

  const extractFilename = (path: string): string => {
    const normalized = path.replace(/\\/g, '/');
    const parts = normalized.split('/');
    const filename = parts[parts.length - 1];
    return filename || path;
  };

  return {
    displayName: extractFilename(file.filename),
    fileSize: formatFileSize(file.size),
    extension: getFileExtension(file.filename),
  };
};

interface FileChipProps {
  file: AttachedFile;
  onRemove: () => void;
}

const FileChip = memo(({ file, onRemove }: FileChipProps) => {
  const { t } = useI18n();
  const { displayName, fileSize, extension } = useFileDetails(file);
  const retryZipUpload = useInputStore((state) => state.retryZipUpload);

  const isWorkspaceUpload = file.delivery === 'workspace-upload';
  const isUploading = isWorkspaceUpload && file.uploadState === 'uploading';
  const isFailed = isWorkspaceUpload && file.uploadState === 'failed';
  const title = isFailed
    ? t('chat.fileAttachment.zip.uploadFailedTitle', { name: displayName })
    : isUploading
      ? t('chat.fileAttachment.zip.uploadingTitle', { name: displayName })
      : isWorkspaceUpload && file.workspacePath
        ? t('chat.fileAttachment.zip.uploadedTitle', { path: file.workspacePath })
        : displayName;

  return (
    <button
      type="button"
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('[data-remove-button]')) {
          return;
        }
        if (isFailed) {
          void retryZipUpload(file.id);
        }
      }}
      className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border/80 bg-background ps-2 pe-1 text-xs text-foreground text-start hover:opacity-90 transition-opacity"
      title={title}
    >
      {isUploading ? (
        <Icon name="loader-4" className="h-4 w-4 flex-shrink-0 animate-spin text-muted-foreground" />
      ) : isFailed ? (
        <Icon name="error-warning" className="h-4 w-4 flex-shrink-0 text-[var(--status-error)]" />
      ) : (
        <FileTypeIcon filePath={file.filename} extension={extension} className="h-4 w-4 flex-shrink-0" />
      )}
      <span className="truncate max-w-[200px]">{displayName}</span>
      {fileSize && <span className="text-muted-foreground flex-shrink-0">{fileSize}</span>}
      {isFailed && (
        <span className="text-muted-foreground flex-shrink-0">{t('chat.fileAttachment.zip.retry')}</span>
      )}
      <span
        data-remove-button
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="flex items-center justify-center h-5 w-5 flex-shrink-0 hover:bg-[var(--interactive-hover)] rounded-md transition-colors cursor-pointer"
        aria-label={t('chat.fileAttachment.actions.removeNamed', { name: displayName })}
      >
        <Icon name="close" className="h-3.5 w-3.5 text-muted-foreground" />
      </span>
    </button>
  );
});

FileChip.displayName = 'FileChip';

const VSCodeFileChip = memo(({ file, onRemove }: FileChipProps) => {
  const { t } = useI18n();
  const { displayName, extension } = useFileDetails(file);

  const isSelectionAttachment = /:\d+(?:-\d+)?$/.test(displayName);

  return (
    <button
      type="button"
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('[data-remove-button]')) {
          return;
        }
      }}
      className="inline-flex items-center gap-1 text-xs pe-1 rounded-sm border border-solid bg-transparent text-foreground not-italic hover:opacity-90 transition-colors text-start"
      style={{ borderColor: 'var(--interactive-border)' }}
      title={file.vscodePath}
    >
      <span
        data-remove-button
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="flex items-center justify-center h-5 w-5 flex-shrink-0 hover:bg-[var(--interactive-hover)] rounded-full transition-colors cursor-pointer"
        aria-label={t('chat.fileAttachment.activeEditor.remove')}
        title={t('chat.fileAttachment.activeEditor.remove')}
      >
        <Icon name="close" className="h-4 w-4 text-muted-foreground" />
      </span>
      <FileTypeIcon filePath={file.filename} extension={extension} className="h-4 w-4" />
      <span className={cn('text-foreground', isSelectionAttachment ? 'whitespace-nowrap' : 'truncate max-w-[200px]')}>
        {displayName}
      </span>
    </button>
  );
});

VSCodeFileChip.displayName = 'VSCodeFileChip';

interface AttachedFilesListProps {
  onShowPopup?: (content: ToolPopupContent) => void;
  className?: string;
  /** The composer draft whose files to show; its own even while another composer holds the slot. */
  draftIdentity?: ChatDraftIdentity | null;
}

const AttachedVSCodeFileChips = memo(({ onShowPopup, draftIdentity }: AttachedFilesListProps) => {
  const attachedFiles = useDraftAttachedFiles(draftIdentity);
  const removeAttachedFile = useInputStore((state) => state.removeAttachedFile);

  const vscodeFiles = attachedFiles.filter((file) => file.source === 'vscode');

  if (vscodeFiles.length === 0) return null;

  const images = vscodeFiles.filter((f) => f.mimeType.startsWith('image/'));
  const otherFiles = vscodeFiles.filter((f) => !f.mimeType.startsWith('image/'));
  const imageGallery = images.map((file) => ({
    url: file.dataUrl || file.serverPath || '',
    mimeType: file.mimeType,
    filename: file.filename,
    size: file.size,
  })).filter((image) => image.url);

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {images.map((file, index) => (
        <ImagePreview key={file.id} file={file} onRemove={() => removeAttachedFile(file.id)} onShowPopup={onShowPopup} gallery={imageGallery} index={index} />
      ))}
      {otherFiles.map((file) => (
        <VSCodeFileChip key={file.id} file={file} onRemove={() => removeAttachedFile(file.id)} />
      ))}
    </div>
  );
});

AttachedVSCodeFileChips.displayName = 'AttachedVSCodeFileChips';

const AttachedFilesList = memo(({ onShowPopup, className, draftIdentity }: AttachedFilesListProps) => {
  const attachedFiles = useDraftAttachedFiles(draftIdentity);
  const removeAttachedFile = useInputStore((state) => state.removeAttachedFile);

  const localFiles = attachedFiles.filter((file) => file.source !== 'server' && file.source !== 'vscode');

  if (localFiles.length === 0) return null;

  const images = localFiles.filter((f) => f.mimeType.startsWith('image/'));
  const otherFiles = localFiles.filter((f) => !f.mimeType.startsWith('image/'));
  const imageGallery = images.map((file) => ({
    url: file.dataUrl || file.serverPath || '',
    mimeType: file.mimeType,
    filename: file.filename,
    size: file.size,
  })).filter((image) => image.url);

  // Removing a workspace-uploaded zip also removes the scratch file; the copy
  // only exists to back this chip. Best-effort: leftovers are harmless.
  const removeFile = (file: AttachedFile) => {
    if (file.delivery === 'workspace-upload' && file.workspacePath) {
      deleteWorkspaceUpload(file.workspacePath);
    }
    removeAttachedFile(file.id);
  };

  return (
    <div className={cn('w-full space-y-2', className)}>
      {images.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          {images.map((file, index) => (
            <ImagePreview
              key={file.id}
              file={file}
              onRemove={() => removeFile(file)}
              onShowPopup={onShowPopup}
              gallery={imageGallery}
              index={index}
            />
          ))}
        </div>
      )}

      {otherFiles.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          {otherFiles.map((file) => (
            <FileChip
              key={file.id}
              file={file}
              onRemove={() => removeFile(file)}
            />
          ))}
        </div>
      )}
    </div>
  );
});

AttachedFilesList.displayName = 'AttachedFilesList';

export const ActiveEditorFileSuggestion = memo(() => {
  const { t } = useI18n();
  const activeEditorFile = useInputStore((s) => s.activeEditorFile);
  const attachedFiles = useInputStore((s) => s.attachedFiles);
  const addVSCodeFileAttachment = useInputStore((s) => s.addVSCodeFileAttachment);
  const addVSCodeSelectionAttachment = useInputStore((s) => s.addVSCodeSelectionAttachment);
  const isVSCodeRuntime = useRuntimeAPIs().runtime.isVSCode;

  if (!isVSCodeRuntime || !activeEditorFile) return null;

  const { filePath, fileName, relativePath, selection, fileSize } = activeEditorFile;

  const isFileAttached = attachedFiles.some(
    (f) => f.source === 'vscode' && f.vscodeSource === 'file' && (f.vscodePath || '') === filePath
  );

  let selectionRange = '';
  if (selection) {
    selectionRange = selection.startLine === selection.endLine
      ? `${selection.startLine}`
      : `${selection.startLine}-${selection.endLine}`;
  }
  const selectionLabel = selection ? `${relativePath}:${selectionRange}` : '';
  const isSelectionAttached = !!selectionLabel && attachedFiles.some(
    (f) => f.source === 'vscode' && f.vscodeSource === 'selection' && f.filename === selectionLabel && f.vscodePath === filePath
  );

  if (isFileAttached && (!selection || isSelectionAttached)) return null;

  const ext = fileName.split('.').pop() || '';
  const displayName = fileName;

  const handleAddFile = () => {
    try {
      addVSCodeFileAttachment(filePath, fileName, fileSize);
    } catch (error) {
      if (error instanceof Error) toast.error(error.message);
    }
  };

  const handlePinSelection = async () => {
    if (!selection) return;
    const blob = new Blob([selection.text], { type: 'text/plain' });
    const file = new File([blob], selectionLabel, { type: 'text/plain' });
    await addVSCodeSelectionAttachment(filePath, file);
  };

  const showSelectionPin = !!selection && !isSelectionAttached;
  const showFileAdd = !showSelectionPin && !isFileAttached;

  if (!showSelectionPin && !showFileAdd) return null;

  return (
    <div className="inline-flex items-center">
      {showSelectionPin && (
        <div
          className="inline-flex items-center gap-1 text-xs pe-1 rounded-sm italic text-muted-foreground border border-dashed bg-transparent"
          style={{ borderColor: 'var(--interactive-border)' }}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t('chat.fileAttachment.activeEditor.pinSelection')}
                onClick={() => { void handlePinSelection(); }}
                className="flex items-center justify-center h-5 w-5 flex-shrink-0 hover:bg-[var(--interactive-hover)] rounded-full transition-colors cursor-pointer"
              >
                <Icon name="pushpin-2" className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>{t('chat.fileAttachment.activeEditor.pinSelection')}</TooltipContent>
          </Tooltip>
          <FileTypeIcon filePath={fileName} extension={ext} className="h-4 w-4 flex-shrink-0" />
          <span className="text-xs whitespace-nowrap" title={relativePath}>{`${displayName}:${selectionRange}`}</span>
        </div>
      )}
      {showFileAdd && (
        <div
          className="inline-flex items-center gap-1 text-xs pe-1 rounded-sm italic text-muted-foreground border border-dashed bg-transparent"
          style={{ borderColor: 'var(--interactive-border)' }}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t('chat.fileAttachment.activeEditor.addFile', { name: displayName })}
                onClick={handleAddFile}
                className="flex items-center justify-center h-5 w-5 flex-shrink-0 hover:bg-[var(--interactive-hover)] rounded-full transition-colors cursor-pointer"
              >
                <Icon name="add" className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>{t('chat.fileAttachment.activeEditor.addFile', { name: displayName })}</TooltipContent>
          </Tooltip>
          <FileTypeIcon filePath={fileName} extension={ext} className="h-4 w-4 flex-shrink-0" />
          <span className="text-xs truncate max-w-[220px]" title={relativePath}>{displayName}</span>
        </div>
      )}
    </div>
  );
});

ActiveEditorFileSuggestion.displayName = 'ActiveEditorFileSuggestion';

interface FilePart {
  type: string;
  mime?: string;
  url?: string;
  filename?: string;
  size?: number;
  source?: Record<string, unknown>;
}

const issueLinkIcon = (kind: Exclude<IssueLinkKind, 'repository-issue' | 'tracker-item'>): 'git-pull-request' | 'attachment-2' => (
  kind === 'guest-issue' ? 'attachment-2' : 'git-pull-request'
);

const IssueLinkIcon: React.FC<{ file: { mime?: string }; kind: IssueLinkKind; className?: string }> = ({ file, kind, className }) => {
  const provider = useSourceControlProvider(getRepositoryIssueLinkProvider(file));
  if (kind === 'repository-issue') return <ProviderIcon descriptor={provider} className={className} />;
  if (kind === 'tracker-item') return <Icon name={trackerPresentation(getTrackerItemLinkProvider(file)).icon} className={className} />;
  return <Icon name={issueLinkIcon(kind)} className={className} />;
};

interface MessageFilesDisplayProps {
  files: FilePart[];
  onShowPopup?: (content: ToolPopupContent) => void;
  compact?: boolean;
  className?: string;
  showImageThumbnails?: boolean;
}

export const MessageFilesDisplay = memo(({ files, onShowPopup, compact = false, className, showImageThumbnails = true }: MessageFilesDisplayProps) => {
  const { t } = useI18n();
  const mobile = useMobileAppActions();
  const isMobile = useUIStore((state) => state.isMobile);
  const openChatLink = useOpenChatLink(useChatSessionSelection().directory ?? '');
  const openAttachment = useOpenAttachment(onShowPopup);

  const openReference = (url: string, event: React.MouseEvent) => {
    if (!mobile && !isMobile && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
      && parseChangeRequestReference(url)?.identity?.provider === 'github') {
      openChatLink(url);
    } else {
      void openExternalUrl(url);
    }
  };

  const fileItems = files.filter(f => f.type === 'file' && (f.mime || f.url));

  const extractFilename = (path?: string): string => {
    if (!path) return 'Unnamed file';

    const normalized = path.replace(/\\/g, '/');
    const parts = normalized.split('/');
    const filename = parts[parts.length - 1];

    return filename || path;
  };

  const resolveDisplayName = React.useCallback((file: FilePart): string => {
    const isIssueLink = getIssueLinkKind(file) !== null;
    if (isIssueLink && typeof file.filename === 'string' && file.filename.trim().length > 0) {
      return file.filename.trim();
    }
    return extractFilename(file.filename || file.url);
  }, []);

  const resolveOpenTarget = (file: FilePart) => {
    const target = resolveAttachmentOpenTarget(file, fileItems);
    return target?.kind === 'popup' && !onShowPopup ? null : target;
  };

  const showFilePopup = React.useCallback((file: FilePart, fileName: string) => {
    if (!onShowPopup || !file.url) {
      return;
    }

    const target = resolveAttachmentOpenTarget(file, [file]);
    if (target?.kind === 'popup' && !target.popup.image) {
      onShowPopup({ ...target.popup, title: fileName });
      return;
    }

    onShowPopup({
      open: true,
      title: fileName,
      content: '',
      image: {
        url: file.url,
        mimeType: file.mime,
        filename: fileName,
      },
    });
  }, [onShowPopup]);

  if (fileItems.length === 0) return null;

  if (compact) {
    const tileClass = 'relative flex-none snap-start h-16 rounded-lg overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-ring';
    return (
      <ScrollableOverlay outerClassName={cn('overlay-scrollbar-wrapper--no-gutter -mx-1 w-auto', className ?? 'mt-1.5')} className="px-1 py-0.5" fillContainer={false}>
        <div className="flex snap-x snap-mandatory gap-1.5">
          {fileItems.map((file, index) => {
            const fileName = resolveDisplayName(file) || 'File';
            const openTarget = resolveOpenTarget(file);
            const issueLinkKind = getIssueLinkKind(file);
            const showThumbnail = showImageThumbnails && file.mime?.startsWith('image/') && file.url && !issueLinkKind;
            const sizeText = formatFileSize(file.size);
            const ext = fileName.includes('.') ? fileName.split('.').pop() ?? '' : '';
            const kindText = [issueLinkKind ? null : ext.toUpperCase() || null, sizeText || null].filter(Boolean).join(' · ');
            const open = openTarget
              ? (event: React.MouseEvent) => {
                  if (openTarget.kind === 'external' && parseChangeRequestReference(openTarget.url)?.identity?.provider === 'github') {
                    openReference(openTarget.url, event);
                    return;
                  }
                  openAttachment(openTarget, issueLinkKind ? event : undefined);
                }
              : undefined;
            return (
              <Tooltip key={`attachment-${file.url || file.filename || index}`}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={open}
                    disabled={!open}
                    aria-label={fileName}
                    className={cn(tileClass, showThumbnail
                      ? 'w-16 bg-muted/10 cursor-zoom-in'
                      : 'oc-tile flex w-36 flex-col justify-between px-2 py-1 text-start enabled:hover:text-foreground disabled:cursor-default')}
                  >
                    {showThumbnail && file.url ? (
                      <StatusImage
                        src={file.url}
                        alt={fileName}
                        variant="thumbnail"
                        className="absolute inset-0 h-full w-full"
                        imgClassName="h-full w-full object-cover"
                        lazy
                      />
                    ) : (
                      <>
                        <span dir="auto" className="line-clamp-2 [overflow-wrap:anywhere] typography-meta leading-tight text-foreground">{fileName}</span>
                        <span className="flex min-w-0 items-center gap-1">
                          {issueLinkKind ? (
                            <IssueLinkIcon file={file} kind={issueLinkKind} className="h-3 w-3 shrink-0 text-muted-foreground" />
                          ) : (
                            <FileTypeIcon filePath={fileName} extension={ext} className="h-3 w-3 shrink-0" />
                          )}
                          {kindText ? <span className="min-w-0 truncate typography-micro text-muted-foreground">{kindText}</span> : null}
                        </span>
                      </>
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={6} className="typography-meta px-2 py-1">
                  {fileName}{sizeText ? ` (${sizeText})` : ''}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </ScrollableOverlay>
    );
  }

  return (
    <div className={cn(
      "grid gap-2",
      compact ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2"
    )}>
      {fileItems.map((file, index) => {
        const fileName = resolveDisplayName(file);
        const isImage = file.mime?.startsWith('image/');
        const sizeText = formatFileSize(file.size);
        const issueLinkKind = getIssueLinkKind(file);

        if (isImage && file.url) {
          return (
            <div
              key={file.url || `${fileName}-${index}`}
              className="relative aspect-video rounded-lg border border-edge-muted bg-muted/10 overflow-hidden group"
            >
              <StatusImage
                src={file.url}
                alt={fileName}
                variant="thumbnail"
                className="h-full w-full"
                imgClassName="h-full w-full object-cover"
                lazy
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
              <div className="absolute bottom-0 inset-s-0 inset-e-0 p-2 text-white opacity-0 group-hover:opacity-100 transition-opacity">
                <p className="text-xs font-medium truncate">{fileName}</p>
                {sizeText && <p className="text-xs opacity-80">{sizeText}</p>}
              </div>
            </div>
          );
        }

        if (issueLinkKind && file.url) {
          const issueUrl = file.url;
          return (
            <Tooltip key={file.url || `${fileName}-${index}`}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={(event) => {
                    if (parseChangeRequestReference(issueUrl)?.identity?.provider === 'github') {
                      openReference(issueUrl, event);
                      return;
                    }
                    openAttachment({ kind: 'external', url: issueUrl }, event);
                  }}
                  className={cn(
                    "flex items-center gap-2 p-2 rounded-lg oc-tile oc-tile-hover text-start",
                    compact ? "text-xs" : "text-sm"
                  )}
                >
                  <div className="flex-shrink-0">
                    <IssueLinkIcon file={file} kind={issueLinkKind} className={cn("text-muted-foreground", compact ? "h-3.5 w-3.5" : "h-4 w-4")} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{fileName}</p>
                    {sizeText && <p className="text-xs text-muted-foreground">{sizeText}</p>}
                  </div>
                </button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{fileName}{sizeText ? ` (${sizeText})` : ''}</p>
              </TooltipContent>
            </Tooltip>
          );
        }

        const source = file.source;
        const sourceType = typeof source?.type === 'string' ? source.type : undefined;
        const sourcePath = source && typeof (source as Record<string, unknown>).path === 'string' ? (source as Record<string, unknown>).path as string : undefined;
        const filePath = sourceType === 'file' && sourcePath ? sourcePath : (file.url || '');
        const opensInDiagramEditor = filePath && (isDrawioFile(filePath) || isExcalidrawFile(filePath));

        if (opensInDiagramEditor) {
          return (
            <Tooltip key={file.url || `${fileName}-${index}`}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => {
                    const directory = useDirectoryStore.getState().currentDirectory;
                    if (directory) {
                      useUIStore.getState().openContextFile(directory, filePath);
                    }
                  }}
                  className={cn(
                    "flex items-center gap-2 p-2 rounded-lg oc-tile oc-tile-hover text-start cursor-pointer",
                    compact ? "text-xs" : "text-sm"
                  )}
                >
                  <Icon name="file" className={cn("text-muted-foreground shrink-0", compact ? "h-3.5 w-3.5" : "h-4 w-4")} />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{fileName}</p>
                    <p className="text-xs text-status-info">{t('chat.fileAttachment.openInDiagram')}</p>
                  </div>
                  <Icon name="external-link" className={cn("text-muted-foreground shrink-0", compact ? "h-3 w-3" : "h-3.5 w-3.5")} />
                </button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{t('chat.fileAttachment.openInDiagram')}</p>
              </TooltipContent>
            </Tooltip>
          );
        }

        return (
          <Tooltip key={file.url || `${fileName}-${index}`}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => {
                  showFilePopup(file, fileName);
                }}
                className={cn(
                  "flex items-center gap-2 p-2 rounded-lg oc-tile oc-tile-hover text-start",
                  compact ? "text-xs" : "text-sm"
                )}
              >
                <div className="flex-shrink-0">
                  {file.mime?.startsWith('image/') ? (
                    <Icon name="file-image" className={cn("text-muted-foreground", compact ? "h-3.5 w-3.5" : "h-4 w-4")} />
                  ) : file.mime?.includes('pdf') ? (
                    <Icon name="file-pdf" className={cn("text-muted-foreground", compact ? "h-3.5 w-3.5" : "h-4 w-4")} />
                  ) : (
                    <Icon name="file" className={cn("text-muted-foreground", compact ? "h-3.5 w-3.5" : "h-4 w-4")} />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{fileName}</p>
                  {sizeText && <p className="text-xs text-muted-foreground">{sizeText}</p>}
                </div>
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{fileName}{sizeText ? ` (${sizeText})` : ''}</p>
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
});

MessageFilesDisplay.displayName = 'MessageFilesDisplay';
