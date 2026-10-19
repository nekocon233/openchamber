import type { GitHubReferenceKind } from '@/lib/api/types';
import { parseChangeRequestReference } from '@/lib/source-control/changeRequestReference';
import { parseIssueReference } from '@/lib/source-control/issueReference';

const LINEAR_ISSUE_URL = /^https?:\/\/linear\.app\/[^/]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:[/?#]|$)/;

type BoardTarget =
    | { source: 'repository'; kind: GitHubReferenceKind }
    | { source: 'linear'; identifier: string };

/** Classify a tracker URL without loading the board's React hooks or stores. */
export const boardTargetOfUrl = (url: string): BoardTarget | null => {
    const linear = url.match(LINEAR_ISSUE_URL);
    if (linear) return { source: 'linear', identifier: linear[1].toUpperCase() };
    if (parseChangeRequestReference(url)?.project) return { source: 'repository', kind: 'pull' };
    if (parseIssueReference(url)?.project) return { source: 'repository', kind: 'issue' };
    return null;
};

const repositoryItemOfUrl = (url: string): string | null => {
    const changeRequest = parseChangeRequestReference(url);
    const reference = changeRequest?.project ? changeRequest : parseIssueReference(url);
    if (!reference?.project) return null;
    // GitLab numbers issues and merge requests separately; GitHub shares one number.
    const kind = reference.identity?.provider === 'gitlab' ? (reference === changeRequest ? '!' : '#') : '#';
    return `${reference.identity?.instance ?? ''}/${reference.project.owner}/${reference.project.name}${kind}${reference.number}`.toLowerCase();
};

export const isSameRepositoryItemLink = (left: string, right: string): boolean => {
    const item = repositoryItemOfUrl(left);
    return item !== null && item === repositoryItemOfUrl(right);
};
