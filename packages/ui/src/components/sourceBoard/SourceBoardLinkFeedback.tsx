import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { openExternalUrl } from '@/lib/url';

export type BoardLinkFeedbackState = 'loading' | 'notFound' | 'disconnected' | 'noRepository' | 'error';

/** A chat link stays on the board until the person chooses to open its URL. */
export function SourceBoardLinkFeedback({ url, state, error, onRetry }: {
    url: string;
    state: BoardLinkFeedbackState;
    error?: string | null;
    onRetry?: () => void;
}) {
    const { t } = useI18n();
    return (
        <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-auto p-6 text-center typography-meta" role={state === 'loading' ? 'status' : 'alert'}>
            <p>{t(`sourceBoard.link.${state}`)}</p>
            {state === 'error' && error ? <p className="max-w-prose whitespace-pre-wrap text-muted-foreground" dir="auto">{error}</p> : null}
            <p className="max-w-full break-all text-muted-foreground" dir="ltr">{url}</p>
            {state !== 'loading' ? (
                <div className="flex flex-wrap justify-center gap-2">
                    {onRetry ? <Button size="sm" variant="outline" onClick={onRetry}>{t('references.picker.actions.retry')}</Button> : null}
                    <Button size="sm" variant="outline" onClick={() => { void openExternalUrl(url); }}>{t('sourceBoard.link.openExternal')}</Button>
                </div>
            ) : null}
        </div>
    );
}
