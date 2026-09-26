import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';

interface PromptSuggestionProps {
    text: string;
    onAccept: () => void;
}

// The composer's top row on desktop and mobile. Applying fills the draft.
export function PromptSuggestion({ text, onAccept }: PromptSuggestionProps) {
    const { t } = useI18n();

    return (
        <div className="flex h-10 shrink-0 items-center border-b border-border/60 px-3">
            <Tooltip>
                <TooltipTrigger asChild>
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={onAccept}
                        onMouseDown={(event) => event.preventDefault()}
                        aria-label={t('chat.suggestion.applyAria')}
                        className="min-w-0 flex-1 shrink justify-start px-0 text-sm font-normal normal-case text-muted-foreground hover:!bg-transparent hover:text-foreground has-[>svg]:px-0"
                    >
                        <Icon name="pencil-ai-2" className="size-3.5 shrink-0 opacity-70" />
                        <span className="truncate">{text}</span>
                    </Button>
                </TooltipTrigger>
                <TooltipContent className="max-w-sm whitespace-pre-wrap">{text}</TooltipContent>
            </Tooltip>
        </div>
    );
}
