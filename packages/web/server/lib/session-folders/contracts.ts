import type { folderChangesBodySchema } from './folder-changes.js';
import type { z } from 'zod';

export interface SessionFolder {
  id: string;
  name: string;
  sessionIds: string[];
  createdAt: number;
  parentId?: string | null | undefined;
}

export type SessionFoldersMap = Record<string, SessionFolder[]>;
export type FolderTombstones = Record<string, number>;
export type FolderChange = z.infer<typeof folderChangesBodySchema>['changes'][number];

export interface StoredFolderSnapshot {
  version: 1;
  foldersMap: SessionFoldersMap;
  collapsedFolderIds: string[];
  deletedFolderIds?: FolderTombstones | undefined;
  updatedAt?: unknown;
}

export interface FolderSnapshot extends StoredFolderSnapshot {
  updatedAt: number;
}

export type FolderChangesResult =
  | { snapshot: StoredFolderSnapshot; changed: false }
  | { snapshot: FolderSnapshot; changed: true };

type SessionFoldersResponse =
  | (StoredFolderSnapshot & { exists: boolean })
  | { version: 1; exists: false }
  | { version: 2; revision: number; foldersMap: SessionFoldersMap; collapsedFolderIds: string[] }
  | { error: string; code?: string }
  | { success: true };

type RouteResponse = import('../shared/http-contracts.js').Response<SessionFoldersResponse>;

type RouteHandler = (req: { body: unknown }, res: RouteResponse) => Promise<RouteResponse>;

export interface SessionFoldersApp {
  get: (path: string, handler: RouteHandler) => void;
  post: (path: string, handler: RouteHandler) => void;
  patch?: (path: string, handler: RouteHandler) => void;
}

export interface SessionFoldersSidebarStateRuntime {
  readSnapshot: () => Promise<{
    revision: number;
    sessionFoldersByScope: SessionFoldersMap;
  }>;
}

export interface SessionFoldersDependencies {
  sidebarStateRuntime: SessionFoldersSidebarStateRuntime;
}
