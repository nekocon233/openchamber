import { ReviewSubmitButton } from '@/components/review/ReviewSubmitButton';
import { useComparisonReview } from '@/components/review/useChangeRequestReview';
import { PullRequestNavigation } from '@/components/views/git/PullRequestNavigation';
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
    renderReviewButton: (className?: string) => review && provider ? (
      <ReviewSubmitButton review={review} provider={provider} className={className}
        onVerdictDispatched={navigation ? () => navigation.navigate('origin') : undefined} />
    ) : null,
  };
}
