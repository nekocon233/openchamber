import { useFileTreeUpload } from '../useFileTreeUpload';
import { type useFileDirectory } from './useFileDirectory';
import { type useFileScope } from './useFileScope';

export function useFileUploads({ fileDirectory, scope }: {
  fileDirectory: Pick<ReturnType<typeof useFileDirectory>, 'refreshDirectory'>;
  scope: Pick<ReturnType<typeof useFileScope>, 'root'>;
}) {
  const { refreshDirectory } = fileDirectory;
  const { root } = scope;
  const {
    canUpload,
    canPickDirectory,
    pickDirectory,
    uploadDroppedFiles,
    uploadingDirectory,
    pickFiles,
    uploadElements,
  } = useFileTreeUpload({
    root,
    refreshDirectories: async (directories) => { await Promise.all(directories.map(refreshDirectory)); },
  });
  const isUploading = uploadingDirectory !== null;

  return { canUpload, canPickDirectory, pickDirectory, pickFiles, uploadDroppedFiles, uploadElements, isUploading };
}
