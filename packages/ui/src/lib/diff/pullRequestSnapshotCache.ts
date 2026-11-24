import type { PullRequestDiffSnapshot, PullRequestSource } from './pullRequestDiff';

type Snapshot = PullRequestDiffSnapshot;
export interface PullRequestFileDiffResult {
  diff: string;
  reviewHeadSha?: string;
}
interface LazyFileEntry {
  pending: Promise<PullRequestFileDiffResult>;
  result: PullRequestFileDiffResult | null;
  bytes: number;
}
interface Entry {
  scope: string;
  pending: Promise<Snapshot>;
  files: Snapshot | null;
  bytes: number;
  lazyFiles: Map<string, LazyFileEntry>;
  lazyBytes: number;
}

const MAX_SNAPSHOT_ENTRIES = 8;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_LAZY_FILES_BYTES = 16 * 1024 * 1024;

export class PullRequestSnapshotCache {
  private entries = new Map<string, Entry>();

  private evictCompleted(keep: Entry) {
    let bytes = [...this.entries.values()].reduce((sum, value) => sum + value.bytes + value.lazyBytes, 0);
    for (const [candidate, value] of this.entries) {
      if (this.entries.size <= MAX_SNAPSHOT_ENTRIES && bytes <= MAX_CACHE_BYTES) break;
      if (value === keep || value.files === null) continue;
      bytes -= value.bytes + value.lazyBytes;
      this.entries.delete(candidate);
    }
  }

  load(scope: string, source: PullRequestSource, read: () => Promise<Snapshot>, force = false, authority = ''): Promise<Snapshot> {
    const key = JSON.stringify([scope, source, authority]);
    const existing = this.entries.get(key);
    if (existing && (!force || existing.files === null)) return existing.pending;
    const entry: Entry = { scope, pending: read(), files: null, bytes: 0, lazyFiles: new Map(), lazyBytes: 0 };
    entry.pending = entry.pending.then((files) => {
      if (this.entries.get(key) !== entry) return files;
      entry.files = files;
      entry.bytes = files.files.reduce((sum, file) => sum + 2 * ((file.patch?.length ?? 0) + file.path.length), 0);
      this.evictCompleted(entry);
      return files;
    }).catch((error) => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    });
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.pending;
  }

  loadFileDiff(
    scope: string,
    source: PullRequestSource,
    authority: string,
    filePath: string,
    read: () => Promise<PullRequestFileDiffResult>,
  ): Promise<PullRequestFileDiffResult> {
    const key = JSON.stringify([scope, source, authority]);
    const entry = this.entries.get(key);
    if (!entry || entry.files === null) return read();
    const existing = entry.lazyFiles.get(filePath);
    if (existing) {
      entry.lazyFiles.delete(filePath);
      entry.lazyFiles.set(filePath, existing);
      return existing.pending;
    }
    const fileEntry: LazyFileEntry = { pending: read(), result: null, bytes: 0 };
    fileEntry.pending = fileEntry.pending.then((result) => {
      if (this.entries.get(key) !== entry || entry.lazyFiles.get(filePath) !== fileEntry) return result;
      fileEntry.result = result;
      fileEntry.bytes = 2 * (result.diff.length + filePath.length);
      entry.lazyBytes += fileEntry.bytes;
      for (const [candidate, value] of entry.lazyFiles) {
        if (entry.lazyBytes <= MAX_LAZY_FILES_BYTES) break;
        if (value === fileEntry || value.result === null) continue;
        entry.lazyBytes -= value.bytes;
        entry.lazyFiles.delete(candidate);
      }
      this.evictCompleted(entry);
      return result;
    }).catch((error) => {
      if (entry.lazyFiles.get(filePath) === fileEntry) entry.lazyFiles.delete(filePath);
      throw error;
    });
    entry.lazyFiles.set(filePath, fileEntry);
    return fileEntry.pending;
  }

  invalidate(scope: string) {
    for (const [key, entry] of this.entries) {
      if (entry.scope === scope) this.entries.delete(key);
    }
  }
}
