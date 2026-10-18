// Boundary parsers for the published DSH 0.2.0-rc.2 Web Remote protocol.
// DSH's extensible event data is JSON; each consumed event is parsed again by
// its owning projection before it can affect a shared UI record.
import { z } from 'zod';

export const jsonObject = z.record(z.string(), z.json());
export const rpcResponse = z.object({
  type: z.literal('server-response'), rpcId: z.string(),
  result: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), value: z.json().optional() }),
    z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }),
  ]),
});
export const streamMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('item'), streamId: z.string(), value: z.json() }),
  z.object({ type: z.literal('end'), streamId: z.string() }),
  z.object({ type: z.literal('error'), streamId: z.string(), error: z.object({ code: z.string(), message: z.string() }) }),
]);
export const remoteEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), clientId: z.string(), host: z.object({ home: z.string() }) }),
  z.object({ type: z.literal('emit'), event: z.string(), args: z.array(z.json()) }),
  z.object({ type: z.literal('waterfall'), event: z.string(), eventId: z.string(), agentId: z.string(), request: jsonObject }),
  z.object({ type: z.literal('cancel'), eventId: z.string() }),
]);
export const selection = z.object({ provider: z.string(), model: z.string(), reasoningEffort: z.string().optional() });
export const modelCatalog = z.object({
  default: selection,
  routableProviders: z.array(z.string()),
  groups: z.array(z.object({ id: z.string(), name: z.string(), models: z.array(z.object({
    id: z.string(), name: z.string(), reasoning: z.object({
      efforts: z.array(z.object({ id: z.string(), name: z.string() })), defaultEffort: z.string().optional(),
    }).optional(),
  })) })),
  failures: z.array(z.object({ id: z.string(), name: z.string(), message: z.string() })),
});
const projections = z.object({ asOfSeq: z.number().int(), values: jsonObject });
export const sessionSummary = z.object({
  agentAvailable: z.boolean(), sessionId: z.string().min(1), updatedAt: z.number(),
  running: z.boolean(), blank: z.boolean(), parentSessionId: z.string().optional(),
  origin: z.literal('subagent').optional(), cwd: z.string().optional(),
  projections: projections.extend({ kind: z.enum(['cached', 'sequenced']) }).optional(),
});
export const sessionList = z.object({ items: z.array(sessionSummary) });
export const sessionCreated = z.object({ sessionId: z.string().min(1) });
const sessionHeader = z.object({
  version: z.literal(4), id: z.string().min(1), createdAt: z.number(), cwd: z.string().optional(),
  parentSession: z.string().optional(), origin: z.literal('subagent').optional(),
});
export const sessionEvent = z.object({
  type: z.string(), seq: z.number().int().nonnegative(), time: z.number(), data: z.json(),
  surfaceOp: z.union([z.literal('append'), z.object({ op: z.literal('replace'), startSeq: z.number(), endSeq: z.number() })]).optional(),
});
const historyRecord = z.object({ type: z.literal('event'), event: sessionEvent });
const assistantFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start'), attemptId: z.string(), revision: z.number(), startedAfterSeq: z.number(), turn: z.number(), step: z.number() }),
  z.object({ type: z.literal('chunk'), attemptId: z.string(), revision: z.number(), index: z.number(), time: z.number(), chunk: z.json() }),
  z.object({ type: z.literal('end'), attemptId: z.string(), revision: z.number(), index: z.number(), outcome: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('committed'), eventType: z.enum(['assistant/message', 'assistant/attempt']), seq: z.number() }),
    z.object({ kind: z.literal('abandoned') }),
  ]) }),
]);
export const followFrame = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('snapshot'), header: sessionHeader, cursor: z.number().int(),
    records: z.array(historyRecord), hasMore: z.boolean(), projections,
    assistantStream: z.object({
      revision: z.number(), activeAttempt: z.object({
        attemptId: z.string(), startedAfterSeq: z.number(), turn: z.number(), step: z.number(),
        nextIndex: z.number(), stream: z.array(z.json()),
      }).optional(),
    }).optional(),
  }),
  historyRecord,
  z.object({ type: z.literal('assistant-stream'), frame: assistantFrame }),
]);
export const historyPage = z.object({ records: z.array(historyRecord), hasMore: z.boolean() });
export const workspaceFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('baseline'), value: z.object({ archivedSessionIds: z.array(z.string()) }) }),
  z.object({ type: z.literal('archived'), archivedSessionIds: z.array(z.string()) }),
  z.object({ type: z.enum(['upsert', 'remove', 'order', 'pinned']) }),
]);
export const commandList = z.array(z.object({ name: z.string(), description: z.string(), input: z.object({ hint: z.string() }).optional() }));
export const commandExecution = z.object({ commandId: z.string(), result: z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('success'), text: z.string().optional() }),
  z.object({ kind: z.literal('error'), text: z.string() }),
]) });
const questionItem = z.object({
  id: z.string(), question: z.string(), header: z.string().optional(), detail: z.string().optional(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional() })).optional(),
  multiSelect: z.boolean().optional(),
  intent: z.object({ kind: z.literal('plan-review'), approve: z.string(), callId: z.string().optional() }).optional(),
});
export const questionRequest = z.object({ questions: z.array(questionItem).min(1), callId: z.string().optional() });
export const pendingQuestions = z.array(z.object({ callId: z.string(), questions: z.array(questionItem), state: z.enum(['open', 'continued']) }));
export const accepted = z.object({ accepted: z.literal(true) });
export const fileReceipt = z.object({ receiptId: z.string().min(1) });
export const fileUploadResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: fileReceipt }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }),
]);

export const modelId = (provider, model) => `${encodeURIComponent(provider)}/${encodeURIComponent(model)}`;
export const modelRoute = (id) => {
  const pieces = id.split('/');
  if (pieces.length !== 2 || !pieces[0] || !pieces[1]) throw new Error('Invalid DeepSeek Harness model selection');
  return { provider: decodeURIComponent(pieces[0]), model: decodeURIComponent(pieces[1]) };
};
