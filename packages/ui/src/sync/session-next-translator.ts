import type { Event, Message, ModelRef, Part, Prompt } from '@opencode-ai/sdk/v2/client';

type SessionNextPromptState = {
  messageID: string;
  prompt: Prompt;
  delivery: 'steer' | 'queue';
  timeCreated: number;
};

type SessionNextAssistantState = {
  messageID: string;
  parentID: string;
  agent: string;
  model: ModelRef | null;
  created: number;
  terminal: 'ended' | 'failed' | null;
};

type SessionNextStreamState = {
  kind: 'text' | 'reasoning';
  started: boolean;
  ended: boolean;
};

type SessionNextToolState = {
  name: string;
  rawInput: string;
  input: Record<string, unknown>;
  startedAt: number;
  terminal: 'success' | 'failed' | null;
};

type SessionNextContext = {
  seenEventIDs: Set<string>;
  seenEventOrder: string[];
  prompts: Map<string, SessionNextPromptState>;
  lastUserMessageID: string | null;
  assistants: Map<string, SessionNextAssistantState>;
  streams: Map<string, SessionNextStreamState>;
  tools: Map<string, SessionNextToolState>;
  switchedAgent: string | null;
  switchedModel: ModelRef | null;
};

export type SessionNextTranslator = {
  translate: (directory: string, payload: Event) => Event[] | null;
  clearSession: (directory: string, sessionID: string) => void;
  clear: () => void;
};

const MAX_SEEN_EVENT_IDS = 500;
const MAX_CONTEXT_ENTRIES = 100;

const emptyTokens = () => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
});

const createContext = (): SessionNextContext => ({
  seenEventIDs: new Set(),
  seenEventOrder: [],
  prompts: new Map(),
  lastUserMessageID: null,
  assistants: new Map(),
  streams: new Map(),
  tools: new Map(),
  switchedAgent: null,
  switchedModel: null,
});

const contextKeyFor = (directory: string, sessionID: string) => `${directory}\n${sessionID}`;

const rememberEvent = (context: SessionNextContext, eventID: string): boolean => {
  if (context.seenEventIDs.has(eventID)) return false;
  context.seenEventIDs.add(eventID);
  context.seenEventOrder.push(eventID);
  if (context.seenEventOrder.length > MAX_SEEN_EVENT_IDS) {
    const oldest = context.seenEventOrder.shift();
    if (oldest) context.seenEventIDs.delete(oldest);
  }
  return true;
};

const boundMap = <K, V>(map: Map<K, V>): void => {
  while (map.size > MAX_CONTEXT_ENTRIES) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
};

const legacyEvent = (id: string, type: Event['type'], properties: unknown): Event => ({
  id,
  type,
  properties,
} as Event);

const statusEvent = (payload: Event, sessionID: string, status: 'busy' | 'idle'): Event => legacyEvent(
  `${payload.id}:status:${status}`,
  'session.status',
  { sessionID, status: { type: status } },
);

const messageEvent = (payload: Event, suffix: string, info: Message): Event => legacyEvent(
  `${payload.id}:${suffix}`,
  'message.updated',
  { info },
);

const partEvent = (payload: Event, suffix: string, sessionID: string, part: Part): Event => legacyEvent(
  `${payload.id}:${suffix}`,
  'message.part.updated',
  { sessionID, part },
);

const deltaEvent = (payload: Event, input: {
  sessionID: string;
  messageID: string;
  partID: string;
  field: 'text' | 'raw';
  delta: string;
}): Event => legacyEvent(
  `${payload.id}:delta`,
  'message.part.delta',
  input,
);

const userMessage = (
  context: SessionNextContext,
  prompt: SessionNextPromptState,
): Message => ({
  id: prompt.messageID,
  sessionID: '',
  role: 'user',
  time: { created: prompt.timeCreated },
  agent: context.switchedAgent ?? '',
  model: {
    providerID: context.switchedModel?.providerID ?? '',
    modelID: context.switchedModel?.id ?? '',
    ...(context.switchedModel?.variant ? { variant: context.switchedModel.variant } : {}),
  },
} as Message & { sessionID: string });

const promptParts = (prompt: SessionNextPromptState, sessionID: string): Part[] => {
  const parts: Part[] = [];
  if (prompt.prompt.text.length > 0) {
    parts.push({
      id: `${prompt.messageID}:text`,
      sessionID,
      messageID: prompt.messageID,
      type: 'text',
      text: prompt.prompt.text,
    } as Part);
  }
  for (const [index, file] of (prompt.prompt.files ?? []).entries()) {
    parts.push({
      id: `${prompt.messageID}:file:${index}`,
      sessionID,
      messageID: prompt.messageID,
      type: 'file',
      mime: file.mime,
      url: file.uri,
      ...(file.name ? { filename: file.name } : {}),
    } as Part);
  }
  for (const [index, agent] of (prompt.prompt.agents ?? []).entries()) {
    parts.push({
      id: `${prompt.messageID}:agent:${index}`,
      sessionID,
      messageID: prompt.messageID,
      type: 'agent',
      name: agent.name,
    } as Part);
  }
  return parts;
};

const assistantMessage = (
  directory: string,
  context: SessionNextContext,
  state: SessionNextAssistantState,
  patch?: Partial<Message>,
): Message => ({
  id: state.messageID,
  sessionID: '',
  role: 'assistant',
  parentID: state.parentID,
  modelID: state.model?.id ?? '',
  providerID: state.model?.providerID ?? '',
  mode: state.agent,
  agent: state.agent,
  path: { cwd: directory, root: directory },
  cost: 0,
  tokens: emptyTokens(),
  time: { created: state.created },
  ...(state.model?.variant ? { variant: state.model.variant } : {}),
  ...(patch ?? {}),
} as Message & { sessionID: string });

const contentOutput = (content: Array<{ type: 'text'; text: string } | { type: 'file'; uri: string; mime: string; name?: string }>): string => (
  content.map((item) => item.type === 'text' ? item.text : `[${item.name ?? item.uri}]`).join('\n').trim()
);

const contentAttachments = (
  sessionID: string,
  assistantMessageID: string,
  callID: string,
  content: Array<{ type: 'text'; text: string } | { type: 'file'; uri: string; mime: string; name?: string }>,
): Part[] => content.flatMap((item, index) => item.type === 'file'
  ? [{
    id: `${callID}:attachment:${index}`,
    sessionID,
    messageID: assistantMessageID,
    type: 'file',
    mime: item.mime,
    url: item.uri,
    ...(item.name ? { filename: item.name } : {}),
  } as Part]
  : []);

export function createSessionNextTranslator(): SessionNextTranslator {
  const contexts = new Map<string, SessionNextContext>();

  const contextFor = (directory: string, sessionID: string): SessionNextContext => {
    const key = contextKeyFor(directory, sessionID);
    const existing = contexts.get(key);
    if (existing) return existing;
    const created = createContext();
    contexts.set(key, created);
    return created;
  };

  const translate = (directory: string, payload: Event): Event[] | null => {
    if (!payload.type.startsWith('session.next.')) return null;
    const properties = (payload as { properties?: unknown }).properties;
    if (!properties || typeof properties !== 'object') return [];
    const props = properties as Record<string, unknown>;
    const sessionID = typeof props.sessionID === 'string' ? props.sessionID : null;
    if (!sessionID) return [];
    const context = contextFor(directory, sessionID);
    if (typeof payload.id === 'string' && payload.id.length > 0 && !rememberEvent(context, payload.id)) {
      return [];
    }

    const events: Event[] = [];
    const pushUserPrompt = (prompt: SessionNextPromptState) => {
      const info = {
        ...userMessage(context, prompt),
        sessionID,
      } as Message;
      events.push(messageEvent(payload, 'user', info));
      for (const part of promptParts(prompt, sessionID)) {
        events.push(partEvent(payload, `user-part:${part.id}`, sessionID, part));
      }
    };

    switch (payload.type) {
      case 'session.next.agent.switched': {
        if (typeof props.agent === 'string') context.switchedAgent = props.agent;
        return events;
      }

      case 'session.next.model.switched': {
        context.switchedModel = props.model && typeof props.model === 'object'
          ? props.model as ModelRef
          : null;
        return events;
      }

      case 'session.next.prompt.admitted': {
        const messageID = typeof props.messageID === 'string' ? props.messageID : null;
        const prompt = props.prompt && typeof props.prompt === 'object' ? props.prompt as Prompt : null;
        if (!messageID || !prompt) return events;
        const state: SessionNextPromptState = {
          messageID,
          prompt,
          delivery: props.delivery === 'steer' ? 'steer' : 'queue',
          timeCreated: typeof props.timestamp === 'number' ? props.timestamp : Date.now(),
        };
        context.prompts.set(messageID, state);
        boundMap(context.prompts);
        context.lastUserMessageID = messageID;
        return events;
      }

      case 'session.next.prompted': {
        const messageID = typeof props.messageID === 'string' ? props.messageID : null;
        const prompt = props.prompt && typeof props.prompt === 'object' ? props.prompt as Prompt : null;
        if (!messageID || !prompt) return events;
        const state: SessionNextPromptState = {
          messageID,
          prompt,
          delivery: props.delivery === 'steer' ? 'steer' : 'queue',
          timeCreated: typeof props.timestamp === 'number' ? props.timestamp : Date.now(),
        };
        context.prompts.set(messageID, state);
        boundMap(context.prompts);
        context.lastUserMessageID = messageID;
        pushUserPrompt(state);
        return events;
      }

      case 'session.next.step.started': {
        const assistantMessageID = typeof props.assistantMessageID === 'string' ? props.assistantMessageID : null;
        if (!assistantMessageID) return events;
        const model = props.model && typeof props.model === 'object' ? props.model as ModelRef : context.switchedModel;
        const state: SessionNextAssistantState = {
          messageID: assistantMessageID,
          parentID: context.lastUserMessageID ?? '',
          agent: typeof props.agent === 'string' ? props.agent : context.switchedAgent ?? '',
          model,
          created: typeof props.timestamp === 'number' ? props.timestamp : Date.now(),
          terminal: null,
        };
        context.assistants.set(assistantMessageID, state);
        boundMap(context.assistants);
        const info = {
          ...assistantMessage(directory, context, state),
          sessionID,
        } as Message;
        events.push(messageEvent(payload, 'assistant', info));
        events.push(statusEvent(payload, sessionID, 'busy'));
        return events;
      }

      case 'session.next.step.ended':
      case 'session.next.step.failed': {
        const assistantMessageID = typeof props.assistantMessageID === 'string' ? props.assistantMessageID : null;
        const existing = assistantMessageID ? context.assistants.get(assistantMessageID) : undefined;
        if (!assistantMessageID || !existing || existing.terminal) return events;
        existing.terminal = payload.type === 'session.next.step.ended' ? 'ended' : 'failed';
        const timestamp = typeof props.timestamp === 'number' ? props.timestamp : Date.now();
        const patch = payload.type === 'session.next.step.ended'
          ? {
            time: { created: existing.created, completed: timestamp },
            finish: typeof props.finish === 'string' ? props.finish : undefined,
            cost: typeof props.cost === 'number' ? props.cost : 0,
            tokens: props.tokens && typeof props.tokens === 'object' ? props.tokens : emptyTokens(),
          }
          : {
            time: { created: existing.created, completed: timestamp },
            finish: 'error',
            error: {
              name: 'UnknownError',
              data: {
                message: props.error && typeof props.error === 'object' && typeof (props.error as { message?: unknown }).message === 'string'
                  ? (props.error as { message: string }).message
                  : 'Provider turn failed',
              },
            },
          };
        const info = {
          ...assistantMessage(directory, context, existing, patch as Partial<Message>),
          sessionID,
        } as Message;
        events.push(messageEvent(payload, 'assistant-final', info));
        return events;
      }

      case 'session.next.text.started':
      case 'session.next.reasoning.started': {
        const assistantMessageID = typeof props.assistantMessageID === 'string' ? props.assistantMessageID : null;
        const streamID = typeof props.textID === 'string'
          ? props.textID
          : typeof props.reasoningID === 'string'
            ? props.reasoningID
            : null;
        if (!assistantMessageID || !streamID) return events;
        const kind = payload.type === 'session.next.text.started' ? 'text' : 'reasoning';
        context.streams.set(streamID, { kind, started: true, ended: false });
        boundMap(context.streams);
        const timestamp = typeof props.timestamp === 'number' ? props.timestamp : Date.now();
        const part = kind === 'text'
          ? {
            id: streamID,
            sessionID,
            messageID: assistantMessageID,
            type: 'text',
            text: '',
          } as Part
          : {
            id: streamID,
            sessionID,
            messageID: assistantMessageID,
            type: 'reasoning',
            text: '',
            time: { start: timestamp },
            ...(props.providerMetadata && typeof props.providerMetadata === 'object'
              ? { metadata: props.providerMetadata as Record<string, unknown> }
              : {}),
          } as Part;
        events.push(partEvent(payload, `${kind}-started`, sessionID, part));
        return events;
      }

      case 'session.next.text.delta':
      case 'session.next.reasoning.delta': {
        const assistantMessageID = typeof props.assistantMessageID === 'string' ? props.assistantMessageID : null;
        const streamID = typeof props.textID === 'string'
          ? props.textID
          : typeof props.reasoningID === 'string'
            ? props.reasoningID
            : null;
        const delta = typeof props.delta === 'string' ? props.delta : null;
        if (!assistantMessageID || !streamID || delta === null) return events;
        const stream = context.streams.get(streamID);
        if (stream?.ended) return events;
        events.push(deltaEvent(payload, {
          sessionID,
          messageID: assistantMessageID,
          partID: streamID,
          field: 'text',
          delta,
        }));
        return events;
      }

      case 'session.next.text.ended':
      case 'session.next.reasoning.ended': {
        const assistantMessageID = typeof props.assistantMessageID === 'string' ? props.assistantMessageID : null;
        const streamID = typeof props.textID === 'string'
          ? props.textID
          : typeof props.reasoningID === 'string'
            ? props.reasoningID
            : null;
        const text = typeof props.text === 'string' ? props.text : null;
        if (!assistantMessageID || !streamID || text === null) return events;
        const existing = context.streams.get(streamID);
        if (existing?.ended) return events;
        const kind = existing?.kind ?? (payload.type === 'session.next.text.ended' ? 'text' : 'reasoning');
        context.streams.set(streamID, { kind, started: true, ended: true });
        const timestamp = typeof props.timestamp === 'number' ? props.timestamp : Date.now();
        const part = kind === 'text'
          ? {
            id: streamID,
            sessionID,
            messageID: assistantMessageID,
            type: 'text',
            text,
          } as Part
          : {
            id: streamID,
            sessionID,
            messageID: assistantMessageID,
            type: 'reasoning',
            text,
            time: { start: timestamp, end: timestamp },
            ...(props.providerMetadata && typeof props.providerMetadata === 'object'
              ? { metadata: props.providerMetadata as Record<string, unknown> }
              : {}),
          } as Part;
        events.push(partEvent(payload, `${kind}-ended`, sessionID, part));
        return events;
      }

      case 'session.next.tool.input.started': {
        const assistantMessageID = typeof props.assistantMessageID === 'string' ? props.assistantMessageID : null;
        const callID = typeof props.callID === 'string' ? props.callID : null;
        const name = typeof props.name === 'string' ? props.name : null;
        if (!assistantMessageID || !callID || !name) return events;
        const timestamp = typeof props.timestamp === 'number' ? props.timestamp : Date.now();
        context.tools.set(callID, {
          name,
          rawInput: '',
          input: {},
          startedAt: timestamp,
          terminal: null,
        });
        boundMap(context.tools);
        const part = {
          id: callID,
          sessionID,
          messageID: assistantMessageID,
          type: 'tool',
          callID,
          tool: name,
          state: { status: 'pending', input: {}, raw: '' },
        } as Part;
        events.push(partEvent(payload, 'tool-started', sessionID, part));
        return events;
      }

      case 'session.next.tool.input.delta': {
        const callID = typeof props.callID === 'string' ? props.callID : null;
        const delta = typeof props.delta === 'string' ? props.delta : null;
        const tool = callID ? context.tools.get(callID) : undefined;
        if (!callID || delta === null || !tool || tool.terminal) return events;
        tool.rawInput += delta;
        return events;
      }

      case 'session.next.tool.input.ended': {
        const assistantMessageID = typeof props.assistantMessageID === 'string' ? props.assistantMessageID : null;
        const callID = typeof props.callID === 'string' ? props.callID : null;
        const text = typeof props.text === 'string' ? props.text : null;
        const tool = callID ? context.tools.get(callID) : undefined;
        if (!assistantMessageID || !callID || text === null || !tool || tool.terminal) return events;
        tool.rawInput = text;
        const part = {
          id: callID,
          sessionID,
          messageID: assistantMessageID,
          type: 'tool',
          callID,
          tool: tool.name,
          state: { status: 'pending', input: tool.input, raw: tool.rawInput },
        } as Part;
        events.push(partEvent(payload, 'tool-input-ended', sessionID, part));
        return events;
      }

      case 'session.next.tool.called': {
        const assistantMessageID = typeof props.assistantMessageID === 'string' ? props.assistantMessageID : null;
        const callID = typeof props.callID === 'string' ? props.callID : null;
        const name = typeof props.tool === 'string' ? props.tool : null;
        if (!assistantMessageID || !callID || !name) return events;
        const timestamp = typeof props.timestamp === 'number' ? props.timestamp : Date.now();
        const input = props.input && typeof props.input === 'object' && !Array.isArray(props.input)
          ? props.input as Record<string, unknown>
          : {};
        const existing = context.tools.get(callID);
        const tool: SessionNextToolState = {
          name,
          rawInput: existing?.rawInput ?? '',
          input,
          startedAt: existing?.startedAt ?? timestamp,
          terminal: null,
        };
        context.tools.set(callID, tool);
        boundMap(context.tools);
        const part = {
          id: callID,
          sessionID,
          messageID: assistantMessageID,
          type: 'tool',
          callID,
          tool: name,
          state: { status: 'running', input, time: { start: tool.startedAt } },
        } as Part;
        events.push(partEvent(payload, 'tool-called', sessionID, part));
        return events;
      }

      case 'session.next.tool.progress': {
        const assistantMessageID = typeof props.assistantMessageID === 'string' ? props.assistantMessageID : null;
        const callID = typeof props.callID === 'string' ? props.callID : null;
        const tool = callID ? context.tools.get(callID) : undefined;
        if (!assistantMessageID || !callID || !tool || tool.terminal) return events;
        const part = {
          id: callID,
          sessionID,
          messageID: assistantMessageID,
          type: 'tool',
          callID,
          tool: tool.name,
          state: {
            status: 'running',
            input: tool.input,
            metadata: {
              structured: props.structured,
              content: props.content,
            },
            time: { start: tool.startedAt },
          },
        } as Part;
        events.push(partEvent(payload, 'tool-progress', sessionID, part));
        return events;
      }

      case 'session.next.tool.success':
      case 'session.next.tool.failed': {
        const assistantMessageID = typeof props.assistantMessageID === 'string' ? props.assistantMessageID : null;
        const callID = typeof props.callID === 'string' ? props.callID : null;
        const tool = callID ? context.tools.get(callID) : undefined;
        if (!assistantMessageID || !callID || !tool || tool.terminal) return events;
        const timestamp = typeof props.timestamp === 'number' ? props.timestamp : Date.now();
        const success = payload.type === 'session.next.tool.success';
        tool.terminal = success ? 'success' : 'failed';
        const content = Array.isArray(props.content) ? props.content as Array<{ type: 'text'; text: string } | { type: 'file'; uri: string; mime: string; name?: string }> : [];
        const error = props.error && typeof props.error === 'object' && typeof (props.error as { message?: unknown }).message === 'string'
          ? (props.error as { message: string }).message
          : 'Tool execution failed';
        const part = {
          id: callID,
          sessionID,
          messageID: assistantMessageID,
          type: 'tool',
          callID,
          tool: tool.name,
          state: success
            ? {
              status: 'completed',
              input: tool.input,
              output: contentOutput(content),
              title: tool.name,
              metadata: {
                structured: props.structured,
                result: props.result,
                provider: props.provider,
              },
              time: { start: tool.startedAt, end: timestamp },
              ...(contentAttachments(sessionID, assistantMessageID, callID, content).length > 0
                ? { attachments: contentAttachments(sessionID, assistantMessageID, callID, content) }
                : {}),
            }
            : {
              status: 'error',
              input: tool.input,
              error,
              metadata: {
                result: props.result,
                provider: props.provider,
              },
              time: { start: tool.startedAt, end: timestamp },
            },
        } as Part;
        events.push(partEvent(payload, success ? 'tool-success' : 'tool-failed', sessionID, part));
        return events;
      }

      default:
        return null;
    }
  };

  return {
    translate,
    clearSession(directory, sessionID) {
      contexts.delete(contextKeyFor(directory, sessionID));
    },
    clear() {
      contexts.clear();
    },
  };
}
