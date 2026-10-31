import { createHash } from 'node:crypto';
import path from 'node:path';

import { z } from 'zod';

import { NATIVE_PROVIDER_ANTIGRAVITY } from '../ids.js';
import { buildToolPart } from '../records.js';
import { agyTime, decodeAgyToolArguments } from './protocol.js';
import { agyInteractionTruncated, parseAgyInteractionSignal } from './interaction-signals.js';

const contextSchema = z.object({
  nativeId: z.string().uuid(),
  sessionId: z.string().min(1),
  readRoot: z.string().min(1),
  directory: z.string().min(1),
});
const bindingSchema = z.object({ messageId: z.string().min(1) });
const sendSchema = z.object({
  messageId: z.string().min(1),
  providerID: z.literal(NATIVE_PROVIDER_ANTIGRAVITY),
  modelID: z.string(),
  variant: z.string().optional(),
  agent: z.enum(['build', 'plan']),
  sentAt: z.number().nonnegative(),
  antigravity: z.object({
    stepIndex: z.number().int().nonnegative().optional(),
    completion: z.object({
      outcome: z.enum(['success', 'error', 'aborted']),
      time: z.number().nonnegative(),
    }).optional(),
    denial: z.object({ actions: z.array(z.string()), time: z.number().nonnegative() }).optional(),
  }).optional(),
});
const artifactLocationSchema = z.discriminatedUnion('name', [
  z.object({ name: z.literal('write_file'), args: z.object({ Path: z.string() }) }),
  z.object({ name: z.literal('write_to_file'), args: z.object({ TargetFile: z.string() }) }),
]);

const targetsPlanArtifact = (call, nativeId, readRoot) => {
  const location = artifactLocationSchema.safeParse(call);
  if (!location.success) return false;
  const { parameters } = decodeAgyToolArguments(location.data.args, call.argumentsEncoded ?? false);
  const parsed = artifactLocationSchema.safeParse({ name: location.data.name, args: parameters });
  if (!parsed.success) return false;
  const target = parsed.data.name === 'write_file' ? parsed.data.args.Path : parsed.data.args.TargetFile;
  return target === path.join(readRoot, 'brain', nativeId, 'implementation_plan.md');
};

const skippedQuestions = (result, count) => {
  if (result?.type !== 'GENERIC' || result.status !== 'DONE' || (result.error ?? '').trim() !== ''
    || agyInteractionTruncated(result, 'content') || agyInteractionTruncated(result, 'error')) return false;
  const answers = (result.content ?? '').split(/\r?\n/).filter((line) => /^A\d+:/.test(line));
  return answers.length === count && answers.every((line, index) => line === `A${index + 1}: User Skipped`);
};

/** Extracts one already-read native round. Publication and persistence belong to the decision owner. */
const segmentProposal = ({ entries, nativeId, readRoot, sessionId, directory, sends, bindings }) => {
  const user = entries[0];
  if (user?.type !== 'USER_INPUT') return null;
  const final = entries.findLast((entry) => entry.type !== 'EPHEMERAL_MESSAGE');
  if (final?.type !== 'PLANNER_RESPONSE' || final.status !== 'DONE'
    || (final.content ?? '').trim() === '' || (final.tool_calls?.length ?? 0) !== 0
    || (final.error ?? '').trim() !== ''
    || agyInteractionTruncated(final, 'content') || agyInteractionTruncated(final, 'error')
    || agyInteractionTruncated(final, 'tool_calls')) return null;

  const binding = bindingSchema.safeParse(bindings.get(user.step_index));
  if (!binding.success) return null;
  const saved = sendSchema.safeParse(sends.get(binding.data.messageId));
  if (!saved.success) return null;
  const send = saved.data;
  if (send.messageId !== binding.data.messageId
    || send.antigravity?.stepIndex !== undefined && send.antigravity.stepIndex !== user.step_index) return null;
  const completion = send.antigravity?.completion;
  if (completion && completion.outcome !== 'success') return null;
  if (!completion && (send.agent !== 'plan' || send.antigravity?.denial
    || entries.some((entry) => entry.type === 'ERROR_MESSAGE'))) return null;

  const byStep = new Map(entries.map((entry) => [entry.step_index, entry]));
  const questions = [];
  const questionSteps = [];
  let markedPlan = null;
  let legacyPlan = null;
  for (const entry of entries) {
    if (entry.type !== 'PLANNER_RESPONSE' || (entry.tool_calls?.length ?? 0) === 0) continue;
    if (entry.status !== 'DONE' || agyInteractionTruncated(entry, 'tool_calls')) return null;
    for (const [index, call] of entry.tool_calls.entries()) {
      const toolStep = entry.step_index + index + 1;
      const signal = parseAgyInteractionSignal(call, { nativeId, readRoot });
      if (!signal) {
        if (call.name === 'ask_question' || targetsPlanArtifact(call, nativeId, readRoot)) return null;
        continue;
      }
      const result = byStep.get(toolStep);
      if (call.name === 'ask_question') {
        if (!completion || !skippedQuestions(result, signal.questions.length)) continue;
        if (signal.kind === 'plan') markedPlan = { signal, toolStep };
        else {
          questions.push(...signal.questions);
          questionSteps.push(toolStep);
        }
      } else if (result?.type === 'GENERIC' && (result.status === 'DONE' || result.status === 'ERROR')) {
        legacyPlan = { signal, toolStep };
      }
    }
  }
  const plan = markedPlan ?? legacyPlan;
  if (questions.length === 0 && !plan) return null;
  const signal = questions.length > 0 ? { kind: 'questions', questions } : plan.signal;
  const sourceSteps = questions.length > 0 ? questionSteps : [plan.toolStep];
  const revision = createHash('sha256').update(JSON.stringify({
    nativeId, userStep: user.step_index, finalStep: final.step_index, sourceSteps, signal,
  })).digest('hex');
  const key = nativeId.replaceAll('-', '');
  const callID = `nag_i_${key}_${user.step_index}_${revision}`;
  const messageID = `nag_a_${key}_${final.step_index}`;
  const kind = signal.kind === 'plan' ? 'antigravity-plan-exit' : undefined;
  /** @type {import('./decisions.js').AntigravityProposal['send']} */
  const selection = { modelID: send.modelID, agent: send.agent };
  if (send.variant !== undefined) selection.variant = send.variant;
  /** @type {import('./decisions.js').AntigravityProposal} */
  const proposal = {
    sessionId, directory, userStep: user.step_index, callID, revision,
    tool: { messageID, callID },
    questions: signal.questions,
    send: selection,
  };
  if (kind) {
    proposal.kind = kind;
    proposal.plan = signal.plan;
  }
  const time = agyTime(final.created_at, completion?.time ?? send.sentAt);
  const part = buildToolPart({
    id: `${callID}_part`, sessionID: sessionId, messageID, callID,
    tool: kind ? 'plan_exit' : 'question',
    input: kind ? { plan: signal.plan } : { questions: signal.questions },
    title: '', start: time,
    metadata: kind ? { nativeQuestionKind: kind } : {},
    result: { status: 'completed', output: '', end: time },
  });
  return { proposal, part, messageID };
};

const validContext = (input) => {
  const parsed = contextSchema.safeParse(input);
  return parsed.success && parsed.data.sessionId === `nag_${parsed.data.nativeId}`
    && path.isAbsolute(parsed.data.readRoot) && path.isAbsolute(parsed.data.directory);
};

/**
 * Keeps synthetic tools for every complete app-owned round so saved answers
 * remain attached after a follow-up. Only latest may become a new decision.
 * entries, sends and bindings come from the owning transcript/registry readers.
 */
export const agyInteractionHistory = (input) => {
  const empty = { proposals: [], latest: null };
  if (!validContext(input)) return empty;
  const { entries, sends, bindings } = input;
  const proposals = [];
  let start = -1;
  let latest = null;
  for (let index = 0; index <= entries.length; index += 1) {
    if (index < entries.length && entries[index].type !== 'USER_INPUT') continue;
    if (start >= 0) {
      const result = segmentProposal({ ...input, entries: entries.slice(start, index), sends, bindings });
      if (result) proposals.push(result);
      if (index === entries.length) latest = result;
    }
    start = index;
  }
  return { proposals, latest };
};

/** The current native round alone may offer an application question or plan. */
export const agyInteractionProposal = (input) => {
  if (!validContext(input)) return null;
  const start = input.entries.findLastIndex((entry) => entry.type === 'USER_INPUT');
  if (start < 0) return null;
  return segmentProposal({ ...input, entries: input.entries.slice(start) });
};
