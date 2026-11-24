import { ReviewSubmitButton } from '@/components/review/ReviewSubmitButton';
import { useComparisonReview } from '@/components/review/useChangeRequestReview';
import { PullRequestComparisonMerge } from '@/components/views/git/PullRequestComparisonMerge';
import { PullRequestNavigation } from '@/components/views/git/PullRequestNavigation';
import { cn } from '@/lib/utils';
import { usePullRequestNavigation } from '@/components/views/git/usePullRequestNavigation';

export function useMobileChangesReview(
  comparison: Parameters<typeof useComparisonReview>[0],
  directory: string,
  returnDirectory: string | null,
  visible: boolean,
  comparedHead: string | null,
) {
  const { review, provider } = useComparisonReview(comparison, directory, visible, comparedHead);
  const navigation = usePullRequestNavigation({
    directory: returnDirectory,
    source: comparison.selectedSource,
    context: comparison.readContext,
  });
  return {
    review,
    navigationButtons: <PullRequestNavigation compact navigation={navigation} />,
    renderPullActions: (className?: string) => visible && (review || comparedHead) ? (
      <div className={cn('flex shrink-0 items-center gap-1', className)}>
        {review && provider ? <ReviewSubmitButton review={review} provider={provider}
          onVerdictDispatched={navigation ? () => navigation.navigate('origin') : undefined} /> : null}
        <PullRequestComparisonMerge comparison={comparison} comparedHead={comparedHead}
          onSubmitted={() => navigation?.navigate('origin')} />
      </div>
    ) : null,
  };
}
