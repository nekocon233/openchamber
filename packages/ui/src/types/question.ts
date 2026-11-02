import type { NativePlanExecutionChoice } from '@/lib/api/types';

/** The native CLI question protocol; OpenCode uses forms. */
export interface QuestionOption {
  label: string;
  description: string;
}

export interface QuestionInfo {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
}

export interface QuestionRequest {
  id: string;
  sessionID: string;
  kind?: 'claude-plan-exit' | 'codex-plan-exit' | 'deepseek-plan-exit' | 'antigravity-plan-exit';
  canSelectExecutionModel?: boolean;
  executionPending?: NativePlanExecutionChoice;
  questions: QuestionInfo[];
  tool?: {
    messageID: string;
    callID: string;
  };
}
