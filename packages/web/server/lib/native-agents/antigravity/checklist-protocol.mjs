// Shared input and receipt contract for the host and stateless MCP helper.
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const AGY_CHECKLIST_MAX_BYTES = 256 * 1024;
const statuses = ['pending', 'in_progress', 'completed'];
const checklistInput = z.object({
  todos: z.array(z.object({
    id: z.string().max(128).refine((value) => value.trim().length > 0),
    content: z.string().refine((value) => value.trim().length > 0),
    status: z.enum(statuses),
  }).strict()).max(2000).refine((todos) => new Set(todos.map((todo) => todo.id)).size === todos.length),
}).strict();
export const AGY_CHECKLIST_SERVER = 'openchamber_checklist';
export const AGY_CHECKLIST_TOOL = 'update_checklist';
export const checklistTool = {
  name: AGY_CHECKLIST_TOOL,
  description: 'Replace this conversation\'s checklist with the complete current list. Keep stable task ids when updating status. Use an empty list to clear it. Maintain a checklist for multi-step work; mark steps completed only after verifying them.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['todos'], properties: {
    todos: { type: 'array', maxItems: 2000, items: { type: 'object', additionalProperties: false,
      required: ['id', 'content', 'status'], properties: { id: { type: 'string', minLength: 1, maxLength: 128 },
        content: { type: 'string', minLength: 1 }, status: { type: 'string', enum: statuses } },
    } },
  } },
};

const jsonText = z.string().transform((text, context) => {
  try { return JSON.parse(text); } catch {
    context.addIssue({ code: 'custom', message: 'Invalid JSON text' });
    return z.NEVER;
  }
});
// agy forwards `call_mcp_tool` arguments as the JSON text the model wrote when
// its tool declaration types them as a string.
const checklistArguments = z.union([checklistInput, jsonText.pipe(checklistInput)]);

/** The helper and host use the same validation and canonical input digest. */
export const parseChecklistInput = (value) => {
  const parsed = checklistArguments.safeParse(value);
  if (!parsed.success) return null;
  const input = { todos: parsed.data.todos.map(({ id, content, status }) => ({ id, content, status })) };
  return Buffer.byteLength(JSON.stringify(input)) <= AGY_CHECKLIST_MAX_BYTES ? input : null;
};

export const checklistReceipt = (input) => JSON.stringify({ openchamberChecklist: 1,
  digest: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
});

