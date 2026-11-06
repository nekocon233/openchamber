import { z } from 'zod';

import type { FormRequest } from '@/lib/opencode/model';
import type { I18nKey, I18nParams } from '@/lib/i18n';
import type { QuestionInfo, QuestionRequest } from '@/types/question';
import { nativePlanExecutionChoiceSchema } from './schemas';
import { isNativeSessionId } from './ids';

type FormField = FormRequest['fields'][number];
type Translate = (key: I18nKey, params?: I18nParams) => string;

const fieldForQuestion = (question: QuestionInfo, index: number): FormField => {
  const common = {
    key: `question-${index}`,
    title: question.header,
    description: question.question,
    required: true,
    custom: true,
    options: question.options.map((option) => ({ value: option.label, label: option.label, description: option.description })),
  };
  return question.multiple
    ? { ...common, type: 'multiselect', minItems: 1 }
    : { ...common, type: 'string', minLength: 1 };
};

/** Native questions use the shared form state, dock and reply lifecycle. */
export const projectNativeQuestion = (question: QuestionRequest): FormRequest | null => {
  const [first, ...rest] = question.questions.map((info, index) => {
    const field = fieldForQuestion(info, index);
    const approval = question.kind && (info.planApproval ?? question.questions.length === 1);
    if (approval && field.type === 'string' && field.options?.some((option) => option.value === 'build')) field.default = 'build';
    return field;
  });
  if (!first) return null;
  const form: FormRequest = {
    id: question.id,
    sessionID: question.sessionID,
    title: question.questions[0].header,
    fields: [first, ...rest],
    metadata: { openchamberNativeQuestionKind: question.kind ?? 'question' },
  };
  if (question.canSelectExecutionModel) form.metadata = { ...form.metadata, openchamberCanSelectExecutionModel: true };
  if (question.executionPending) form.metadata = { ...form.metadata, openchamberPlanExecutionPending: question.executionPending };
  return form;
};

const nativePlanExecutionMetadata = z.object({
  openchamberNativeQuestionKind: z.enum(['claude-plan-exit', 'codex-plan-exit', 'deepseek-plan-exit', 'antigravity-plan-exit']),
  openchamberCanSelectExecutionModel: z.literal(true),
  openchamberPlanExecutionPending: nativePlanExecutionChoiceSchema.optional(),
});

export const readNativePlanExecution = (form: FormRequest) => isNativeSessionId(form.sessionID)
  ? nativePlanExecutionMetadata.safeParse(form.metadata).data ?? null : null;

/** Localize native field labels and plan choices while retaining the CLI's answer values. */
export const localizeNativeForm = (form: FormRequest, t: Translate): FormRequest => {
  const kind = form.metadata?.openchamberNativeQuestionKind;
  if (kind === 'question' && form.fields.some((field) => !field.title?.trim())) {
    const [first, ...rest] = form.fields.map((field, index): FormField => field.title?.trim() ? field : {
      ...field, title: t('chat.questionCard.questionFallback', { index: String(index + 1) }),
    });
    return { ...form, fields: [first, ...rest] };
  }
  if (kind !== 'claude-plan-exit' && kind !== 'codex-plan-exit' && kind !== 'deepseek-plan-exit' && kind !== 'antigravity-plan-exit') return form;
  const [first, ...rest] = form.fields.map((field): FormField => {
    if (field.type !== 'string' && field.type !== 'multiselect') return field;
    const options = field.options?.map((option) => ({
      ...option,
      label: option.value === 'build' ? t('chat.questionCard.planExitApprove')
        : option.value === 'plan' ? t('chat.questionCard.planExitKeepPlanning') : option.label,
    }));
    const description = [t('chat.questionCard.planExitQuestion'), field.description].filter(Boolean).join('\n\n');
    const title = kind === 'codex-plan-exit' || kind === 'antigravity-plan-exit' ? t('chat.questionCard.planExitTitle') : field.title;
    return field.type === 'multiselect'
      ? { ...field, title, description, options: options ?? [] }
      : { ...field, title, description, options };
  });
  return { ...form, title: t('chat.questionCard.planExitTitle'), fields: [first, ...rest] };
};

const answerSchema = z.record(z.string().regex(/^question-\d+$/), z.union([z.string(), z.array(z.string())]));

export const nativeQuestionAnswers = (answer: Record<string, string | number | boolean | string[]>): string[][] => {
  const entries = Object.entries(answerSchema.parse(answer))
    .sort(([left], [right]) => Number(left.slice(9)) - Number(right.slice(9)));
  return entries.map(([key, value], index) => {
    if (key !== `question-${index}`) throw new Error('Native question answers are incomplete');
    return Array.isArray(value) ? value : [value];
  });
};
