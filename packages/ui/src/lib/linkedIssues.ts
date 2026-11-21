import { z } from 'zod';
import type { Session } from '@/lib/opencode/model';
import { isJsonValue, type JsonValue } from '@openchamber/sdk';
import { getSessionMetadata, type SessionMetadataRecord } from './sessionReviewMetadata';
import type { RepositoryUrlMatcher } from './source-control/repositoryUrlMatcher';
import { formatChangeRequestReference } from './source-control/providers/terminology';
import { joinProjectPath } from './source-control/projectPath';
import { storedTrackerLinkKind } from './trackers/legacyLinear';


type LinkedRepositoryIssue = {
  id: string;
  number: number;
  title: string;
  url: string;
  kind: 'issue' | 'pull';
  author?: string;
  authorAvatarUrl?: string;
  linkedAt: number;
};

type LinkedTrackerItem = {
  id: string;
  kind: 'tracker';
  provider: string;
  identifier: string;
  title: string;
  url: string;
  author?: string;
  authorAvatarUrl?: string;
  linkedAt: number;
};

export type LinkedGuestIssue = {
  id: string;
  providerId: string;
  identifier: string;
  title: string;
  url: string;
  kind: 'guest';
  thread?: 'issue' | 'pull';
  author?: string;
  head?: string;
  base?: string;
  data?: JsonValue;
  linkedAt: number;
};

const isGuestPull = (entry: { thread?: 'issue' | 'pull' }): boolean => (
  entry.thread === 'pull'
);

type LinkedExternalItem = {
  id: string;
  kind: 'external';
  thread: 'issue' | 'change';
  identifier: string;
  title: string;
  url: string;
  linkedAt: number;
};

export type LinkedIssue = LinkedRepositoryIssue | LinkedTrackerItem | LinkedGuestIssue | LinkedExternalItem;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const isLinkedRepositoryIssue = (value: unknown): value is LinkedRepositoryIssue => (
  isRecord(value)
  && typeof value.id === 'string'
  && value.id.length > 0
  && typeof value.number === 'number'
  && Number.isFinite(value.number)
  && typeof value.title === 'string'
  && typeof value.url === 'string'
  && (value.kind === 'issue' || value.kind === 'pull')
  && typeof value.linkedAt === 'number'
  && Number.isFinite(value.linkedAt)
);

const trackerEntryFields = z.object({
  id: z.string().min(1),
  identifier: z.string().min(1),
  title: z.string(),
  url: z.string(),
  author: z.string().optional().catch(undefined),
  authorAvatarUrl: z.string().optional().catch(undefined),
  linkedAt: z.number(),
});

const linkedTrackerItemSchema = z.union([
  trackerEntryFields.extend({ kind: z.literal('tracker'), provider: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/) }),
  trackerEntryFields.extend({ kind: z.literal('linear') })
    .transform((entry) => ({ ...entry, kind: 'tracker' as const, provider: 'linear' })),
]) satisfies z.ZodType<LinkedTrackerItem>;

const isLinkedGuestIssue = (value: unknown): value is LinkedGuestIssue => (
  isRecord(value)
  && typeof value.id === 'string'
  && value.id.length > 0
  && typeof value.providerId === 'string'
  && value.providerId.length > 0
  && typeof value.identifier === 'string'
  && value.identifier.length > 0
  && typeof value.title === 'string'
  && typeof value.url === 'string'
  && value.kind === 'guest'
  && (value.thread === undefined || value.thread === 'issue' || value.thread === 'pull')
  && (value.author === undefined || typeof value.author === 'string')
  && (value.head === undefined || typeof value.head === 'string')
  && (value.base === undefined || typeof value.base === 'string')
  && (value.data === undefined || isJsonValue(value.data as JsonValue))
  && typeof value.linkedAt === 'number'
  && Number.isFinite(value.linkedAt)
);

const isLinkedExternalItem = (value: unknown): value is LinkedExternalItem => (
  isRecord(value)
  && typeof value.id === 'string'
  && value.id.length > 0
  && value.kind === 'external'
  && (value.thread === 'issue' || value.thread === 'change')
  && typeof value.identifier === 'string'
  && value.identifier.length > 0
  && typeof value.title === 'string'
  && typeof value.url === 'string'
  && typeof value.linkedAt === 'number'
  && Number.isFinite(value.linkedAt)
);

const isLinkedIssue = (value: unknown): value is Exclude<LinkedIssue, LinkedTrackerItem> => (
  isLinkedRepositoryIssue(value) || isLinkedGuestIssue(value) || isLinkedExternalItem(value)
);

const linkedIssueListSchema = z.array(z.unknown()).catch([]).transform((values) => values.flatMap((value): LinkedIssue[] => {
  if (isLinkedIssue(value)) return [value];
  const tracker = linkedTrackerItemSchema.safeParse(value);
  return tracker.success ? [tracker.data] : [];
}));

export const isLinkedChange = (entry: LinkedIssue): boolean => (
  entry.kind === 'pull'
  || (entry.kind === 'guest' && isGuestPull(entry))
  || (entry.kind === 'external' && entry.thread === 'change')
);

export const buildLinkedIssueId = (owner: string, repo: string, number: number): string =>
  `${owner}/${repo}#${number}`;


export const buildLinkedIssue = (input: {
  url: string;
  number: number;
  title: string;
  kind: 'issue' | 'pull';
  author?: { login?: string; avatarUrl?: string } | null;
  linkedAt: number;
}): LinkedRepositoryIssue => {
  let project: { host: string; owner: string; name: string } | null = null;
  try {
    const parsed = new URL(input.url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const threadIndex = segments.findIndex((segment) => (
      segment === 'issues' || segment === 'pull'
    ));
    const projectNameIndex = segments[threadIndex - 1] === '-' ? threadIndex - 2 : threadIndex - 1;
    const owner = segments.slice(0, projectNameIndex).join('/');
    const name = segments[projectNameIndex];
    if (threadIndex > 1 && owner && name) project = { host: parsed.hostname.toLowerCase(), owner, name };
  } catch {
    // The URL itself remains a stable fallback id for malformed provider data.
  }
  const id = !project
    ? `${input.url}#${input.number}`
    : project.host === 'github.com' || project.host === 'www.github.com'
      ? buildLinkedIssueId(project.owner, project.name, input.number)
      : `${project.host}:${buildLinkedIssueId(project.owner, project.name, input.number)}`;

  return {
    id,
    number: input.number,
    title: input.title,
    url: input.url,
    kind: input.kind,
    author: input.author?.login ?? undefined,
    authorAvatarUrl: input.author?.avatarUrl ?? undefined,
    linkedAt: input.linkedAt,
  };
};

export const buildLinkedGuestIssue = (input: {
  providerId: string;
  identifier: string;
  title: string;
  url: string;
  thread?: 'issue' | 'pull';
  author?: string;
  head?: string;
  base?: string;
  data?: JsonValue;
  linkedAt: number;
}): LinkedGuestIssue => {
  const next: LinkedGuestIssue = {
    id: `guest:${input.providerId}:${input.identifier}`,
    providerId: input.providerId,
    identifier: input.identifier,
    title: input.title,
    url: input.url,
    kind: 'guest',
    thread: input.thread === 'pull' ? 'pull' : 'issue',
    linkedAt: input.linkedAt,
  };
  if (input.author?.trim()) {
    next.author = input.author.trim();
  }
  if (next.thread === 'pull') {
    if (input.head?.trim()) {
      next.head = input.head.trim();
    }
    if (input.base?.trim()) {
      next.base = input.base.trim();
    }
  }
  if (input.data !== undefined) {
    next.data = input.data;
  }
  return next;
};

export const buildLinkedDiscussion = (input: { url: string; number: number; title: string; linkedAt: number }): LinkedExternalItem => {
  let canonical = input.url;
  try {
    const parsed = new URL(input.url);
    const thread = /^\/[^/]+\/[^/]+\/discussions\/\d+/.exec(parsed.pathname);
    if (thread) canonical = `${parsed.origin}${thread[0]}`;
  } catch {
    // The URL itself stays a stable id for malformed provider data.
  }
  return {
    id: `link:${canonical}`,
    kind: 'external',
    thread: 'issue',
    identifier: `#${input.number}`,
    title: input.title,
    url: input.url,
    linkedAt: input.linkedAt,
  };
};

export const buildLinkedTrackerItem = (input: {
  provider: string;
  identifier: string;
  title: string;
  url: string;
  author?: { login?: string; avatarUrl?: string } | null;
  linkedAt: number;
}): LinkedTrackerItem => ({
  id: `${input.provider}:${input.identifier}`,
  kind: 'tracker',
  provider: input.provider,
  identifier: input.identifier,
  title: input.title,
  url: input.url,
  author: input.author?.login ?? undefined,
  authorAvatarUrl: input.author?.avatarUrl ?? undefined,
  linkedAt: input.linkedAt,
});

type StoredLinkedIssue = Exclude<LinkedIssue, LinkedTrackerItem> | (Omit<LinkedTrackerItem, 'kind'> & { kind: 'tracker' | 'linear' });

export const toStoredLinkedIssue = (entry: LinkedIssue): StoredLinkedIssue => (
  entry.kind === 'tracker' ? { ...entry, kind: storedTrackerLinkKind(entry.provider) } : entry
);

export const getLinkedIssues = (session: Session | null | undefined): LinkedIssue[] => {
  const openchamber = getSessionMetadata(session).openchamber;
  if (!isRecord(openchamber) || !Array.isArray(openchamber.linked_issues)) return [];
  return linkedIssueListSchema.parse(openchamber.linked_issues);
};

export type RepositoryThreadRef = {
  key: string;
  provider: string;
  instance: string;
  owner: string;
  repo: string;
  number: number;
  thread: 'pull' | 'issue' | 'discussion';
};

export const getRepositoryThreadRef = (entry: LinkedIssue, matcher: RepositoryUrlMatcher): RepositoryThreadRef | null => {
  if (entry.kind === 'tracker') return null;
  const match = matcher.match(entry.url);
  if (!match || !Number.isSafeInteger(match.number) || match.number < 1) return null;
  const repositoryEntry = entry.kind === 'issue' || entry.kind === 'pull';
  if (repositoryEntry && match.number !== entry.number) return null;
  const thread = repositoryEntry ? entry.kind : match.kind;
  return {
    key: `${match.provider}|${match.instance}|${joinProjectPath(match.owner, match.repo)}|${thread}#${match.number}`.toLowerCase(),
    provider: match.provider,
    instance: match.instance,
    owner: match.owner,
    repo: match.repo,
    number: match.number,
    thread,
  };
};

const repositoryThreadIdentifier = (ref: RepositoryThreadRef, matcher: RepositoryUrlMatcher): string => {
  const descriptor = matcher.descriptorOf(ref.provider);
  return ref.thread === 'pull'
    ? formatChangeRequestReference(descriptor, ref.number)
    : `${descriptor.terminology.issuePrefix}${ref.number}`;
};

export const getDistinctLinkedIssues = (session: Session | null | undefined, matcher?: RepositoryUrlMatcher): LinkedIssue[] => {
  const seen = new Set<string>();
  return getLinkedIssues(session).filter((entry) => {
    const key = matcher
      ? getRepositoryThreadRef(entry, matcher)?.key
      : getGitHubThreadRef(entry)?.key.toLowerCase() ?? getGitLabThreadRef(entry)?.key;
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export type LinkedGitHubPullRequest = {
  owner: string;
  repo: string;
  number: number;
  url: string;
  title: string;
};

const LINKED_ISSUE_ID_PATTERN = /^([^/\s]+)\/([^/#\s]+)#(\d+)$/;
const GITHUB_THREAD_URL_PATTERN = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/(pull|issues)\/(\d+)(?:[/?#]|$)/i;

type GitHubThreadRef = { key: string; owner: string; repo: string; number: number; thread: 'pull' | 'issue' };

export const getGitHubThreadRef = (entry: LinkedIssue): GitHubThreadRef | null => {
  if (entry.kind === 'issue' || entry.kind === 'pull') {
    if (!GITHUB_THREAD_URL_PATTERN.test(entry.url)) return null;
    const match = LINKED_ISSUE_ID_PATTERN.exec(entry.id);
    if (!match || Number(match[3]) !== entry.number) return null;
    return { key: entry.id, owner: match[1], repo: match[2], number: entry.number, thread: entry.kind };
  }
  if (entry.kind === 'tracker') return null;
  const match = GITHUB_THREAD_URL_PATTERN.exec(entry.url);
  if (!match) return null;
  const number = Number(match[4]);
  return { key: `${match[1]}/${match[2]}#${number}`, owner: match[1], repo: match[2], number, thread: match[3].toLowerCase() === 'pull' ? 'pull' : 'issue' };
};

export type GitLabThreadRef = { key: string; instance: string; owner: string; repo: string; number: number; thread: 'pull' | 'issue' };

const GITLAB_THREAD_URL_PATTERN = /^(https?:\/\/[^/\s]+)\/(.+)\/([^/\s]+)\/-\/(merge_requests|issues|work_items)\/(\d+)(?:[/?#]|$)/i;

export const getGitLabThreadRef = (entry: LinkedIssue): GitLabThreadRef | null => {
  if (entry.kind === 'tracker' || entry.kind === 'guest' || getGitHubThreadRef(entry)) return null;
  const match = GITLAB_THREAD_URL_PATTERN.exec(entry.url.trim());
  if (!match) return null;
  const number = Number(match[5]);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  const instance = match[1].toLowerCase();
  const thread = match[4].toLowerCase() === 'merge_requests' ? 'pull' : 'issue';
  return { key: `${instance}/${match[2]}/${match[3]}${thread === 'pull' ? '!' : '#'}${number}`.toLowerCase(), instance, owner: match[2], repo: match[3], number, thread };
};

export const getLinkedGitLabThreads = (session: Session | null | undefined): GitLabThreadRef[] => {
  const seen = new Set<string>();
  return getLinkedIssues(session).flatMap((entry) => {
    const ref = getGitLabThreadRef(entry);
    if (!ref || seen.has(ref.key)) return [];
    seen.add(ref.key);
    return [ref];
  });
};

const uniqueGitHubThreads = (session: Session | null | undefined, thread: GitHubThreadRef['thread']) => {
  const seen = new Set<string>();
  return getLinkedIssues(session).flatMap((entry) => {
    const ref = getGitHubThreadRef(entry);
    if (!ref || ref.thread !== thread || seen.has(ref.key.toLowerCase())) return [];
    seen.add(ref.key.toLowerCase());
    return [{ ref, entry }];
  });
};

export const getLinkedGitHubPullRequests = (session: Session | null | undefined): LinkedGitHubPullRequest[] => (
  uniqueGitHubThreads(session, 'pull').map(({ ref, entry }) => (
    { owner: ref.owner, repo: ref.repo, number: ref.number, url: entry.url, title: entry.title }
  ))
);

export const buildLinkedLinearIssue = (input: {
  identifier: string;
  title: string;
  url: string;
  author?: { login?: string; avatarUrl?: string } | null;
  linkedAt: number;
}): LinkedTrackerItem => buildLinkedTrackerItem({ provider: 'linear', ...input });

export type LinkedSidebarChange = {
  key: string;
  identifier: string;
  url: string;
  title: string;
  repository?: RepositoryThreadRef;
  gitlab?: GitLabThreadRef;
};

export const getLinkedSidebarChanges = (session: Session | null | undefined, matcher?: RepositoryUrlMatcher): LinkedSidebarChange[] => {
  const seen = new Set<string>();
  if (!matcher) {
    return getLinkedIssues(session).flatMap((entry): LinkedSidebarChange[] => {
      if (!isLinkedChange(entry) || getGitHubThreadRef(entry)) return [];
      const gitlab = getGitLabThreadRef(entry);
      if (gitlab) {
        if (seen.has(gitlab.key)) return [];
        seen.add(gitlab.key);
        return [{ key: entry.id, identifier: `!${gitlab.number}`, url: entry.url, title: entry.title, gitlab }];
      }
      if (entry.kind === 'pull') return [{ key: entry.id, identifier: `!${entry.number}`, url: entry.url, title: entry.title }];
      return entry.kind === 'guest' || entry.kind === 'external'
        ? [{ key: entry.id, identifier: entry.identifier, url: entry.url, title: entry.title }]
        : [];
    });
  }
  return getLinkedIssues(session).flatMap((entry): LinkedSidebarChange[] => {
    if (!isLinkedChange(entry)) return [];
    const repository = getRepositoryThreadRef(entry, matcher);
    if (repository?.thread === 'discussion') return [];
    if (repository) {
      if (seen.has(repository.key)) return [];
      seen.add(repository.key);
      return [{ key: repository.key, identifier: repositoryThreadIdentifier(repository, matcher), url: entry.url, title: entry.title, repository }];
    }
    if (entry.kind === 'pull') return [{ key: entry.id, identifier: `#${entry.number}`, url: entry.url, title: entry.title }];
    return entry.kind === 'guest' || entry.kind === 'external'
      ? [{ key: entry.id, identifier: entry.identifier, url: entry.url, title: entry.title }]
      : [];
  });
};

export type LinkedSidebarIssue =
  | { source: 'repository'; key: string; ref: RepositoryThreadRef & { thread: 'issue' | 'discussion' }; identifier: string; url: string; title: string }
  | { source: 'tracker'; provider: string; key: string; identifier: string; url: string; title: string }
  | { source: 'github'; key: string; owner: string; repo: string; number: number; url: string; title: string }
  | { source: 'gitlab'; key: string; ref: GitLabThreadRef; identifier: string; url: string; title: string }
  | { source: 'linear' | 'guest' | 'external'; key: string; identifier: string; url: string; title: string };

export const getLinkedSidebarIssues = (session: Session | null | undefined, matcher?: RepositoryUrlMatcher): LinkedSidebarIssue[] => {
  if (!matcher) {
    const githubIssues = new Map(uniqueGitHubThreads(session, 'issue').map(({ ref, entry }) => [entry.id, ref]));
    const seenGitLab = new Set<string>();
    return getLinkedIssues(session).flatMap((entry): LinkedSidebarIssue[] => {
      const gitlab = isLinkedChange(entry) ? null : getGitLabThreadRef(entry);
      if (gitlab) {
        if (seenGitLab.has(gitlab.key)) return [];
        seenGitLab.add(gitlab.key);
        return [{ source: 'gitlab', key: entry.id, ref: gitlab, identifier: `#${gitlab.number}`, url: entry.url, title: entry.title }];
      }
      const ref = getGitHubThreadRef(entry);
      if (ref) {
        const unique = githubIssues.get(entry.id);
        return unique ? [{ source: 'github', key: unique.key, owner: unique.owner, repo: unique.repo, number: unique.number, url: entry.url, title: entry.title }] : [];
      }
      if (entry.kind === 'pull') return [];
      if (entry.kind === 'issue') {
        return [{ source: 'external', key: entry.id, identifier: `#${entry.number}`, url: entry.url, title: entry.title }];
      }
      if (entry.kind === 'tracker') {
        return [{ source: 'linear', key: entry.id, identifier: entry.identifier, url: entry.url, title: entry.title }];
      }
      if (entry.kind === 'guest' && !isGuestPull(entry)) {
        return [{ source: 'guest', key: entry.id, identifier: entry.identifier, url: entry.url, title: entry.title }];
      }
      if (entry.kind === 'external' && entry.thread === 'issue') {
        return [{ source: 'external', key: entry.id, identifier: entry.identifier, url: entry.url, title: entry.title }];
      }
      return [];
    });
  }
  const seen = new Set<string>();
  return getLinkedIssues(session).flatMap((entry): LinkedSidebarIssue[] => {
    const ref = getRepositoryThreadRef(entry, matcher);
    if (isLinkedChange(entry) && ref?.thread !== 'discussion') return [];
    if (ref) {
      const { thread } = ref;
      if (thread === 'pull' || seen.has(ref.key)) return [];
      seen.add(ref.key);
      return [{ source: 'repository', key: ref.key, ref: { ...ref, thread }, identifier: repositoryThreadIdentifier(ref, matcher), url: entry.url, title: entry.title }];
    }
    if (entry.kind === 'issue') {
      return [{ source: 'external', key: entry.id, identifier: `#${entry.number}`, url: entry.url, title: entry.title }];
    }
    if (entry.kind === 'tracker') {
      return [{ source: 'tracker', provider: entry.provider, key: entry.id, identifier: entry.identifier, url: entry.url, title: entry.title }];
    }
    if (entry.kind === 'guest') {
      return [{ source: 'guest', key: entry.id, identifier: entry.identifier, url: entry.url, title: entry.title }];
    }
    if (entry.kind === 'external') {
      return [{ source: 'external', key: entry.id, identifier: entry.identifier, url: entry.url, title: entry.title }];
    }
    return [];
  });
};

const normalizedThreadUrl = (url: string): string => url.trim().replace(/\/+$/, '').toLowerCase();

const isSameLinkedEntry = (entry: LinkedIssue, issue: LinkedIssue): boolean => {
  if (entry.id === issue.id) return true;
  return (entry.kind === 'issue' || entry.kind === 'pull')
    && entry.kind === issue.kind
    && entry.number === issue.number
    && normalizedThreadUrl(entry.url) === normalizedThreadUrl(issue.url);
};

export const withLinkedIssue = (
  metadata: SessionMetadataRecord,
  issue: LinkedIssue,
  linked: boolean,
): SessionMetadataRecord => {
  const openchamber = isRecord(metadata.openchamber) ? metadata.openchamber : {};
  const current = Array.isArray(openchamber.linked_issues)
    ? linkedIssueListSchema.parse(openchamber.linked_issues)
    : [];
  const withoutIssue = current.filter((entry) => !isSameLinkedEntry(entry, issue));
  const next = linked ? [...withoutIssue, issue] : withoutIssue;

  return {
    ...metadata,
    openchamber: {
      ...openchamber,
      linked_issues: next.map(toStoredLinkedIssue),
    },
  };
};
