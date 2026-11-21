import { sha256Hex } from '../sha256';
import { z } from 'zod';
import type { GitAPI, GitNetworkOperation, GitNetworkOperationPlan, GitNetworkOperationRequest } from '@/lib/api/types';
import type { GitOperationRead } from '@/lib/boundGitNetworkOperation';

export const isCompleteSyncSuccess = (steps: GitNetworkOperation['stepResults']): boolean => Boolean(steps
  && steps.length === 3
  && steps.some((result) => result.step === 'fetch' && result.status === 'succeeded')
  && (['pull', 'push'] as const).every((step) => steps.some((result) => result.step === step
    && (result.status === 'succeeded' || result.status === 'skipped'))));

const STORAGE_KEY = 'openchamber.git.pending-operations.v1';
const MAX_REFERENCES = 64;
const text = z.string().min(1).max(512);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const referenceSchema = z.object({
  runtimeKey: digestSchema,
  runtimeIdentity: z.object({ id: text, platform: z.enum(['web', 'desktop', 'vscode']) }).strict(),
  repositoryId: text.nullable(),
  operationId: text,
  operation: z.enum(['push', 'pull', 'fetch', 'sync', 'delete-remote-branch', 'clone', 'checkout-hydration']),
  targetDigest: digestSchema,
  durableTargetDigest: digestSchema.optional(),
}).strict().refine((value) => (value.operation === 'clone') === (value.repositoryId === null));
const storageSchema = z.object({ version: z.literal(1), references: z.array(referenceSchema).max(MAX_REFERENCES) }).strict();

export type PendingGitReference = z.infer<typeof referenceSchema>;
type RecoveryStorage = Pick<Storage, 'getItem' | 'setItem'>;
type RecoverySnapshot = {
  ready: boolean;
  references: PendingGitReference[];
  problem: 'storage' | 'capacity' | null;
};

export class PendingGitOperationError extends Error {
  constructor(readonly reason: 'storage' | 'capacity' | 'pending', readonly references: PendingGitReference[] = []) {
    super(reason);
    this.name = 'PendingGitOperationError';
  }
}

const digest = async (value: string): Promise<string> => {
  const input = new TextEncoder().encode(value);
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const bytes = await subtle.digest('SHA-256', input);
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  return sha256Hex(input);
};

const durableTargetText = (target: GitNetworkOperation['target']): string => JSON.stringify(target, (key, value) => {
  if (key === 'forceWithLease') return undefined;
  if (key !== 'displayUrl') return value;
  const displayUrl = z.string().safeParse(value);
  if (!displayUrl.success || displayUrl.data.includes('://')) return value;
  const match = displayUrl.data.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
  return match ? `${match[1]}:${match[2]}` : displayUrl.data;
});

export const createGitOperationRecoveryOwner = (storage: () => RecoveryStorage) => {
  let snapshot: RecoverySnapshot = { ready: false, references: [], problem: null };
  const listeners = new Set<() => void>();
  const reservations = new Set<string>();
  const reconciling = new Map<string, Promise<GitOperationRead | null>>();
  const publish = (next: RecoverySnapshot) => {
    if (snapshot.ready === next.ready && snapshot.problem === next.problem
      && JSON.stringify(snapshot.references) === JSON.stringify(next.references)) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const failStorage = (): never => {
    publish({ ...snapshot, ready: false, problem: 'storage' });
    throw new PendingGitOperationError('storage', snapshot.references);
  };
  const hash = async (value: string): Promise<string> => {
    try { return await digest(value); } catch { return failStorage(); }
  };
  const load = (): PendingGitReference[] => {
    try {
      const encoded = storage().getItem(STORAGE_KEY);
      if (encoded !== null && encoded.length > 256 * 1024) return failStorage();
      const references = encoded === null ? [] : storageSchema.parse(JSON.parse(encoded)).references;
      const ids = references.map((reference) => JSON.stringify([reference.runtimeKey, reference.runtimeIdentity, reference.operationId]));
      if (new Set(ids).size !== ids.length) return failStorage();
      publish({ ready: true, references, problem: references.length >= MAX_REFERENCES ? 'capacity' : null });
      return references;
    } catch { return failStorage(); }
  };
  const save = (references: PendingGitReference[]) => {
    try {
      storage().setItem(STORAGE_KEY, JSON.stringify({ version: 1, references }));
    } catch { return failStorage(); }
    publish({ ready: true, references, problem: references.length >= MAX_REFERENCES ? 'capacity' : null });
  };
  const matches = async (reference: PendingGitReference, runtimeKey: string, operation: GitNetworkOperation): Promise<boolean> => {
    if (operation.target.operation === 'clone' && operation.state === 'partial' && !operation.completedSteps.includes('checked-out')) return false;
    if (operation.target.operation === 'sync' && operation.state === 'succeeded') {
      if (!isCompleteSyncSuccess(operation.stepResults)) return false;
    }
    const targetDigest = await hash(JSON.stringify(operation.target));
    const durableTargetDigest = await hash(durableTargetText(operation.target));
    return reference.runtimeKey === await hash(runtimeKey)
      && reference.operationId === operation.operationId
      && reference.runtimeIdentity.id === operation.runtimeIdentity.id
      && reference.runtimeIdentity.platform === operation.runtimeIdentity.platform
      && reference.repositoryId === ('repositoryId' in operation.target ? operation.target.repositoryId : null)
      && reference.operation === operation.target.operation
      && (reference.targetDigest === targetDigest || reference.durableTargetDigest === durableTargetDigest);
  };

  const remember = async (runtimeKey: string, operation: GitNetworkOperationPlan): Promise<void> => {
    const reference = referenceSchema.parse({
      runtimeKey: await hash(runtimeKey),
      runtimeIdentity: { id: operation.runtimeIdentity.id, platform: operation.runtimeIdentity.platform },
      repositoryId: 'repositoryId' in operation.target ? operation.target.repositoryId : null,
      operationId: operation.operationId,
      operation: operation.target.operation,
      targetDigest: await hash(JSON.stringify(operation.target)),
      durableTargetDigest: await hash(durableTargetText(operation.target)),
    });
    const references = load();
    const existing = references.find((item) => item.runtimeKey === reference.runtimeKey && item.operationId === reference.operationId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(reference)) throw new PendingGitOperationError('pending', [existing]);
      save(references);
      return;
    }
    if (references.length >= MAX_REFERENCES) throw new PendingGitOperationError('capacity', references);
    save([...references, reference]);
  };

  const complete = async (read: GitOperationRead, isCurrent: () => boolean = () => true): Promise<void> => {
    if (read.availability !== 'available' || ['planned', 'running', 'outcome-unknown'].includes(read.operation.state)) return;
    const runtimeKey = await hash(read.runtimeKey);
    const references = load();
    const candidate = references.find((reference) => reference.runtimeKey === runtimeKey && reference.operationId === read.operation.operationId);
    if (!candidate || !await matches(candidate, read.runtimeKey, read.operation) || !isCurrent()) return;
    save(load().filter((reference) => JSON.stringify(reference) !== JSON.stringify(candidate)));
  };

  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,
    runtimeKey: hash,
    // oxlint-disable-next-line no-empty
    hydrate: () => { try { load(); } catch {  } },
    assertWritable: () => {
      const references = load();
      if (references.length + reservations.size >= MAX_REFERENCES) throw new PendingGitOperationError('capacity', references);
      save(references);
    },
    plan: async (git: Pick<GitAPI, 'planNetworkOperation'>, request: GitNetworkOperationRequest, runtimeKey: string, isCurrent: () => boolean): Promise<GitNetworkOperationPlan> => {
      const key = await hash(runtimeKey);
      if (!isCurrent()) throw new PendingGitOperationError('pending');
      const repositoryId = request.operation === 'clone' ? null : request.repositoryId;
      const scope = JSON.stringify([key, repositoryId]);
      const references = load();
      const pending = references.filter((reference) => reference.runtimeKey === key && reference.repositoryId === repositoryId);
      if (pending.length || reservations.has(scope)) throw new PendingGitOperationError('pending', pending);
      if (references.length + reservations.size >= MAX_REFERENCES) throw new PendingGitOperationError('capacity', references);
      save(references);
      reservations.add(scope);
      try {
        const plan = await git.planNetworkOperation(request);
        await remember(runtimeKey, plan);
        return plan;
      } finally { reservations.delete(scope); }
    },
    remember,
    complete,
    reconcile: (reference: PendingGitReference, git: Pick<GitAPI, 'getNetworkOperation'>, runtimeKey: string, isCurrent: () => boolean): Promise<GitOperationRead | null> => {
      const key = JSON.stringify(reference);
      const existing = reconciling.get(key);
      if (existing) return existing;
      const request = (async () => {
        try {
          if (!isCurrent() || await hash(runtimeKey) !== reference.runtimeKey || !isCurrent()) return null;
          const operation = await git.getNetworkOperation(reference.operationId);
          if (!isCurrent() || !await matches(reference, runtimeKey, operation) || !isCurrent()) return null;
          const read: GitOperationRead = { runtimeKey, operation, availability: 'available' };
          // oxlint-disable-next-line no-empty
          try { await complete(read, isCurrent); } catch {  }
          return read;
        } catch {
          return null;
        }
      })().finally(() => { reconciling.delete(key); });
      reconciling.set(key, request);
      return request;
    },
  };
};

export const gitOperationRecoveryOwner = createGitOperationRecoveryOwner(() => window.sessionStorage);
