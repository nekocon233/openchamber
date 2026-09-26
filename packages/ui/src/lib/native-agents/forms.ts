import { z } from 'zod';

import type { FormRequest } from '@/lib/opencode/model';
import type { I18nKey, I18nParams } from '@/lib/i18n';
import type { QuestionInfo, QuestionRequest } from '@/types/question';

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
  const [first, ...rest] = question.questions.map(fieldForQuestion);
  if (!first) return null;
  return {
    id: question.id,
    sessionID: question.sessionID,
    title: question.questions[0].header,
    fields: [first, ...rest],
    metadata: { openchamberNativeQuestionKind: question.kind ?? 'question' },
  };
};

/** Localize the plan decision while retaining the CLI's exact answer values. */
export const localizeNativeForm = (form: FormRequest, t: Translate): FormRequest => {
  if (form.metadata?.openchamberNativeQuestionKind !== 'claude-plan-exit') return form;
  const [first, ...rest] = form.fields.map((field): FormField => {
    if (field.type !== 'string' && field.type !== 'multiselect') return field;
    const options = field.options?.map((option) => ({
      ...option,
      label: option.value === 'build' ? t('chat.questionCard.planExitApprove')
        : option.value === 'plan' ? t('chat.questionCard.planExitKeepPlanning') : option.label,
    }));
    const description = [t('chat.questionCard.planExitQuestion'), field.description].filter(Boolean).join('\n\n');
    return field.type === 'multiselect'
      ? { ...field, description, options: options ?? [] }
      : { ...field, description, options };
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
