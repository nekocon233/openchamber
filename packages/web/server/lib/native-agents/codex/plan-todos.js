// The step list a Codex turn maintains through `update_plan`.
//
// Codex marks the notification that carries it transient and non-durable — it
// reaches no rollout entry, no thread-history item and no RPC — so nothing can
// read them back after the fact. This owner therefore reports an observation of
// the current process and never claims more: a thread it has not heard from is
// `unknown`, not a thread without steps, and a thread whose process is gone is
// `inactive`. The steps it last saw stay under that state, because they are
// the only record that will ever exist.
//
// One thread's turn ends by unloading the thread, and the next turn resumes
// the same one, so an observation outlives the turn that started it: a thread
// that reports steps again is active again, within the same generation.
//
// Every report is the whole list, and a new plan is how a turn adds steps to
// it: a step the previous report did not have means the finished steps before
// it belong to work the user has moved past, so they stop being published.
// The raw report is kept either way, so nothing is ever guessed from an order
// or a position.

import { randomUUID } from 'node:crypto';

// The status words the notification uses, mapped to the ones the UI knows.
const STEP_STATUS = { pending: 'pending', inProgress: 'in_progress', completed: 'completed' };

// A step is named by its text, and a text the list repeats is told apart by
// which occurrence it is. Position is not identity: the same steps in another
// order are the same steps.
const stepKeys = (plan) => {
  const seen = new Map();
  return plan.map((entry) => {
    const occurrence = (seen.get(entry.step) ?? 0) + 1;
    seen.set(entry.step, occurrence);
    return JSON.stringify([entry.step, occurrence]);
  });
};

/**
 * @param {object} options
 * @param {(snapshot: object) => void} options.publish
 * @param {() => number} options.nextRevision a counter shared by a process's owners
 */
export const createCodexPlanTodos = ({ publish, nextRevision }) => {
  const generation = randomUUID();
  let observed = false;
  let closed = false;
  let keys = [];
  let retired = new Set();
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

  /**
   * The steps this plan still shows. A retired step comes back when the plan
   * runs it again, and one the plan no longer lists cannot stay retired.
   */
  const applyPlan = (next) => {
    const nextKeys = stepKeys(next);
    const previous = new Set(keys);
    const added = new Set(nextKeys.filter((key) => !previous.has(key)));
    // A report without a step the last one did not have states nothing new.
    const retiring = added.size > 0;
    nextKeys.forEach((key, index) => {
      if (next[index].status !== 'completed') retired.delete(key);
      else if (retiring && !added.has(key)) retired.add(key);
    });
    const present = new Set(nextKeys);
    for (const key of retired) if (!present.has(key)) retired.delete(key);
    keys = nextKeys;
    todos = next.flatMap((entry, index) => retired.has(nextKeys[index]) ? [] : [{
      id: String(index + 1),
      content: entry.step,
      status: STEP_STATUS[entry.status] ?? 'pending',
    }]);
  };

  return {
    snapshot: () => structuredClone(snapshot),
    generation: () => generation,
    /**
     * A turn reported its steps. Codex sends the whole list each time, so this
     * replaces what was held rather than merging into it.
     * @param {Array<{ step: string, status: string }>} next
     */
    observe(next) {
      // The app-server unloads a thread between turns, so a later turn of the
      // same thread reports into the same observation. Only a new owner starts
      // a new generation.
      observed = true;
      closed = false;
      applyPlan(next);
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
