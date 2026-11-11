import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { z } from 'zod';
import { normalizePath } from '@/lib/pathNormalization';
import type { SourceControlReadContext } from '@/lib/source-control/types';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';
import { navigationReturnSchema } from '@/sync/navigation-return';
import { resolveProjectContextId, type ProjectRef } from '@/lib/projectContextApi';
import type { PendingDiffScope } from './useUIStore';

const text = z.string().catch('');
const paths = z.array(z.string()).catch([]);
const nullableText = z.string().nullable().catch(null);
const scrollSchema = z.object({
  top: z.number().finite().nonnegative().catch(0),
  left: z.number().finite().catch(0),
  anchor: nullableText,
  offset: z.number().finite().catch(0),
});
const pullSourceSchema = z.object({
  kind: z.literal('pr'), number: z.number().int().positive(),
  sourceRepo: z.object({ owner: z.string(), repo: z.string() }),
});
const schemas = {
  pullRequest: z.object({
    tab: z.enum(['project', 'ci', 'branch']).catch('project'),
    people: z.enum(['reviewRequested', 'created', 'any']).catch('reviewRequested'),
    query: text,
    selectedUrl: nullableText,
    loadedCount: z.number().int().nonnegative().catch(0),
    checksOpen: z.boolean().catch(false),
    link: z.object({ sourceDirectory: z.string().min(1), url: z.string().url() }).nullable().catch(null),
  }),
  ci: z.object({
    filter: z.enum(['all', 'active', 'failure', 'branch']).catch('all'),
    query: text,
    selectedRunId: nullableText,
    loadedCount: z.number().int().nonnegative().catch(0),
  }),
  changes: z.object({
    initialized: z.boolean().catch(false),
    pullRequest: pullSourceSchema.nullable().catch(null),
    pullRequestIdentity: nullableText,
    commitHash: nullableText,
    selectedFile: nullableText,
    staged: z.boolean().catch(false),
    expandedFiles: paths,
    collapsedDirectories: paths,
    returnTo: z.object({
      workspaceDirectory: z.string().min(1), sourceDirectory: z.string().min(1),
      tab: z.enum(['project', 'branch', 'linked']), url: z.string().url(),
      repositoryIdentity: z.string(), source: pullSourceSchema,
      navigation: navigationReturnSchema.nullable(),
    }).nullable().catch(null),
  }),
  knowledge: z.object({
    tab: z.enum(['notes', 'todos', 'plans', 'memory']).catch('notes'),
    query: text,
    searchOpen: z.boolean().catch(false),
    entry: z.object({ section: z.enum(['notes', 'todos', 'plans', 'memory']), id: z.string().min(1) }).nullable().catch(null),
    memoryScope: z.enum(['project', 'global']).catch('project'),
    memoryScopePicked: z.boolean().catch(false),
    memoryQuery: text,
    expandedTodos: paths,
    editingTodo: nullableText,
    planViewMode: z.enum(['preview', 'edit']).optional().catch(undefined),
  }),
  comment: z.object({
    text,
    selection: z.object({ startLine: z.number().int().positive(), endLine: z.number().int().positive(), side: z.enum(['original', 'modified']).optional() }).nullable().catch(null),
    editingDraftId: nullableText,
    code: nullableText,
    origin: nullableText,
  }),
  thread: z.object({ open: z.boolean().optional().catch(undefined), replying: z.boolean().catch(false), editing: z.boolean().catch(false) }),
  diffFile: z.object({
    forceLarge: z.boolean().catch(false),
    contextExpansion: z.union([
      z.object({ gap: z.literal('before-hunk'), additionStart: z.number().int().nonnegative(), direction: z.enum(['up', 'down', 'both']) }),
      z.object({ gap: z.literal('after-last-hunk') }),
    ]).nullable().catch(null),
    fingerprint: nullableText,
    regions: z.array(z.tuple([z.number().int().nonnegative(), z.number().finite().nonnegative(), z.number().finite().nonnegative()])).catch([]),
    horizontal: z.number().finite().catch(0),
  }),
  pullRequestForm: z.object({
    title: z.string().optional().catch(undefined),
    body: z.string().optional().catch(undefined),
    draft: z.boolean().optional().catch(undefined),
    additionalContext: text,
    targetBaseBranch: z.string().optional().catch(undefined),
    targetBaseBranchChosen: z.boolean().catch(false),
    contextOpen: z.boolean().catch(false),
    topic: text,
    hashtags: text,
    privateChange: z.boolean().catch(false),
  }),
  scroll: scrollSchema,
};

export type WorkspaceViewStates = { [K in keyof typeof schemas]: z.infer<(typeof schemas)[K]> };
export type WorkspaceViewKind = keyof WorkspaceViewStates;
type Snapshots = { [K in WorkspaceViewKind]: Record<string, WorkspaceViewStates[K]> };

// Defaults are shared so an absent owner never allocates during selection.
export const WORKSPACE_VIEW_DEFAULTS: WorkspaceViewStates = {
  pullRequest: schemas.pullRequest.parse({}), ci: schemas.ci.parse({}), changes: schemas.changes.parse({}),
  knowledge: schemas.knowledge.parse({}), comment: schemas.comment.parse({}),
  thread: schemas.thread.parse({}),
  diffFile: schemas.diffFile.parse({}),
  pullRequestForm: schemas.pullRequestForm.parse({}), scroll: schemas.scroll.parse({}),
};

export const workspaceViewKey = (runtimeKey: string, directory: string | null | undefined, ...identity: (string | number | null)[]): string | null => {
  const path = normalizePath(directory);
  return runtimeKey && path ? JSON.stringify([runtimeKey, path, ...identity]) : null;
};

export const workspaceKnowledgeKey = (runtimeKey: string, project: ProjectRef | null | undefined): string | null => {
  const workspace = workspaceViewKey(runtimeKey, project?.path);
  return workspace && project ? JSON.stringify([workspace, resolveProjectContextId(project)]) : null;
};

/** Rebinding a checkout must not restore another repository's content or input. */
export const workspaceRepositoryIdentity = (context: SourceControlReadContext): string => JSON.stringify([
  context.provider, context.instance, context.accountId, context.repositoryId, context.primaryRemote, context.bindingRevision,
]);

const emptySnapshots = (): Snapshots => ({ pullRequest: {}, ci: {}, changes: {}, knowledge: {}, comment: {}, thread: {}, diffFile: {}, pullRequestForm: {}, scroll: {} });

const parseSnapshots = (value: unknown): Snapshots => {
  const result = emptySnapshots();
  if (!value || typeof value !== 'object') return result;
  for (const kind of Object.keys(schemas) as WorkspaceViewKind[]) {
    if (!(kind in value)) continue;
    const records: unknown = Reflect.get(value, kind);
    if (!records || typeof records !== 'object' || Array.isArray(records)) continue;
    for (const [key, snapshot] of Object.entries(records)) {
      try {
        const owner: unknown = JSON.parse(key);
        if (!Array.isArray(owner) || owner.length < 2 || !owner.slice(0, 2).every(part => typeof part === 'string' && part.length > 0)) continue;
        const parsed = schemas[kind].safeParse(snapshot);
        // The schema and destination are selected by the same kind.
        if (parsed.success) Object.assign(result[kind], { [key]: parsed.data });
      } catch {
        // A malformed owner must not discard another window's state.
      }
    }
  }
  return result;
};

interface WorkspaceViewStateStore {
  snapshots: Snapshots;
  diffNavigations: Record<string, { path: string; scope: PendingDiffScope | null }>;
  requestDiffNavigation: (owner: string, path: string, scope: PendingDiffScope | null) => void;
  settleDiffNavigation: (owner: string, request: { path: string; scope: PendingDiffScope | null }) => void;
  update: <K extends WorkspaceViewKind>(kind: K, owner: string, update: (previous: WorkspaceViewStates[K]) => WorkspaceViewStates[K]) => void;
}

export const readWorkspaceViewState = <K extends WorkspaceViewKind>(state: WorkspaceViewStateStore, kind: K, owner: string | null): WorkspaceViewStates[K] =>
  (owner ? state.snapshots[kind][owner] : undefined) ?? WORKSPACE_VIEW_DEFAULTS[kind];

/** Device-local navigation only. Server records and pending operations remain with their owners. */
export const useWorkspaceViewStateStore = create<WorkspaceViewStateStore>()(persist((set) => ({
  snapshots: emptySnapshots(),
  diffNavigations: {},
  requestDiffNavigation: (owner, path, scope) => set(state => ({ diffNavigations: { ...state.diffNavigations, [owner]: { path, scope } } })),
  settleDiffNavigation: (owner, request) => set(state => {
    if (state.diffNavigations[owner] !== request) return state;
    const diffNavigations = { ...state.diffNavigations }; delete diffNavigations[owner]; return { diffNavigations };
  }),
  update: (kind, owner, update) => set(state => {
    const previous = readWorkspaceViewState(state, kind, owner);
    const next = update(previous);
    if (next === previous) return state;
    return { snapshots: { ...state.snapshots, [kind]: { ...state.snapshots[kind], [owner]: next } } };
  }),
}), {
  name: 'openchamber.workspace-views.v1',
  storage: createDeferredSafeJSONStorage(),
  partialize: state => ({ snapshots: state.snapshots }),
  merge: (saved: unknown, current) => saved && typeof saved === 'object' && 'snapshots' in saved
    ? { ...current, snapshots: parseSnapshots(saved.snapshots) } : current,
}));
