// The step list a Codex turn maintains through `update_plan`.
//
// Codex marks the notification that carries it transient and non-durable — it
// reaches no rollout entry, no thread-history item and no RPC — so nothing can
// read it back after the fact. This owner therefore reports an observation of
// the current process and never claims more: a thread it has not heard from is
// `unknown`, not a thread without steps, and a thread whose process is gone is
// `inactive`. The steps it last saw stay under that state, because they are
// the only record that will ever exist.

import { randomUUID } from 'node:crypto';

// The status words the notification uses, mapped to the ones the UI knows.
const STEP_STATUS = { pending: 'pending', inProgress: 'in_progress', completed: 'completed' };

/**
 * @param {object} options
 * @param {(snapshot: object) => void} options.publish
 * @param {() => number} options.nextRevision a counter shared by a process's owners
 */
export const createCodexPlanTodos = ({ publish, nextRevision }) => {
  const generation = randomUUID();
  let observed = false;
  let closed = false;
  let todos = [];
  let snapshot = { state: 'unknown', generation, revision: nextRevision(), todos: [] };

  const stateOf = () => (closed ? 'inactive' : observed ? 'active' : 'unknown');
  // An equivalent observation does not publish again, and a revision a reader
  // already holds is never reissued.
  const published = (next) => JSON.stringify([snapshot.state, snapshot.generation, snapshot.todos])
    === JSON.stringify([next.state, next.generation, next.todos]);

  const commit = () => {
    const next = { state: stateOf(), generation, todos };
    if (published(next)) return snapshot;
    snapshot = { ...next, revision: nextRevision() };
    publish(structuredClone(snapshot));
    return snapshot;
  };

  return {
    snapshot: () => structuredClone(snapshot),
    generation: () => generation,
    /**
     * A turn reported its steps. Codex sends the whole list each time, so this
     * replaces what was held rather than merging into it.
     * @param {Array<{ step: string, status: string }>} plan
     */
    observe(plan) {
      if (closed) return snapshot;
      observed = true;
      todos = plan.map((entry, index) => ({
        id: String(index + 1),
        content: entry.step,
        status: STEP_STATUS[entry.status] ?? 'pending',
      }));
      return commit();
    },
    /**
     * The thread stopped being driven, so its steps are no longer current. A
     * thread that never reported steps has nothing to end: `unknown` already
     * says nothing was observed, and every thread unloads eventually.
     */
    close() {
      if (closed || !observed) return snapshot;
      closed = true;
      return commit();
    },
  };
};
