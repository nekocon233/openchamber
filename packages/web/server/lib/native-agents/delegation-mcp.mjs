// Private stdio transport. Credentials stay in this child environment.
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const tool = { name: 'delegate', description: 'Delegate a task to the subagent CLI and model selected by the user. Returns the actual child result. Do not specify or change its model.',
  inputSchema: { type: 'object', properties: { task_id: { type: 'string', description: 'Unique task key within this turn. Keep the same key when retrying this task. Use different keys for intentionally independent copies.' }, prompt: { type: 'string' }, description: { type: 'string' } }, required: ['prompt'], additionalProperties: false } };
if (process.argv.includes('--deny-native')) {
  for await (const _chunk of process.stdin) { /* Hooks own the input; the process-scoped policy owns the decision. */ }
  send(process.env.OPENCHAMBER_DELEGATION_TOKEN ? { decision: 'deny', reason: 'Use the OpenChamber delegation tool for the selected subagent. Nested delegation is unavailable.' } : { decision: 'allow' });
} else createInterface({ input: process.stdin }).on('line', (line) => {
  void (async () => {
    let call;
    try {
      call = JSON.parse(line);
      if (call.id === undefined) return;
      let result;
      if (call.method === 'initialize') result = { protocolVersion: call.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'openchamber-subagents', version: '1' } };
      else if (call.method === 'ping') result = {};
      else if (call.method === 'tools/list') result = { tools: process.env.OPENCHAMBER_DELEGATION_TOKEN && process.env.OPENCHAMBER_DELEGATION_CHILD !== '1' ? [tool] : [] };
      else if (call.method === 'tools/call' && call.params.name === 'delegate') {
        // AGY can retain a prior MCP schema without task_id. Its exact task
        // payload is the retry identity until the caller supplies a key.
        const taskID = call.params.arguments.task_id ?? `legacy:${createHash('sha256').update(JSON.stringify(call.params.arguments)).digest('hex')}`;
        const response = await fetch(process.env.OPENCHAMBER_DELEGATION_URL, {
          method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENCHAMBER_DELEGATION_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...call.params.arguments, id: taskID }),
        });
        const answer = await response.json();
        result = { content: [{ type: 'text', text: JSON.stringify(answer) }], isError: !response.ok || Boolean(answer.error) };
      } else { send({ jsonrpc: '2.0', id: call.id, error: { code: -32601, message: 'Unknown subagent method' } }); return; }
      send({ jsonrpc: '2.0', id: call.id, result });
    } catch { if (call?.id !== undefined) send({ jsonrpc: '2.0', id: call.id, error: { code: -32603, message: 'Subagent transport failed. Open its task to inspect the outcome before retrying.' } }); }
  })();
});
