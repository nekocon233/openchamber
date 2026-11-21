import { useCallback } from 'react';
import { useChatColumnExpandedInput } from '../../chatColumnSession';



export function useComposerExpansion(isBtwActive: boolean, isMobile: boolean) {
    const { expanded: persistedExpandedInput, setExpanded: setExpandedInput } = useChatColumnExpandedInput();

    const isExpandedInput = !isBtwActive && persistedExpandedInput;
    const isDesktopExpanded = isExpandedInput && !isMobile;

    const isMobileExpanded = isExpandedInput && isMobile;

    const isComposerExpanded = isDesktopExpanded || isMobileExpanded;

    const toggleExpandedInput = useCallback(() => {
        if (!isBtwActive) setExpandedInput(!isExpandedInput);
    }, [isBtwActive, isExpandedInput, setExpandedInput]);

    return {
        setExpandedInput, toggleExpandedInput, isExpandedInput, isDesktopExpanded, isMobileExpanded, isComposerExpanded,
    };
}
