import { randomUUID } from 'node:crypto';

export type CodexPlanTodoStatus = 'pending' | 'in_progress' | 'completed';
export type CodexPlanTodosState = 'unknown' | 'active' | 'inactive';

export interface CodexPlanStep {
  step: string;
  status: string;
}

export type CodexPlanTodoItem = {
  id: string;
  content: string;
  status: CodexPlanTodoStatus;
};

export type CodexPlanTodosSnapshot = {
  state: CodexPlanTodosState;
  generation: string | null;
  revision: number;
  todos: CodexPlanTodoItem[];
};

export interface CodexPlanTodosOptions {
  publish: (snapshot: CodexPlanTodosSnapshot) => void;
  nextRevision: () => number;
}

const mapStepStatus = (status: string): CodexPlanTodoStatus => {
  if (status === 'inProgress') return 'in_progress';
  if (status === 'completed') return 'completed';
  return 'pending';
};

const stepKeys = (plan: readonly CodexPlanStep[]): string[] => {
  const seen = new Map<string, number>();
  return plan.map((entry) => {
    const occurrence = (seen.get(entry.step) ?? 0) + 1;
    seen.set(entry.step, occurrence);
    return JSON.stringify([entry.step, occurrence]);
  });
};

export const createCodexPlanTodos = ({ publish, nextRevision }: CodexPlanTodosOptions) => {
  const generation = randomUUID();
  let observed = false;
  let closed = false;
  let keys: string[] = [];
  const retired = new Set<string>();
  let todos: CodexPlanTodoItem[] = [];
  let snapshot: CodexPlanTodosSnapshot = { state: 'unknown', generation, revision: nextRevision(), todos: [] };

  const stateOf = (): CodexPlanTodosState => (closed ? 'inactive' : observed ? 'active' : 'unknown');
  const published = (next: { state: CodexPlanTodosState; generation: string; todos: CodexPlanTodoItem[] }) => (
    JSON.stringify([snapshot.state, snapshot.generation, snapshot.todos])
    === JSON.stringify([next.state, next.generation, next.todos])
  );

  const commit = (): CodexPlanTodosSnapshot => {
    const next = { state: stateOf(), generation, todos };
    if (published(next)) return snapshot;
    snapshot = { ...next, revision: nextRevision() };
    publish(structuredClone(snapshot));
    return snapshot;
  };

  const applyPlan = (next: readonly CodexPlanStep[]) => {
    const nextKeys = stepKeys(next);
    const previous = new Set(keys);
    const added = new Set(nextKeys.filter((key) => !previous.has(key)));
    const retiring = added.size > 0;
    nextKeys.forEach((key, index) => {
      const entry = next[index];
      if (!entry) return;
      if (entry.status !== 'completed') retired.delete(key);
      else if (retiring && !added.has(key)) retired.add(key);
    });
    const present = new Set(nextKeys);
    for (const key of retired) if (!present.has(key)) retired.delete(key);
    keys = nextKeys;
    todos = next.flatMap((entry, index) => {
      const key = nextKeys[index];
      if (key !== undefined && retired.has(key)) return [];
      return [{
        id: String(index + 1),
        content: entry.step,
        status: mapStepStatus(entry.status),
      }];
    });
  };

  return {
    snapshot: (): CodexPlanTodosSnapshot => structuredClone(snapshot),
    generation: (): string => generation,
    observe(next: readonly CodexPlanStep[]): CodexPlanTodosSnapshot {
      observed = true;
      closed = false;
      applyPlan(next);
      return commit();
    },
    close(): CodexPlanTodosSnapshot {
      if (closed || !observed) return snapshot;
      closed = true;
      return commit();
    },
  };
};

export type CodexPlanTodos = ReturnType<typeof createCodexPlanTodos>;
