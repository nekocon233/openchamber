import type { Part } from '@/lib/opencode/model';
import { readPlanQuestion } from './planPart';

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
    const questions = validParts.flatMap((part) => {
        const metadata = readPlanQuestion(part);
        return metadata ? [metadata] : [];
    });
    if (!questions.length) return visible;
    // Older servers did not identify the original call; keep their single-plan
    // rendering while newer records only replace the matching plan.
    const legacyQuestion = questions.some((question) => !question.nativePlanCallID);
    const answered = new Set(questions.map((question) => question.nativePlanCallID));
    return visible.filter((part) => !(part.type === 'tool' && part.tool === 'plan_exit'
        && (part.state.status === 'pending' || part.state.metadata?.openchamberToolSource !== 'mcp')
        && (legacyQuestion || answered.has(part.callID))));
};
