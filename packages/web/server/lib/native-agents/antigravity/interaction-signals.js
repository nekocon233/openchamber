import path from 'node:path';

import { z } from 'zod';

import { decodeAgyToolArguments } from './protocol.js';

export const AGY_PLAN_QUESTION_PREFIX = '<openchamber-plan-v1>\n';

const shortenedOutput = /<truncated \d+(?: lines|(?: of \d+)? bytes(?: from the middle of the output)?)>/;
const truncationMetadata = z.object({
  truncated: z.boolean().optional(),
  args_truncated: z.boolean().optional(),
  input_truncated: z.boolean().optional(),
  truncated_fields: z.array(z.string()).optional(),
  content: z.string().optional(),
});

/** Native markers can name a whole field, a nested argument, or a tool call. */
export const agyInteractionTruncated = (value, field) => {
  const parsed = truncationMetadata.safeParse(value);
  if (!parsed.success) return true;
  const metadata = parsed.data;
  if (metadata.truncated || metadata.args_truncated || metadata.input_truncated) return true;
  if (field === 'content' && shortenedOutput.test(metadata.content ?? '')) return true;
  return (metadata.truncated_fields ?? []).some((reference) => {
    if (field === undefined) return true;
    const normalized = reference.replace(/^\$\.|^\//, '');
    return normalized === '*' || normalized === field
      || ['.', '[', '/'].some((separator) => normalized.startsWith(`${field}${separator}`));
  });
};

const nonemptyText = z.string().refine((value) => value.trim().length > 0 && !shortenedOutput.test(value));
const nativeQuestion = z.object({
  question: nonemptyText,
  options: z.array(nonemptyText).min(1).refine((options) => new Set(options).size === options.length),
  is_multi_select: z.boolean(),
}).strict();
const questionArgs = truncationMetadata.extend({ questions: z.array(nativeQuestion).min(1) });
const feedbackMetadata = truncationMetadata.extend({ RequestFeedback: z.literal(true), UserFacing: z.literal(true) });
const writeArgs = truncationMetadata.extend({ Path: nonemptyText, Content: nonemptyText, ArtifactMetadata: feedbackMetadata });
const writeToFileArgs = truncationMetadata.extend({ TargetFile: nonemptyText, CodeContent: nonemptyText, ArtifactMetadata: feedbackMetadata });

const callHeader = truncationMetadata.extend({
  name: z.enum(['ask_question', 'write_file', 'write_to_file']),
  argumentsEncoded: z.boolean().optional(),
});
const nativeCall = z.discriminatedUnion('name', [
  z.object({ name: z.literal('ask_question'), args: questionArgs }),
  z.object({ name: z.literal('write_file'), args: writeArgs }),
  z.object({ name: z.literal('write_to_file'), args: writeToFileArgs }),
]);
const encodedCall = z.discriminatedUnion('name', [
  z.object({ name: z.literal('ask_question'), args: z.object({ questions: z.string() }).passthrough() }),
  z.object({ name: z.literal('write_file'), args: z.object({ Path: z.string(), Content: z.string(), ArtifactMetadata: z.string() }).passthrough() }),
  z.object({ name: z.literal('write_to_file'), args: z.object({ TargetFile: z.string(), CodeContent: z.string(), ArtifactMetadata: z.string() }).passthrough() }),
]);
const scope = z.object({
  nativeId: z.string().uuid(),
  readRoot: nonemptyText,
  argsTruncated: z.boolean().default(false),
});

const planSignal = (plan) => ({
  kind: 'plan',
  plan,
  questions: [{
    question: plan,
    header: 'Plan',
    options: ['build', 'plan'].map((label) => ({ label, description: '' })),
    multiple: false,
  }],
});

/**
 * Parses complete native tool arguments into an application proposal. This
 * establishes neither native tool success nor a pending native interaction.
 * The owner gates publication on the current turn and handles reply delivery.
 * readRoot is the CLI data root containing brain/, not a supplied tool path.
 */
export const parseAgyInteractionSignal = (call, options) => {
  const header = callHeader.safeParse(call);
  if (!header.success || agyInteractionTruncated(header.data)) return null;
  const context = scope.safeParse(options);
  if (!context.success || context.data.argsTruncated || !path.isAbsolute(context.data.readRoot)) return null;

  let input = call;
  if (header.data.argumentsEncoded === true) {
    const encoded = encodedCall.safeParse(call);
    if (!encoded.success) return null;
    const { parameters } = decodeAgyToolArguments(encoded.data.args, true);
    input = { name: encoded.data.name, args: parameters };
  }
  const parsed = nativeCall.safeParse(input);
  if (!parsed.success) return null;
  const { name, args } = parsed.data;
  if (agyInteractionTruncated(args)) return null;

  if (name === 'ask_question') {
    const marked = args.questions.filter((question) => question.question.startsWith('<openchamber-plan-'));
    if (marked.length > 0) {
      if (args.questions.length !== 1) return null;
      const question = marked[0];
      if (!question.question.startsWith(AGY_PLAN_QUESTION_PREFIX)
        || question.is_multi_select
        || question.options.length !== 2
        || question.options[0] !== 'build'
        || question.options[1] !== 'plan') return null;
      const plan = question.question.slice(AGY_PLAN_QUESTION_PREFIX.length);
      if (!nonemptyText.safeParse(plan).success) return null;
      return planSignal(plan);
    }
    return {
      kind: 'questions',
      questions: args.questions.map((question) => ({
        question: question.question,
        header: '',
        options: question.options.map((label) => ({ label, description: '' })),
        multiple: question.is_multi_select,
      })),
    };
  }

  const filePath = name === 'write_file' ? args.Path : args.TargetFile;
  const expectedPath = path.join(context.data.readRoot, 'brain', context.data.nativeId, 'implementation_plan.md');
  if (filePath !== expectedPath || agyInteractionTruncated(args.ArtifactMetadata)) return null;
  return planSignal(name === 'write_file' ? args.Content : args.CodeContent);
};
