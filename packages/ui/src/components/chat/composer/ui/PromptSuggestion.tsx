import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';

interface PromptSuggestionProps {
    text: string;
    showKeyboardHint: boolean;
    onAccept: () => void;
}

// Positioned over an empty editor without becoming draft content or adding
// a row to the composer. Touch and keyboard acceptance both only fill it.
export function PromptSuggestion({ text, showKeyboardHint, onAccept }: PromptSuggestionProps) {
    const { t } = useI18n();

    return (
        <div className="absolute inset-x-3 top-2.5 z-20 min-w-0">
            <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onAccept}
                onMouseDown={(event) => event.preventDefault()}
                aria-label={t('chat.suggestion.applyAria')}
                title={text}
                className="w-full min-w-0 justify-start px-0 font-normal normal-case text-muted-foreground hover:!bg-transparent hover:text-foreground"
            >
                <span className="min-w-0 truncate">{text}</span>
                {showKeyboardHint ? (
                    <kbd aria-hidden="true" className="shrink-0 rounded border border-border px-1 text-xs">Tab</kbd>
                ) : null}
            </Button>
        </div>
    );
}
