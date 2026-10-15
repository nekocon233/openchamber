import type { Part } from '@/lib/opencode/model';

const isValidPart = (part: unknown): part is Part => {
    return Boolean(part && typeof part === 'object' && typeof (part as { type?: unknown }).type === 'string');
};

export const normalizeParts = (parts: Part[]): Part[] => {
    return parts.filter(isValidPart);
};

export const extractTextContent = (part: Part): string => {
    return part.type === 'text' || part.type === 'reasoning' ? part.text : '';
};

export const isEmptyTextPart = (part: Part): boolean => {
    if (part.type !== 'text') {
        return false;
    }
    return part.text.trim().length === 0;
};

interface VisibleFilterOptions {
    includeReasoning?: boolean;
}

/**
 * The question the server builds for an answered plan exit. It carries the plan
 * and the choice that was made, which is everything the tool call it was built
 * from held.
 */
const isPlanExitQuestion = (part: Part): boolean => {
    if (part.type !== 'tool' || part.tool !== 'question' || part.state.status === 'pending') return false;
    const kind = part.state.metadata?.nativeQuestionKind;
    return kind === 'claude-plan-exit' || kind === 'codex-plan-exit';
};

/**
 * The parts a message actually shows.
 *
 * OpenCode v2 no longer marks parts synthetic and no longer sends patch
 * parts, so the only choice left here is whether reasoning is on screen.
 *
 * An answered plan exit is on screen once: as the question above it. The two
 * are the same event, and only the question kept the answer.
 */
export const filterVisibleParts = (parts: Part[], options: VisibleFilterOptions = {}): Part[] => {
    const { includeReasoning = true } = options;
    const validParts = normalizeParts(parts);
    const visible = includeReasoning ? validParts : validParts.filter((part) => part.type !== 'reasoning');
    if (!validParts.some(isPlanExitQuestion)) return visible;
    return visible.filter((part) => !(part.type === 'tool' && part.tool === 'plan_exit'));
};
