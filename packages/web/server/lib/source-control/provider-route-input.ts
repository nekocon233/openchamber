import { isString } from '../shared/guards.js';
import { mutationReceipt } from './mutation-executor.js';
import type { Query, QueryValue, Response } from '../shared/http-contracts.js';
import type { AccountIdentity, ProviderDescriptor, ProviderMutationContext } from './provider-contract.js';
import type { MutationRecord } from './mutation-storage.js';

export interface RouteError {
  cause?: unknown;
  response?: unknown;
  status?: unknown;
  statusCode?: unknown;
  code?: unknown;
  kind?: unknown;
  message?: unknown;
  current?: unknown;
  sourceControlResponse?: unknown;
  sourceControlIdentity?: unknown;
  sourceControlAccountUnavailable?: unknown;
  sourceControlAuthUnknown?: unknown;
  sourceControlPersistedAccount?: unknown;
  sourceControlServiceLogin?: unknown;
}

const isRouteError = (value: unknown): value is RouteError => value != null;

export const routeError = (cause: unknown): RouteError | undefined => (isRouteError(cause) ? cause : undefined);

const isResponseStatus = (value: unknown): value is { status?: unknown } => value != null;

const isProviderResponse = (value: unknown): value is { status?: unknown; body?: unknown } => value != null;

export const isInteger = (value: unknown): value is number => Number.isInteger(value);

const isProjectKey = (value: string): value is 'id' | 'owner' | 'name' => ['id', 'owner', 'name'].includes(value);

export const isSafeInteger = (value: unknown): value is number => Number.isSafeInteger(value);

const hasCapabilityKey = (value: unknown): value is Readonly<Record<string, unknown>> => value != null;

interface ListFilter { state: string; people: string; labels?: string[] }

interface SourceControlErrorBody { error: unknown; code: unknown; current?: unknown }

export const withTimeout = async <Value>(promise: Promise<Value>, timeoutMs: number, label: string) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error(`${label} timed out after ${timeoutMs}ms`), { code: 'ETIMEDOUT' }));
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

export const upstreamStatusOf = (cause: unknown) => {
  const error = routeError(cause);
  const nested = routeError(error?.cause)?.response;
  return (isResponseStatus(nested) ? nested.status : undefined)
    ?? (isResponseStatus(error?.response) ? error.response.status : undefined)
    ?? error?.status;
};

export function errorStatus<Kind>(kind: Kind) {
  return kind === 'temporarily-unavailable' ? 503 : kind === 'unreachable' ? 502 : 500;
}

export const hasCodePrefix = (error: RouteError | undefined, prefix: string) => isString(error?.code) && error.code.startsWith(prefix);

export function sendAuthStorageError(res: Response, cause: unknown) {
  const answered = sendProviderResponse(res, cause);
  if (answered) return answered;
  const error = routeError(cause);
  if (hasCodePrefix(error, 'SOURCE_CONTROL_LOCK_')) {
    return res.status(error?.status).json({ error: error?.message, code: error?.code });
  }
  if (error?.code === 'INVALID_SOURCE_CONTROL_AUTH') {
    return res.status(500).json({ error: error.message, code: error.code });
  }
  return null;
}

export function sendProviderResponse(res: Response, cause: unknown) {
  const response = routeError(cause)?.sourceControlResponse;
  return response && isProviderResponse(response) ? res.status(response.status).json(response.body) : null;
}

export function requestText<Value>(value: Value) {
  return isString(value) ? value.trim() : '';
}

export function requestNumber(value: QueryValue | undefined) {
  const number = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(number) && number > 0 ? number : null;
}

export function requestIssueNumber(value: QueryValue | undefined) {
  const text = requestText(value);
  if (!/^[1-9]\d*$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : null;
}

function readLabelFilter(value: QueryValue | undefined) {
  const raw = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const names = raw
    .map((entry) => requestText(entry))
    .filter((entry) => entry.length > 0 && entry.length <= 256);
  return [...new Set(names)].slice(0, 20);
}

export function readListFilter(query: Query, options: { allowMine?: boolean } = {}) {
  const state = requestText(query?.state);
  const people = requestText(query?.people);
  const states = requestText(query?.kind) === 'discussion' ? ['open', 'closed', 'all', 'unanswered'] : ['open', 'closed', 'merged', 'all'];
  const allowedPeople = options.allowMine
    ? ['any', 'assigned', 'created', 'reviewRequested', 'mine']
    : ['any', 'assigned', 'created', 'reviewRequested'];
  const labels = readLabelFilter(query?.label);
  const filter: ListFilter = {
    state: states.includes(state) ? state : 'open',
    people: allowedPeople.includes(people) ? people : 'any',
  };
  if (labels.length > 0) filter.labels = labels;
  return filter;
}

const UPLOAD_SECRET_RE = /^[0-9a-f]{32}$/;

const UPLOAD_MEDIA_TYPE_RE = /^(?:image\/(?:png|jpeg|gif|webp|avif)|video\/(?:mp4|webm|quicktime))$/;

const UPLOAD_EXTENSION_TYPES = new Map([
  ['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['gif', 'image/gif'], ['webp', 'image/webp'], ['avif', 'image/avif'],
  ['mp4', 'video/mp4'], ['m4v', 'video/mp4'], ['webm', 'video/webm'], ['mov', 'video/quicktime'],
]);

export function uploadMediaType(upstreamType: string, filename: string) {
  const [mediaType = ''] = upstreamType.split(';');
  const type = mediaType.trim().toLowerCase();
  if (UPLOAD_MEDIA_TYPE_RE.test(type)) return type;
  if (type && type !== 'application/octet-stream') return null;
  return UPLOAD_EXTENSION_TYPES.get((filename.split('.').at(-1) ?? '').toLowerCase()) ?? null;
}

export const UPLOAD_PASSED_HEADERS = ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];

export function readUploadParams(params: Record<string, string>) {
  const secret = requestText(params?.secret);
  const filename = isString(params?.filename) ? params.filename : '';
  const plainName = filename && filename !== '.' && filename !== '..' && !/[/\\]/.test(filename);
  return UPLOAD_SECRET_RE.test(secret) && plainName ? { secret, filename } : null;
}

export const isReadContextError = (error: RouteError | undefined) => hasCodePrefix(error, 'SOURCE_CONTROL_BINDING_')
  || hasCodePrefix(error, 'SOURCE_CONTROL_LOCK_')
  || error?.code === 'SOURCE_CONTROL_PROVIDER_UNAVAILABLE'
  || error?.code === 'INVALID_SOURCE_CONTROL_READ_CONTEXT'
  || error?.code === 'INVALID_SOURCE_CONTROL_BINDING';

export const sourceControlErrorBody = (cause: unknown) => {
  const error = routeError(cause);
  const body: SourceControlErrorBody = { error: error?.message, code: error?.code };
  if (error !== undefined && Object.hasOwn(error, 'current')) body.current = error.current;
  return body;
};

export const mutationConflict = () => Object.assign(
  new Error('Source control mutation idempotency key was already used with different input'),
  { code: 'SOURCE_CONTROL_MUTATION_CONFLICT', status: 409 },
);

export const requireReplayMatch = (record: MutationRecord, kind: string, actor: AccountIdentity, context: ProviderMutationContext) => {
  if (record.kind !== kind
    || record.actor?.provider !== actor.provider
    || record.actor?.instance !== actor.instance
    || record.actor?.accountId !== actor.accountId
    || record.target?.repositoryId !== context.repositoryId
    || record.target?.bindingRevision !== context.bindingRevision
    || record.target?.primaryRemote !== context.primaryRemote) throw mutationConflict();
  const expected = context.target;
  for (const [key, value] of Object.entries(expected.project)) {
    if (isProjectKey(key) && record.target?.project?.[key] !== value) throw mutationConflict();
  }
  for (const key of ['number', 'head', 'base', 'headSha'] as const) {
    if (Object.hasOwn(expected, key) && record.target?.[key] !== expected[key]) throw mutationConflict();
  }
};

export const classifyMutationError = (cause: unknown) => {
  const error = routeError(cause);
  const status = upstreamStatusOf(error);
  const localSourceControlError = hasCodePrefix(error, 'SOURCE_CONTROL_')
    || hasCodePrefix(error, 'INVALID_SOURCE_CONTROL_');
  if (!localSourceControlError && isInteger(status) && status >= 400 && status < 500) {
    if (error && !Number.isInteger(error.status)) error.status = status;
    return 'failed';
  }
  return 'outcome-unknown';
};

export const changeRequestReceipt = (record: MutationRecord, replayed: boolean, providerAccountId: string) => {
  const receipt = mutationReceipt(record, replayed, providerAccountId);
  if (receipt.target.number !== undefined || !receipt.result || !isSafeInteger(receipt.result.number)) return receipt;
  const { number, ...result } = receipt.result;
  return { ...receipt, target: { ...receipt.target, number }, result };
};

const REVISION_RE = /^[0-9a-f]{40}$/;

const invalidReadContext = (message: string) => Object.assign(new Error(message), {
  code: 'INVALID_SOURCE_CONTROL_READ_CONTEXT', status: 400,
});

const namesRevision = <Value>(value: Value) => value !== undefined && value !== '';

export const revisionProblem = <Value>(descriptor: ProviderDescriptor | null, value: Value) => {
  if (!namesRevision(value)) return null;
  if (!descriptor?.capabilities.revisions) return 'This source control provider does not keep change request revisions';
  return isString(value) && REVISION_RE.test(value.trim().toLowerCase()) ? null : 'revision must be a full commit SHA';
};

export const readRevision = <Value>(descriptor: ProviderDescriptor | null, value: Value) => {
  const problem = revisionProblem(descriptor, value);
  if (problem) throw invalidReadContext(problem);
  return namesRevision(value) && isString(value) ? value.trim().toLowerCase() : undefined;
};

export const withRevision = <Input>(input: Input, revision: string | undefined) => (revision === undefined ? input : { ...input, revision });

export const unsupportedCapability = (res: Response) => res.status(501).json({
  error: 'This source control provider does not support this operation',
  code: 'SOURCE_CONTROL_CAPABILITY_UNSUPPORTED',
});

export const enabled = (capabilities: ProviderDescriptor['capabilities'], capability: string) => capability.split('.')
  .reduce<unknown>((value, key) => (hasCapabilityKey(value) ? value[key] : undefined), capabilities);

export const MUTATION_ROUTES = [
  ['/pr/create', 'changeRequests'],
  ['/pr/update', 'changeRequests'],
  ['/pr/merge', 'merge'],
  ['/pr/ready', 'draftChangeRequests'],
  ['/pr/draft', 'draftConversion'],
  ['/pr/comment', 'comments'],
  ['/pr/thread/start', 'reviewThreads.start'],
  ['/pr/thread/reply', 'reviewThreads.reply'],
  ['/pr/thread/resolve', 'reviewThreads.resolve'],
  ['/issues/comment', 'comments'],
  ['/issues/update', 'issues'],
  ['/pr/comment/update', 'commentEdit'],
  ['/pr/comment/delete', 'commentEdit'],
  ['/issues/comment/update', 'commentEdit'],
  ['/issues/comment/delete', 'commentEdit'],
  ['/pr/state', 'state'],
  ['/issues/state', 'state'],
  ['/pr/labels', 'labels'],
  ['/issues/labels', 'labels'],
  ['/pr/reviewers', 'reviewers'],
  ['/pr/review', 'reviews'],
  ['/pr/review/pending', 'reviewDrafts'],
  ['/pr/review/comment', 'reviewDrafts'],
  ['/pr/review/comment/update', 'reviewDrafts'],
  ['/pr/review/comment/delete', 'reviewDrafts'],
  ['/pr/review/discard', 'reviewDrafts'],
  ['/discussions/comment', 'discussions'],
  ['/discussions/comment/update', 'commentEdit'],
  ['/discussions/comment/delete', 'commentEdit'],
  ['/discussions/state', 'discussions'],
  ['/discussions/answer', 'discussions'],
  ['/discussions/labels', 'discussions'],
  ['/discussions/update', 'discussions'],
] as const;
