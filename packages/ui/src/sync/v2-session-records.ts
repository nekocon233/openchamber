import type { Message, Part, SessionMessage } from '@opencode-ai/sdk/v2/client';

export type LegacySessionRecord = {
  info: Message;
  parts: Part[];
};

const emptyTokens = () => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
});

const contentOutput = (content: Array<{ type: 'text'; text: string } | { type: 'file'; uri: string; mime: string; name?: string }>): string => (
  content.map((item) => item.type === 'text' ? item.text : `[${item.name ?? item.uri}]`).join('\n').trim()
);

const userRecord = (message: Extract<SessionMessage, { type: 'user' }>, sessionID: string): LegacySessionRecord => {
  const parts: Part[] = [];
  if (message.text.length > 0) {
    parts.push({
      id: `${message.id}:text`,
      sessionID,
      messageID: message.id,
      type: 'text',
      text: message.text,
    } as Part);
  }
  for (const [index, file] of (message.files ?? []).entries()) {
    parts.push({
      id: `${message.id}:file:${index}`,
      sessionID,
      messageID: message.id,
      type: 'file',
      mime: file.mime,
      url: file.uri,
      ...(file.name ? { filename: file.name } : {}),
    } as Part);
  }
  for (const [index, agent] of (message.agents ?? []).entries()) {
    parts.push({
      id: `${message.id}:agent:${index}`,
      sessionID,
      messageID: message.id,
      type: 'agent',
      name: agent.name,
    } as Part);
  }

  return {
    info: {
      id: message.id,
      sessionID,
      role: 'user',
      time: { created: message.time.created },
      agent: '',
      model: { providerID: '', modelID: '' },
    } as Message,
    parts,
  };
};

const toolPart = (
  tool: Extract<SessionMessage, { type: 'assistant' }>['content'][number] & { type: 'tool' },
  message: Extract<SessionMessage, { type: 'assistant' }>,
  sessionID: string,
): Part => {
  const base = {
    id: tool.id,
    sessionID,
    messageID: message.id,
    type: 'tool' as const,
    callID: tool.id,
    tool: tool.name,
    ...(tool.provider ? { metadata: { provider: tool.provider } } : {}),
  };

  if (tool.state.status === 'pending') {
    return {
      ...base,
      state: {
        status: 'pending',
        input: {},
        raw: tool.state.input,
      },
    } as Part;
  }

  if (tool.state.status === 'running') {
    return {
      ...base,
      state: {
        status: 'running',
        input: tool.state.input,
        metadata: {
          structured: tool.state.structured,
          content: tool.state.content,
        },
        time: { start: tool.time.ran ?? tool.time.created },
      },
    } as Part;
  }

  if (tool.state.status === 'completed') {
    const attachments = (tool.state.attachments ?? []).map((attachment, index) => ({
      id: `${tool.id}:attachment:${index}`,
      sessionID,
      messageID: message.id,
      type: 'file',
      mime: attachment.mime,
      url: attachment.uri,
      ...(attachment.name ? { filename: attachment.name } : {}),
    } as Part));
    return {
      ...base,
      state: {
        status: 'completed',
        input: tool.state.input,
        output: contentOutput(tool.state.content),
        title: tool.name,
        metadata: {
          structured: tool.state.structured,
          result: tool.state.result,
        },
        time: {
          start: tool.time.ran ?? tool.time.created,
          end: tool.time.completed ?? message.time.completed ?? tool.time.created,
        },
        ...(attachments.length > 0 ? { attachments } : {}),
      },
    } as Part;
  }

  return {
    ...base,
    state: {
      status: 'error',
      input: tool.state.input,
      error: tool.state.error.message,
      metadata: {
        structured: tool.state.structured,
        result: tool.state.result,
      },
      time: {
        start: tool.time.ran ?? tool.time.created,
        end: tool.time.completed ?? message.time.completed ?? tool.time.created,
      },
    },
  } as Part;
};

const assistantRecord = (
  message: Extract<SessionMessage, { type: 'assistant' }>,
  sessionID: string,
  directory: string,
  parentID: string,
): LegacySessionRecord => {
  const parts: Part[] = [];
  for (const item of message.content) {
    if (item.type === 'text') {
      parts.push({
        id: item.id,
        sessionID,
        messageID: message.id,
        type: 'text',
        text: item.text,
      } as Part);
      continue;
    }
    if (item.type === 'reasoning') {
      parts.push({
        id: item.id,
        sessionID,
        messageID: message.id,
        type: 'reasoning',
        text: item.text,
        time: {
          start: item.time?.created ?? message.time.created,
          ...(item.time?.completed ? { end: item.time.completed } : {}),
        },
        ...(item.providerMetadata ? { metadata: item.providerMetadata } : {}),
      } as Part);
      continue;
    }
    parts.push(toolPart(item, message, sessionID));
  }

  return {
    info: {
      id: message.id,
      sessionID,
      role: 'assistant',
      parentID,
      modelID: message.model.id,
      providerID: message.model.providerID,
      mode: message.agent,
      agent: message.agent,
      path: { cwd: directory, root: directory },
      cost: message.cost ?? 0,
      tokens: message.tokens ?? emptyTokens(),
      time: {
        created: message.time.created,
        ...(message.time.completed ? { completed: message.time.completed } : {}),
      },
      ...(message.model.variant ? { variant: message.model.variant } : {}),
      ...(message.finish ? { finish: message.finish } : {}),
      ...(message.error
        ? {
          error: {
            name: 'UnknownError',
            data: { message: message.error.message },
          },
        }
        : {}),
    } as Message,
    parts,
  };
};

export function convertSessionNextMessages(input: {
  messages: SessionMessage[];
  sessionID: string;
  directory: string;
}): LegacySessionRecord[] {
  const records: LegacySessionRecord[] = [];
  let lastUserMessageID = '';
  for (const message of input.messages) {
    if (message.type === 'user') {
      const record = userRecord(message, input.sessionID);
      records.push(record);
      lastUserMessageID = message.id;
      continue;
    }
    if (message.type === 'assistant') {
      records.push(assistantRecord(message, input.sessionID, input.directory, lastUserMessageID));
    }
  }
  return records;
}
