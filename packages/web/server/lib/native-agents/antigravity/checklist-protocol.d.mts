import type { JsonValue } from '../../shared/json-values.js';

export type AgyChecklistStatus = 'pending' | 'in_progress' | 'completed';

export interface AgyChecklistTodo {
  id: string;
  content: string;
  status: AgyChecklistStatus;
}

export interface AgyChecklistInput {
  todos: AgyChecklistTodo[];
}

export interface AgyChecklistToolDefinition {
  name: 'update_checklist';
  description: string;
  inputSchema: JsonValue;
}

export declare const AGY_CHECKLIST_MAX_BYTES: number;
export declare const AGY_CHECKLIST_SERVER: 'openchamber_checklist';
export declare const AGY_CHECKLIST_TOOL: 'update_checklist';
export declare const checklistTool: AgyChecklistToolDefinition;
export declare const parseChecklistInput: (value: JsonValue | undefined) => AgyChecklistInput | null;
export declare const checklistReceipt: (input: AgyChecklistInput) => string;
