import { z } from 'zod';
import type { Metadata, ToolInput } from '@/lib/opencode/model';

const questionsSchema = z.array(z.object({
  question: z.string(), header: z.string().optional(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional() })).default([]),
}));
const answersSchema = z.array(z.array(z.string()));

/** Structured native answers retain multi-select and arbitrary user text. */
export const readQuestionTranscript = (input: ToolInput | undefined, metadata: Metadata | undefined) => {
  const source = z.object({ questions: questionsSchema }).safeParse(input);
  const result = z.object({ questionAnswers: answersSchema, questionResponse: z.string().optional() }).safeParse(metadata);
  if (!source.success || !result.success) return null;
  return {
    questions: source.data.questions.map((question, index) => ({ ...question, answers: result.data.questionAnswers[index] ?? [] })),
    response: result.data.questionResponse,
  };
};
