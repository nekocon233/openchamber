// Lossless answers to OpenChamber's own question UI. Question text and native
// tool calls remain in the CLI transcript; this store keeps only selections.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { decodeNativeSessionId } from './ids.js';
import { buildToolPart } from './records.js';
import { withMemoryFileLock } from '../agent-memory/file-lock.js';

const answer = z.object({
  id: z.string(), callID: z.string(), kind: z.enum(['claude-plan-exit', 'codex-plan-exit']).optional(),
  answers: z.array(z.array(z.string())), status: z.enum(['answered', 'dismissed', 'interrupted']), settledAt: z.number(),
});
const document = z.object({ version: z.literal(1), answers: z.array(answer) });
const missing = z.object({ code: z.literal('ENOENT') });

export const createNativeInteractions = ({ dataDir, now = Date.now }) => {
  const fileOf = (sessionId) => {
    if (!decodeNativeSessionId(sessionId)) throw new Error('Invalid native interaction owner');
    return path.join(dataDir, 'native-agents', 'interactions', `${sessionId}.json`);
  };
  const read = async (sessionId) => {
    try { return document.parse(JSON.parse(await fs.readFile(fileOf(sessionId), 'utf8'))).answers; }
    catch (error) { if (missing.safeParse(error).success) return []; throw error; }
  };
  const write = async (sessionId, answers) => {
    const file = fileOf(sessionId);
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, answers }), { mode: 0o600 });
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  };
  return {
    async record(request, outcome) {
      if (!request.tool) return;
      await withMemoryFileLock(fileOf(request.sessionID), async () => {
        const answers = await read(request.sessionID);
        const value = answer.parse({
          id: request.id, callID: request.tool.callID, kind: request.kind,
          answers: outcome.status === 'replied' ? outcome.answers : [],
          status: outcome.status === 'replied' ? 'answered' : outcome.reason ?? 'dismissed', settledAt: now(),
        });
        await write(request.sessionID, [...answers.filter((entry) => entry.id !== value.id), value]);
      });
    },
    async attach(sessionId, records) {
      const saved = await read(sessionId);
      if (!saved.length) return records;
      const byCall = new Map(saved.map((entry) => [entry.callID, entry]));
      return records.map((record) => {
        let changed = false;
        const parts = record.parts.flatMap((part) => {
          if (part.type !== 'tool') return [part];
          const value = byCall.get(part.callID);
          if (!value) return [part];
          changed = true;
          const metadata = { ...part.state.metadata, questionAnswers: value.answers, questionStatus: value.status };
          if (value.kind) {
            metadata.nativeQuestionKind = value.kind;
            metadata.nativePlanCallID = value.callID;
          }
          if (part.tool === 'question') return [{ ...part, state: { ...part.state, metadata } }];
          if (!value.kind) return [part];
          const plan = z.object({ plan: z.string().optional() }).safeParse(part.state.input).data?.plan ?? '';
          // The approval row is an OpenChamber UI interaction, not model tool
          // time. Stamp it with the plan tool's interval so turn telemetry
          // never subtracts an interaction that settled after the reply.
          const planStart = part.state.time?.start;
          const planEnd = part.state.time?.end;
          const fallback = record.info.time?.completed ?? record.info.time?.created ?? value.settledAt;
          const start = planStart ?? Math.min(value.settledAt, fallback);
          const end = planEnd ?? start;
          const id = `nci_${createHash('sha256').update(`${sessionId}:${value.id}`).digest('hex').slice(0, 32)}`;
          const question = buildToolPart({
            id, sessionID: sessionId, messageID: record.info.id, callID: value.id, tool: 'question',
            input: { questions: [{ question: plan, header: 'Plan', options: [{ label: 'build', description: '' }, { label: 'plan', description: '' }] }] },
            title: 'Plan', start, metadata,
            result: value.status === 'answered' ? { status: 'completed', output: '', end }
              : { status: 'error', error: value.status === 'interrupted' ? 'Interrupted' : 'Dismissed', end },
          });
          return [part, question];
        });
        return changed ? { ...record, parts } : record;
      });
    },
    async fork(sourceId, targetId, retainedCallIds) {
      const answers = (await read(sourceId)).filter((entry) => retainedCallIds.has(entry.callID));
      if (answers.length) await withMemoryFileLock(fileOf(targetId), () => write(targetId, answers));
    },
    async forget(sessionId) { await withMemoryFileLock(fileOf(sessionId), () => fs.rm(fileOf(sessionId), { force: true })); },
  };
};
