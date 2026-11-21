import { asNonEmptyString } from '../shared/guards.js';
import type { SessionPayload } from './routes.js';

export type GoalInput = { ok: true; enabled: boolean; tokenBudget: number | null } | { ok: false; error: string };

export const isSafeInteger = (value: unknown): value is number => Number.isSafeInteger(value);

export const splitModel = (value: string | null | undefined) => {
  const model = asNonEmptyString(value);
  if (!model) return null;
  const slashIndex = model.indexOf('/');
  if (slashIndex <= 0 || slashIndex === model.length - 1) return null;
  return {
    providerID: model.slice(0, slashIndex),
    modelID: model.slice(slashIndex + 1),
  };
};

export const resolveRequestedModel = (payload: SessionPayload) => {
  const model = splitModel(asNonEmptyString(payload?.model));
  if (model) return model;

  const providerID = asNonEmptyString(payload?.providerID);
  const modelID = asNonEmptyString(payload?.modelID);
  return providerID && modelID ? { providerID, modelID } : null;
};

export const FALLBACK_PROVIDER_ID = 'opencode';

export const FALLBACK_MODEL_ID = 'big-pickle';

const MIN_GOAL_TOKEN_BUDGET = 1_000;

const MAX_GOAL_TOKEN_BUDGET = 100_000_000;

export const resolveGoalInput = (payload: SessionPayload, prompt: string | null): GoalInput => {
  const enabled = payload?.goal === true;
  if (payload?.goalTokenBudget !== undefined && !enabled) {
    return { ok: false, error: 'goalTokenBudget requires goal' };
  }
  if (enabled && !prompt) {
    return { ok: false, error: 'prompt is required when goal is enabled' };
  }
  if (payload?.goalTokenBudget === undefined) {
    return { ok: true, enabled, tokenBudget: null };
  }
  const tokenBudget = payload.goalTokenBudget;
  if (!isSafeInteger(tokenBudget)
    || tokenBudget < MIN_GOAL_TOKEN_BUDGET
    || tokenBudget > MAX_GOAL_TOKEN_BUDGET) {
    return { ok: false, error: `goalTokenBudget must be an integer from ${MIN_GOAL_TOKEN_BUDGET} to ${MAX_GOAL_TOKEN_BUDGET}` };
  }
  return { ok: true, enabled, tokenBudget };
};
