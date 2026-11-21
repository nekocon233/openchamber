import { INTERNAL_FILE_PATH_TYPE } from '@/components/chat/composer/attachments/dataTransfer';
import { getFileTreeDragSource, type FileTreeEntry } from '../fileTreeMoveDrag';
import { getRelativePath } from './treePaths';

export const hasExternalFiles = (dataTransfer: DataTransfer): boolean => (
  Array.from(dataTransfer.types).includes('Files')
);

export const getMoveDragSource = (dataTransfer: DataTransfer): FileTreeEntry | null => (
  Array.from(dataTransfer.types).includes(INTERNAL_FILE_PATH_TYPE) ? getFileTreeDragSource() : null
);

export const isDropOfMoveSource = (dataTransfer: DataTransfer, root: string, source: FileTreeEntry): boolean => (
  dataTransfer.getData(INTERNAL_FILE_PATH_TYPE) === getRelativePath(root, source.path)
);
