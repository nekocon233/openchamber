import { pullReferenceFromChangeRequest } from '@/components/references/listBackedReferences';
import { refreshProjectPullLists } from '@/components/references/referenceSources';
import { PullRequestMergeActions } from '@/components/sourceBoard/PullRequestMergeActions';
import { usePullRequestAtComparedHead } from '@/hooks/usePullRequestComparison';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { ChangeRequest, SourceControlReadContext } from '@/lib/api/types';
import type { PullRequestSource } from '@/lib/diff/pullRequestDiff';
import { sourceControlReadContextParts } from '@/lib/source-control/identity';

type Comparison = {
    selectedSource: PullRequestSource | null;
    prs: ChangeRequest[];
    readContext: SourceControlReadContext | null;
};

export function PullRequestComparisonMerge({ comparison, comparedHead, onSubmitted }: {
    comparison: Comparison;
    comparedHead: string | null;
    onSubmitted: () => void;
}) {
    const { selectedSource: source, readContext: context, prs } = comparison;
    if (!source?.sourceRepo || source.linked || source.revision || !context || context.linked || !comparedHead) return null;
    const { owner, repo } = source.sourceRepo;
    const { number } = source;
    const listed = prs.find((pr) => pr.number === number && pr.project.owner === owner
        && pr.project.name === repo && pr.headSha === comparedHead);
    return (
        <ComparisonMergeTarget
            key={JSON.stringify([sourceControlReadContextParts(context), owner, repo, number, comparedHead])}
            context={context} owner={owner} repo={repo} number={number} comparedHead={comparedHead}
            listed={listed} onSubmitted={onSubmitted}
        />
    );
}

function ComparisonMergeTarget({ context, owner, repo, number, comparedHead, listed, onSubmitted }: {
    context: SourceControlReadContext;
    owner: string;
    repo: string;
    number: number;
    comparedHead: string;
    listed?: ChangeRequest;
    onSubmitted: () => void;
}) {
    const { sourceControl } = useRuntimeAPIs();
    const target = usePullRequestAtComparedHead(context, { owner, repo, number, headSha: comparedHead }, listed);
    if (!target) return null;

    return (
        <PullRequestMergeActions
            pull={pullReferenceFromChangeRequest(target.pull)} context={context} placement="toolbar" stack={target.stack}
            onMergeSubmitted={onSubmitted} onChanged={() => void refreshProjectPullLists(sourceControl, context)}
        />
    );
}
