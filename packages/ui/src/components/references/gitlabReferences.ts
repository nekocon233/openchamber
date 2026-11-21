import type {
    ChangeRequest,
    Project,
    RepositoryChangeRequestReference,
    SourceControlUser,
} from '@/lib/api/types';

const BODY_LIMIT = 20_000;

const author = (user: SourceControlUser | null | undefined) => (
    user ? { login: user.username, avatarUrl: user.avatarUrl } : null
);

const sourceRepo = (project: Project) => ({ owner: project.owner, repo: project.name, source: 'origin' });

const body = (text: string | undefined) => {
    const value = text ?? '';
    return { body: value.slice(0, BODY_LIMIT), bodyTruncated: value.length > BODY_LIMIT };
};

export const pullReferenceFromChangeRequest = (changeRequest: ChangeRequest): RepositoryChangeRequestReference => {
    const reference: RepositoryChangeRequestReference = {
        kind: 'pull',
        provider: changeRequest.provider,
        number: changeRequest.number,
        title: changeRequest.title,
        url: changeRequest.url,
        ...body(changeRequest.body),
        createdAt: changeRequest.createdAt ?? null,
        updatedAt: changeRequest.updatedAt ?? null,
        author: author(changeRequest.author),
        labels: (changeRequest.labels ?? []).map((label) => ({ name: label.name, color: label.color })),
        commentCount: 0,
        sourceRepo: sourceRepo(changeRequest.project),
        state: changeRequest.state,
        draft: changeRequest.draft,
        head: changeRequest.head,
        base: changeRequest.base,
        headSha: changeRequest.headSha ?? '',
        headRepo: changeRequest.headProject
            ? { owner: changeRequest.headProject.owner, repo: changeRequest.headProject.name, url: changeRequest.headProject.url }
            : null,
        projectId: changeRequest.project.id,
    };
    if (changeRequest.workInProgress !== undefined) reference.workInProgress = changeRequest.workInProgress;
    if (changeRequest.private !== undefined) reference.private = changeRequest.private;
    if (changeRequest.topic) reference.topic = changeRequest.topic;
    if (changeRequest.revisionNumber !== undefined) reference.revisionNumber = changeRequest.revisionNumber;
    return reference;
};
