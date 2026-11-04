// Executable stdio entry. The host imports only the pure protocol module.
import { createInterface } from 'node:readline';
import { checklistTool, parseChecklistInput, checklistReceipt,
  AGY_CHECKLIST_MAX_BYTES, AGY_CHECKLIST_SERVER, AGY_CHECKLIST_TOOL } from './checklist-protocol.mjs';
const send = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
createInterface({ input: process.stdin }).on('line', (line) => {
  let call;
  try {
    call = JSON.parse(line);
    if (Buffer.byteLength(line) > AGY_CHECKLIST_MAX_BYTES + 4096) throw new Error('Request too large');
    if (call.id === undefined) return;
    const enabled = process.env.OPENCHAMBER_AGY_CHECKLIST === '1';
    if (call.method === 'initialize') send(call.id, { protocolVersion: call.params.protocolVersion,
      capabilities: { tools: {} }, serverInfo: { name: AGY_CHECKLIST_SERVER, version: '1' } });
    else if (call.method === 'ping') send(call.id, {});
    else if (call.method === 'tools/list') send(call.id, { tools: enabled ? [checklistTool] : [] });
    else if (call.method === 'tools/call' && enabled && call.params?.name === AGY_CHECKLIST_TOOL) {
      const input = parseChecklistInput(call.params.arguments);
      send(call.id, { content: [{ type: 'text', text: input ? checklistReceipt(input) : 'Invalid checklist. Supply unique ids, nonempty content and pending, in_progress or completed statuses within 256 KiB.' }], isError: input === null });
    } else send(call.id, { content: [{ type: 'text', text: 'Checklist tool is unavailable.' }], isError: true });
  } catch {
    if (call?.id !== undefined) send(call.id, { content: [{ type: 'text', text: 'Invalid checklist request.' }], isError: true });
  }
});
