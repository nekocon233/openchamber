import fs from 'fs';
import os from 'os';
import path from 'path';
import { readAuthFile } from '../opencode/auth.js';
import { readConfigLayers } from '../opencode/shared.js';
import { getModelCatalog } from './catalog.js';
import { resolveSmallModel, parseModelRef, isUsableAuthEntry, getAuthEntryForProvider } from './resolve.js';
import {
  DEDICATED_WIRE_FORMAT_PROVIDERS,
  callSmallModel,
  getProviderTransportKind,
  resolveProviderLogin,
} from './call.js';
import { readMergedSettingsSync } from '../opencode/settings-files.js';
import { getRuntimeProviderSnapshot, getRuntimeProviderTransportFromSnapshot } from './runtime-providers.js';
import { NATIVE_PROVIDER_CODEX } from '../native-agents/ids.js';

const EXPLICIT_MODEL_SOURCES = new Set(['settings', 'config', 'request']);

let codexRuntime = null;

export const configureCodexSmallModel = (runtime) => {
  codexRuntime = runtime;
};

const OPENCHAMBER_SETTINGS_FILE = path.join(
  process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber'),
  'settings.json',
);

// OpenChamber's own settings: when the user unchecks "use default small model"
// their explicit override outranks every other resolution step.
const readSmallModelSettingsOverride = () => {
  const settings = readMergedSettingsSync({ fs, path, settingsFilePath: OPENCHAMBER_SETTINGS_FILE });
  if (settings.smallModelUseDefault !== false) return null;
  const override = typeof settings.smallModelOverride === 'string' ? settings.smallModelOverride.trim() : '';
  return override || null;
};

// Rough safety clamp so a huge input never blows the model's context window.
// Token estimate is ~4 chars/token; when the catalog has no limit for the
// model (Copilot/codex utility models are not listed) a conservative default
// applies.
const DEFAULT_CONTEXT_TOKENS = 64_000;
const OUTPUT_RESERVE_TOKENS = 4_000;

/**
 * Input budget in characters, given how much of the context the caller intends
 * to leave for the answer. The reserve must match the output budget the caller
 * will actually request, or the two disagree and the model overruns its context.
 */
export const getModelInputCharBudget = ({ catalog, providerID, modelID, outputReserveTokens }) => {
  const limit = catalog?.[providerID]?.models?.[modelID]?.limit;
  const known = Number(limit?.context) > 0;
  const contextTokens = known ? Number(limit.context) : DEFAULT_CONTEXT_TOKENS;
  const reserve = Number(outputReserveTokens) > 0 ? Number(outputReserveTokens) : OUTPUT_RESERVE_TOKENS;
  const inputBudgetTokens = Math.max(1_000, contextTokens - reserve);
  return { maxChars: inputBudgetTokens * 4, contextTokens, contextKnown: known };
};

/**
 * The output budget to actually request: what the caller asked for, capped by
 * what the model admits it can emit. Asking for more than `limit.output` is
 * rejected outright by some providers and silently ignored by others.
 */
const resolveOutputTokens = ({ catalog, providerID, modelID, maxOutputTokens }) => {
  const requested = Number(maxOutputTokens) > 0 ? Number(maxOutputTokens) : 0;
  if (!requested) return undefined;
  const limit = Number(catalog?.[providerID]?.models?.[modelID]?.limit?.output);
  return limit > 0 ? Math.min(requested, limit) : requested;
};

// `truncate` keeps the historical behavior for callers whose prompt losing its
// tail is survivable (summaries, commit messages). `error` is for callers whose
// output would be quietly wrong on a clipped input — they need the failure.
const clampPromptToModelLimit = ({ prompt, system, catalog, providerID, modelID, onOverflow, outputReserveTokens }) => {
  const { maxChars } = getModelInputCharBudget({ catalog, providerID, modelID, outputReserveTokens });
  const systemChars = system?.length ?? 0;
  const requiredChars = prompt.length + systemChars;
  if (requiredChars <= maxChars) {
    return { prompt, truncated: false };
  }
  const promptCharBudget = maxChars - systemChars;
  if (onOverflow === 'error' || promptCharBudget <= 0) {
    throw Object.assign(
      new Error(`Input is too large for ${providerID}/${modelID}: ${requiredChars} characters exceeds the ${maxChars} the model's context allows`),
      { statusCode: 413, code: 'context-too-small', providerID, modelID, requiredChars, availableChars: maxChars },
    );
  }
  return { prompt: `${prompt.slice(0, Math.max(0, promptCharBudget - 1))}…`, truncated: true };
};

const readConfiguredSmallModel = (workingDirectory) => {
  try {
    const { mergedConfig } = readConfigLayers(workingDirectory);
    const value = mergedConfig?.small_model;
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
};

const resolveModelContext = async ({ model, directory, preferredProviderID, preferredModelID }) => {
  const settingsSmallModel = readSmallModelSettingsOverride();
  const configSmallModel = readConfiguredSmallModel(directory);
  const requested = parseModelRef(model);
  const configured = requested ? { ...requested, source: 'request' } : resolveSmallModel({
    auth: {}, catalog: {}, settingsSmallModel, configSmallModel,
  });
  if (configured?.providerID === NATIVE_PROVIDER_CODEX) {
    const runtime = codexRuntime;
    if (!runtime) {
      throw Object.assign(new Error('Codex utility runtime is unavailable'), {
        statusCode: 503, code: 'codex-runtime-unavailable',
      });
    }
    const nativeModel = await runtime.describe(configured.modelID);
    return {
      resolved: configured,
      nativeModel,
      runtime,
      auth: {},
      catalog: {
        [NATIVE_PROVIDER_CODEX]: {
          models: {
            [configured.modelID]: {
              limit: { context: nativeModel.contextWindow, output: nativeModel.outputLimit },
              structured_output: true,
            },
          },
        },
      },
    };
  }
  const auth = readAuthFile();
  const catalog = await getModelCatalog().catch(() => ({}));
  return {
    auth,
    catalog,
    resolved: configured ?? resolveSmallModel({
      auth, catalog, settingsSmallModel, configSmallModel, preferredProviderID, preferredModelID,
    }),
    nativeModel: null,
    runtime: null,
  };
};

/**
 * Generates text with the user's small model, resolved and authenticated
 * entirely server-side from the OpenCode config and auth store.
 */
export async function generateSmallModelText({ prompt, system, maxOutputTokens, model, directory, sessionID, preferredProviderID, preferredModelID, restrictToPreferredProvider, responseSchema, timeoutMs, signal, onOverflow = 'truncate' }) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw Object.assign(new Error('prompt is required'), { statusCode: 400 });
  }
  const normalizedPrompt = prompt.trim();
  const normalizedSystem = typeof system === 'string' && system.trim() ? system.trim() : undefined;

  const { auth, catalog, resolved, nativeModel, runtime } = await resolveModelContext({
    model, directory, preferredProviderID, preferredModelID,
  });

  if (!resolved) {
    throw Object.assign(
      new Error('No small model available — no authenticated provider has a suitable model'),
      { statusCode: 404 },
    );
  }

  // Callers with a session context can forbid silently switching providers:
  // an explicit user choice (settings override, opencode config, request
  // model) is always allowed. Otherwise, supplying a preferred provider opts
  // into same-provider resolution unless the caller explicitly passes false.
  if (preferredProviderID
    && restrictToPreferredProvider !== false
    && !EXPLICIT_MODEL_SOURCES.has(resolved.source)
    && resolved.providerID !== preferredProviderID) {
    throw Object.assign(
      new Error('No small model available within the session provider'),
      { statusCode: 404 },
    );
  }

  const outputTokens = resolveOutputTokens({
    catalog,
    providerID: resolved.providerID,
    modelID: resolved.modelID,
    maxOutputTokens,
  });

  const clamped = clampPromptToModelLimit({
    prompt: normalizedPrompt,
    system: normalizedSystem,
    catalog,
    providerID: resolved.providerID,
    modelID: resolved.modelID,
    onOverflow,
    outputReserveTokens: outputTokens,
  });

  if (nativeModel && !nativeModel.hasLogin) {
    throw Object.assign(new Error('Sign in to Codex before using its small model'), {
      statusCode: 401, code: 'no-provider-login',
    });
  }
  const generation = {
    auth,
    catalog,
    workingDirectory: directory,
    sessionID,
    providerID: resolved.providerID,
    modelID: resolved.modelID,
    prompt: clamped.prompt,
    system: normalizedSystem,
    maxOutputTokens: outputTokens,
    responseSchema,
    timeoutMs,
    signal,
  };
  const text = runtime
    ? await runtime.generate({ ...generation, directory, effort: nativeModel.effort })
    : await callSmallModel(generation);

  return {
    text: text.trim(),
    providerID: resolved.providerID,
    modelID: resolved.modelID,
    source: resolved.source,
    ...(clamped.truncated ? { inputTruncated: true } : {}),
  };
}

/**
 * Provider ids the small model can actually call — an auth.json login, or a
 * credential and endpoint the running OpenCode resolved for a plugin. Used by
 * the Small Model and Changes Walkthrough pickers to hide providers that would
 * only ever fail (e.g. opencode free models without a token).
 */
export async function listAuthenticatedProviders(directory) {
  const ids = new Set();
  try {
    const auth = readAuthFile();
    for (const providerID of Object.keys(auth || {})) {
      if (isUsableAuthEntry(auth[providerID])) ids.add(providerID);
    }
    // The catalog id is github-copilot while legacy auth entries may sit
    // under the copilot alias.
    if (isUsableAuthEntry(getAuthEntryForProvider(auth, 'github-copilot'))) {
      ids.add('github-copilot');
    }
    // Kept separate so a runtime lookup that goes wrong costs the providers it
    // would have added, never the logins already established from disk.
    try {
      for (const providerID of await listRuntimeCallableProviders(directory)) ids.add(providerID);
    } catch {
      // The auth.json set below stands on its own.
    }
  } catch {
    // Codex owns an independent login, so an OpenCode auth read cannot hide it.
  }
  try {
    if (await codexRuntime?.available()) ids.add(NATIVE_PROVIDER_CODEX);
  } catch {
    // A missing or disconnected CLI does not erase the other providers.
  }
  return Array.from(ids);
}

/**
 * Providers that only the running OpenCode knows about — plugin-registered
 * ones, and any whose endpoint is resolved at startup.
 *
 * The test is the same one applied to an auth.json login: a credential we may
 * use and somewhere to send it. Whether the endpoint answers the protocol we
 * speak is not knowable from any field OpenCode reports, and guessing it wrong
 * removes a working model from the picker with nothing to explain it.
 */
async function listRuntimeCallableProviders(directory) {
  const snapshot = await getRuntimeProviderSnapshot(directory);
  if (!snapshot) return [];
  const ids = [];
  for (const id of snapshot.connected) {
    // No credential or endpoint we may use, including the zen sentinel whose
    // free models belong to OpenCode's own server.
    if (!getRuntimeProviderTransportFromSnapshot(snapshot, id)) continue;
    // Reached through a dedicated wire format and already covered by the
    // auth.json scan above.
    if (DEDICATED_WIRE_FORMAT_PROVIDERS.has(id)) continue;
    ids.push(id);
  }
  return ids;
}

/**
 * Reports which model would be used, without calling it.
 *
 * `inputCharBudget` and `structuredOutput` let callers refuse work before
 * spending a request: the walkthrough needs both a big enough context and
 * schema-shaped output, and would rather tell the user to pick another model
 * than send a doomed prompt. `structuredOutput` is deliberately tri-state —
 * the catalog omits the field for roughly half of all models (aggregators and
 * proxies especially), and treating "unknown" as "unsupported" would hide
 * models that work fine.
 */
/**
 * The reserve, resolved against the model that was actually picked.
 *
 * A caller that wants "as much answer room as this model allows" cannot state a
 * number up front — it does not know which model it will get. Passing a
 * function lets it decide once the limits are known, and keeps the reserve and
 * the eventual request the same number by construction.
 */
const resolveReserveTokens = (outputReserveTokens, limits) => (
  typeof outputReserveTokens === 'function' ? outputReserveTokens(limits) : outputReserveTokens
);

export async function describeSmallModel({ directory, preferredProviderID, preferredModelID, outputReserveTokens, overrideModel } = {}) {
  // A caller with its own model setting (the diff walkthrough) outranks the
  // small-model chain entirely — it asked for this model on purpose.
  const { auth, catalog, resolved, nativeModel } = await resolveModelContext({
    model: overrideModel, directory, preferredProviderID, preferredModelID,
  });
  if (!resolved) return null;

  const entry = catalog?.[resolved.providerID]?.models?.[resolved.modelID];
  const outputTokenLimit = Number(entry?.limit?.output) > 0 ? Number(entry.limit.output) : null;
  // Two passes: the first only to learn the context, which a caller-supplied
  // reserve function needs before it can answer.
  const { contextTokens, contextKnown } = getModelInputCharBudget({
    catalog,
    providerID: resolved.providerID,
    modelID: resolved.modelID,
  });
  const requestedReserveTokens = resolveReserveTokens(outputReserveTokens, { contextTokens, outputTokenLimit });
  const reserveTokens = resolveOutputTokens({
    catalog,
    providerID: resolved.providerID,
    modelID: resolved.modelID,
    maxOutputTokens: requestedReserveTokens,
  });
  const { maxChars } = getModelInputCharBudget({
    catalog,
    providerID: resolved.providerID,
    modelID: resolved.modelID,
    outputReserveTokens: reserveTokens,
  });

  // Settings/config/request overrides can name a provider with no usable login.
  // Report that here so readiness can refuse before the user pays for a 401.
  const login = nativeModel ? null : await resolveProviderLogin({
    auth,
    workingDirectory: directory,
    providerID: resolved.providerID,
  });
  const hasLogin = nativeModel ? nativeModel.hasLogin : Boolean(login);
  const transport = nativeModel ? 'codex-app-server' : getProviderTransportKind({ providerID: resolved.providerID, login });

  return {
    ...resolved,
    hasLogin,
    inputCharBudget: maxChars,
    contextTokens,
    contextKnown,
    // What the caller should ask for, so the request and the reserve above
    // cannot drift apart.
    outputTokens: Number(reserveTokens) > 0 ? Number(reserveTokens) : null,
    structuredOutput: typeof entry?.structured_output === 'boolean' ? entry.structured_output : null,
    outputTokenLimit,
    transport,
  };
}
