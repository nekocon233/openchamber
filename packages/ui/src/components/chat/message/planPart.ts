import { z } from 'zod';
import type { Part, ToolPart } from '@/lib/opencode/model';

const questionMetadata = z.object({
    nativeQuestionKind: z.enum(['claude-plan-exit', 'codex-plan-exit', 'deepseek-plan-exit', 'antigravity-plan-exit']),
    nativePlanCallID: z.string().min(1).optional(),
});
const planInput = z.object({ plan: z.string().trim().min(1) });
const questionInput = z.object({ questions: z.array(z.object({ question: z.string() })).min(1) });

export const readPlanQuestion = (part: Part) => {
    if (part.type !== 'tool' || part.tool !== 'question' || part.state.status === 'pending'
        || part.state.metadata?.openchamberToolSource === 'mcp') return null;
    return questionMetadata.safeParse(part.state.metadata).data ?? null;
};

/** Only explicit plan tools and native plan decisions can be plan content. */
export const readPlanPart = (part: Part): { callID: string; text: string } | null => {
    if (part.type !== 'tool' || (part.state.status !== 'pending' && part.state.metadata?.openchamberToolSource === 'mcp')) return null;
    if (part.tool === 'plan_exit') {
        const input = planInput.safeParse(part.state.input).data;
        return input ? { callID: part.callID, text: input.plan } : null;
    }
    const metadata = readPlanQuestion(part);
    if (!metadata) return null;
    const input = questionInput.safeParse(part.state.input).data;
    const text = input?.questions.map((question) => question.question.trim()).filter(Boolean).join('\n\n');
    return text ? { callID: metadata.nativePlanCallID ?? part.callID, text } : null;
};

export type FinalPlan = {
    messageID: string;
    part: ToolPart;
    callID: string;
    /** Both representations stay out of the activity when the plan is shown separately. */
    sourcePartIDs: ReadonlySet<string>;
};

/** Reverse chronological lookup over one rendered turn, without parsing Markdown. */
export const findFinalPlan = (messages: readonly { info: { id: string }; parts: Part[] }[]): FinalPlan | undefined => {
    for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
        const message = messages[messageIndex];
        const originals = new Map<string, ToolPart>();
        const questions = new Map<string, ToolPart>();
        for (const part of message.parts) {
            if (part.type !== 'tool') continue;
            if (part.tool === 'plan_exit' && (part.state.status === 'pending' || part.state.metadata?.openchamberToolSource !== 'mcp')) {
                originals.set(part.callID, part);
            }
            const question = readPlanQuestion(part);
            if (question?.nativePlanCallID && readPlanPart(part)) questions.set(question.nativePlanCallID, part);
        }
        for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex--) {
            const part = message.parts[partIndex];
            if (part.type !== 'tool') continue;
            const question = readPlanQuestion(part);
            if (question?.nativePlanCallID && originals.has(question.nativePlanCallID)) continue;
            const shownPart = part.tool === 'plan_exit' ? questions.get(part.callID) ?? part : part;
            const plan = readPlanPart(shownPart);
            if (plan === null) continue;
            const { callID } = plan;
            // A late answer update cannot move an older proposal after a newer
            // one: the original call owns the proposal's position.
            const sourcePartIDs = new Set([shownPart.id]);
            const original = originals.get(callID);
            if (original) sourcePartIDs.add(original.id);
            return { messageID: message.info.id, part: shownPart, callID, sourcePartIDs };
        }
    }
};
