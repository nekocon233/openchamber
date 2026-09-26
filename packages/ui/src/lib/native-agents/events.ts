import { z } from 'zod';

import type { SyncEvent } from '@/lib/opencode/events';
import { isNativeSessionId } from './ids';
import { projectNativeQuestion } from './forms';
import {
  nativeMessageErrorSchema,
  nativeMessageSchema,
  nativePartSchema,
  nativeQuestionSchema,
  nativeSessionSchema,
  nativeSessionStatusSchema,
} from './schemas';

const sessionId = z.string().refine(isNativeSessionId);
const sessionIdentity = z.object({ sessionID: sessionId });
const questionIdentity = sessionIdentity.extend({ requestID: z.string().min(1) });

// Native CLI frames have their own protocol. Parse their complete payload
// before admitting records into the shared session state.
const nativeEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session.created'), properties: z.object({ info: nativeSessionSchema }) }),
  z.object({ type: z.literal('session.updated'), properties: z.object({ info: nativeSessionSchema }) }),
  z.object({ type: z.literal('session.deleted'), properties: sessionIdentity }),
  z.object({ type: z.literal('session.status'), properties: sessionIdentity.extend({ status: nativeSessionStatusSchema }) }),
  z.object({ type: z.literal('session.idle'), properties: sessionIdentity }),
  z.object({ type: z.literal('session.error'), properties: sessionIdentity.extend({ error: nativeMessageErrorSchema }) }),
  z.object({ type: z.literal('message.updated'), properties: z.object({ info: nativeMessageSchema }) }),
  z.object({ type: z.literal('message.part.updated'), properties: z.object({ part: nativePartSchema }) }),
  z.object({ type: z.literal('message.part.delta'), properties: sessionIdentity.extend({
    messageID: z.string().min(1), partID: z.string().min(1), field: z.enum(['text', 'raw']), delta: z.string(),
  }) }),
  z.object({ type: z.literal('question.asked'), properties: nativeQuestionSchema }),
  z.object({ type: z.literal('question.replied'), properties: questionIdentity }),
  z.object({ type: z.literal('question.rejected'), properties: questionIdentity }),
]);

export const translateNativeEvent = nativeEventSchema.transform((event): SyncEvent | null => {
  switch (event.type) {
    case 'session.updated': {
      const { id, ...session } = event.properties.info;
      return {
        type: 'session.patched',
        properties: { sessionID: id, patch: {
          ...session,
          revert: session.revert ?? null,
          time: { ...session.time, archived: session.time.archived ?? null },
        } },
      };
    }
    case 'message.part.updated':
      return { type: event.type, properties: { ...event.properties, sessionID: event.properties.part.sessionID } };
    case 'question.asked': {
      const form = projectNativeQuestion(event.properties);
      return form ? { type: 'form.created', properties: { form } } : null;
    }
    case 'question.replied':
    case 'question.rejected':
      return { type: 'form.settled', properties: { sessionID: event.properties.sessionID, formID: event.properties.requestID } };
    default:
      return event;
  }
}).catch(null).parse;
