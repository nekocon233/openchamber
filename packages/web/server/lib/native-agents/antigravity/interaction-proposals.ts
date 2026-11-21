import { createHash } from 'node:crypto';
import path from 'node:path';

import { z } from 'zod';

import { NATIVE_PROVIDER_ANTIGRAVITY } from '../ids.js';
import { buildToolPart } from '../records.js';
import type { NativeToolPart } from '../records.js';
import type { RegistrySendRecord } from '../registry.js';
import { agyTime, decodeAgyToolArguments } from './protocol.js';
import type { AgyTranscriptStep, AgyTranscriptToolCall } from './protocol.js';
import { agyInteractionTruncated, parseAgyInteractionSignal } from './interaction-signals.js';
import type { AgyInteractionSignal, AgyQuestionInfo } from './interaction-signals.js';
import type { AntigravityProposal, AntigravityProposalSelection } from './decisions.js';
import type { JsonObject } from '../../shared/json-values.js';

export interface AgyInteractionProposalEntry {
  proposal: AntigravityProposal;
  part: NativeToolPart;
  messageID: string;
}

export interface AgyInteractionHistoryResult {
  proposals: AgyInteractionProposalEntry[];
  latest: AgyInteractionProposalEntry | null;
}

export interface AgyInteractionProposalInput {
  nativeId: string;
  sessionId: string;
  readRoot: string;
  directory: string;
  entries: readonly AgyTranscriptStep[];
  sends: ReadonlyMap<string, RegistrySendRecord>;
  bindings: ReadonlyMap<number, RegistrySendRecord>;
  now?: (() => number) | undefined;
}

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

const targetsPlanArtifact = (
  call: AgyTranscriptToolCall,
  nativeId: string,
  readRoot: string,
): boolean => {
  const location = artifactLocationSchema.safeParse(call);
  if (!location.success) return false;
  const { parameters } = decodeAgyToolArguments(location.data.args, call.argumentsEncoded ?? false);
  const parsed = artifactLocationSchema.safeParse({ name: location.data.name, args: parameters });
  if (!parsed.success) return false;
  const target = parsed.data.name === 'write_file' ? parsed.data.args.Path : parsed.data.args.TargetFile;
  return target === path.join(readRoot, 'brain', nativeId, 'implementation_plan.md');
};

const skippedQuestions = (result: AgyTranscriptStep | undefined, count: number): boolean => {
  if (result?.type !== 'GENERIC' || result.status !== 'DONE' || (result.error ?? '').trim() !== ''
    || agyInteractionTruncated(result, 'content') || agyInteractionTruncated(result, 'error')) return false;
  const answers = (result.content ?? '').split(/\r?\n/).filter((line) => /^A\d+:/.test(line));
  return answers.length === count && answers.every((line, index) => (
    line === `A${index + 1}: User Skipped` || line.trimEnd() === `A${index + 1}:`
  ));
};

const segmentProposal = ({
  entries,
  nativeId,
  readRoot,
  sessionId,
  directory,
  sends,
  bindings,
}: AgyInteractionProposalInput): AgyInteractionProposalEntry | null => {
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
    || (send.antigravity?.stepIndex !== undefined && send.antigravity.stepIndex !== user.step_index)) return null;
  const completion = send.antigravity?.completion;
  if (completion && completion.outcome !== 'success') return null;
  if (!completion && (send.agent !== 'plan' || send.antigravity?.denial
    || entries.some((entry) => entry.type === 'ERROR_MESSAGE'))) return null;

  const byStep = new Map(entries.map((entry) => [entry.step_index, entry]));
  const questions: AgyQuestionInfo[] = [];
  const questionSteps: number[] = [];
  let markedPlan: { signal: Extract<AgyInteractionSignal, { kind: 'plan' }>; toolStep: number } | null = null;
  let legacyPlan: { signal: Extract<AgyInteractionSignal, { kind: 'plan' }>; toolStep: number } | null = null;
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
      } else if (signal.kind === 'plan' && result?.type === 'GENERIC' && (result.status === 'DONE' || result.status === 'ERROR')) {
        legacyPlan = { signal, toolStep };
      }
    }
  }
  const plan = markedPlan ?? legacyPlan;
  let signal: AgyInteractionSignal;
  let sourceSteps: number[];
  if (questions.length > 0) {
    signal = { kind: 'questions', questions };
    sourceSteps = questionSteps;
  } else if (plan) {
    signal = plan.signal;
    sourceSteps = [plan.toolStep];
  } else {
    return null;
  }
  const revision = createHash('sha256').update(JSON.stringify({
    nativeId,
    userStep: user.step_index,
    finalStep: final.step_index,
    sourceSteps,
    signal,
  })).digest('hex');
  const key = nativeId.replaceAll('-', '');
  const callID = `nag_i_${key}_${user.step_index}_${revision}`;
  const messageID = `nag_a_${key}_${final.step_index}`;
  const kind = signal.kind === 'plan' ? 'antigravity-plan-exit' : undefined;
  const selection: AntigravityProposalSelection = { modelID: send.modelID, agent: send.agent };
  if (send.variant !== undefined) selection.variant = send.variant;
  const proposal: AntigravityProposal = {
    sessionId,
    directory,
    userStep: user.step_index,
    callID,
    revision,
    tool: { messageID, callID },
    questions: signal.questions,
    send: selection,
  };
  if (signal.kind === 'plan') {
    const planText = signal.plan.replace(/(?:^|\r?\n)[ \t]*<\/openchamber-plan-v1>[ \t\r\n]*$/, '');
    if (!planText.trim()) return null;
    proposal.kind = 'antigravity-plan-exit';
    proposal.plan = planText;
    proposal.questions = signal.questions.map((question) => ({ ...question, question: planText }));
  }
  const time = agyTime(final.created_at, completion?.time ?? send.sentAt);
  const metadata: JsonObject = { openchamberToolSource: 'native-interaction' };
  if (kind) metadata.nativeQuestionKind = kind;
  const partInput: JsonObject = kind ? { plan: proposal.plan } : { questions: proposal.questions };
  const part = buildToolPart({
    id: `${callID}_part`,
    sessionID: sessionId,
    messageID,
    callID,
    tool: kind ? 'plan_exit' : 'question',
    input: partInput,
    title: '',
    start: time,
    metadata,
    result: { status: 'completed', output: '', end: time },
  });
  return { proposal, part, messageID };
};

const validContext = (input: AgyInteractionProposalInput): boolean => {
  const parsed = contextSchema.safeParse(input);
  return parsed.success && parsed.data.sessionId === `nag_${parsed.data.nativeId}`
    && path.isAbsolute(parsed.data.readRoot) && path.isAbsolute(parsed.data.directory);
};

export const agyInteractionHistory = (input: AgyInteractionProposalInput): AgyInteractionHistoryResult => {
  const empty: AgyInteractionHistoryResult = { proposals: [], latest: null };
  if (!validContext(input)) return empty;
  const { entries, sends, bindings } = input;
  const proposals: AgyInteractionProposalEntry[] = [];
  let start = -1;
  let latest: AgyInteractionProposalEntry | null = null;
  for (let index = 0; index <= entries.length; index += 1) {
    const current = entries[index];
    if (current && current.type !== 'USER_INPUT') continue;
    if (start >= 0) {
      const result = segmentProposal({ ...input, entries: entries.slice(start, index), sends, bindings });
      if (result) proposals.push(result);
      if (index === entries.length) latest = result;
    }
    start = index;
  }
  return { proposals, latest };
};

export const agyInteractionProposal = (input: AgyInteractionProposalInput): AgyInteractionProposalEntry | null => {
  if (!validContext(input)) return null;
  const start = input.entries.findLastIndex((entry) => entry.type === 'USER_INPUT');
  if (start < 0) return null;
  return segmentProposal({ ...input, entries: input.entries.slice(start) });
};
