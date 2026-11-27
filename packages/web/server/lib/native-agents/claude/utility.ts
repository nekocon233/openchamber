import { execFile } from 'node:child_process';
import os from 'node:os';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { isRecord } from '../../shared/object-guards.js';

import type { JsonObject, JsonValue } from '../../shared/json-values.js';
import { prepareClaudeConnection, redactClaudeConnectionError } from './connections.js';
import type { ClaudeConnectionCatalogModel, ClaudeConnections } from './connections.js';
import type { ClaudeSdkModule } from './sdk.js';
import { claudeLaunchModel, claudeModels } from '../catalog.js';

const REQUEST_TIMEOUT_MS = 60_000;
const AUTH_STATUS_TIMEOUT_MS = 10_000;
const STDERR_TAIL_CHARS = 2_000;
const UTILITY_INSTRUCTIONS = 'Generate only the requested text or JSON from the supplied input. This is a standalone text transformation.';

const effortLevelSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
const authStatus = z.object({ loggedIn: z.boolean() });
const successResult = z.object({
  subtype: z.literal('success'),
  is_error: z.boolean(),
  result: z.string(),
  structured_output: z.json().optional(),
});
const failedResult = z.object({
  subtype: z.string(),
  errors: z.array(z.string()).catch([]),
});

export type ClaudeUtilityModelDescription = ClaudeConnectionCatalogModel & {
  hasLogin: boolean;
  effort: string | null;
};

export interface ClaudeUtilityGenerateInput {
  modelID: string;
  effort?: string | null | undefined;
  variant?: string | undefined;
  prompt: string;
  system?: string | null | undefined;
  maxOutputTokens?: number | undefined;
  responseSchema?: JsonValue | undefined;
  timeoutMs?: unknown;
  signal?: AbortSignal | undefined;
}

export interface ClaudeUtilityOptions {
  loadSdk: () => Promise<ClaudeSdkModule>;
  launchableExecutable: () => Promise<string>;
  buildEnv: () => Record<string, string>;
  runCli?: ((executable: string, args: string[], env: Record<string, string>) => Promise<string>) | undefined;
  workDir?: string | undefined;
  connections?: Pick<ClaudeConnections, 'hasCredentials' | 'resolve'> | null | undefined;
}

export interface ClaudeUtility {
  available: () => Promise<boolean>;
  describe: (modelID: string) => Promise<ClaudeUtilityModelDescription>;
  generate: (input: ClaudeUtilityGenerateInput) => Promise<string>;
  shutdown: () => void;
}

const createDeferredString = () => {
  let resolve: (value: string) => void = () => {};
  let reject: (cause?: unknown) => void = () => {};
  const promise = new Promise<string>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

const runClaude = (executable: string, args: string[], env: Record<string, string>): Promise<string> => new Promise((resolve, reject) => {
  execFile(executable, args, { env, timeout: AUTH_STATUS_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
    if (error && !stdout) reject(error);
    else resolve(stdout);
  });
});

const answerText = (frame: SDKMessage, structured: boolean): string => {
  const success = successResult.safeParse(frame);
  if (!success.success) {
    const failure = failedResult.parse(frame);
    throw new Error(failure.errors.join('\n') || 'Claude Code stopped the utility query: ' + failure.subtype);
  }
  if (success.data.is_error) throw new Error(success.data.result || 'Claude Code could not answer the utility query');
  const output = success.data.structured_output;
  const text = structured ? (output === undefined ? '' : JSON.stringify(output)) : success.data.result.trim();
  if (!text) throw Object.assign(new Error('Claude Code returned no utility text'), { code: 'output-exhausted' });
  return text;
};

export const createClaudeUtility = ({
  loadSdk,
  launchableExecutable,
  buildEnv,
  runCli = runClaude,
  workDir = os.tmpdir(),
  connections,
}: ClaudeUtilityOptions): ClaudeUtility => {
  const running = new Set<AbortController>();

  const defaultLogin = async (): Promise<boolean> => {
    const executable = await launchableExecutable();
    return authStatus.parse(JSON.parse(await runCli(executable, ['auth', 'status', '--json'], buildEnv()))).loggedIn;
  };

  const available = async (): Promise<boolean> => {
    await launchableExecutable();
    return connections && await connections.hasCredentials() ? true : defaultLogin();
  };

  const describe = async (modelID: string): Promise<ClaudeUtilityModelDescription> => {
    const launch = connections ? await connections.resolve(modelID) : null;
    const model = launch?.descriptor ?? claudeModels().find((entry) => entry.id === modelID);
    if (!model) {
      throw Object.assign(new Error('The selected model is not available in Claude Code: ' + modelID), {
        statusCode: 404,
        code: 'claude-model-unavailable',
      });
    }
    const managed = Boolean(launch?.env || launch?.acquire);
    if (managed) await launchableExecutable();
    return {
      ...model,
      hasLogin: managed ? true : await defaultLogin(),
      effort: model.efforts.includes('low') ? 'low' : model.defaultEffort,
    };
  };

  const runQuery = async ({
    modelID,
    effort,
    variant,
    prompt,
    system,
    maxOutputTokens,
    responseSchema,
    abortController,
  }: {
    modelID: string;
    effort?: string | null | undefined;
    variant?: string | undefined;
    prompt: string;
    system?: string | null | undefined;
    maxOutputTokens?: number | undefined;
    responseSchema?: JsonObject | undefined;
    abortController: AbortController;
  }): Promise<string> => {
    const [sdk, executable] = await Promise.all([loadSdk(), launchableExecutable()]);
    abortController.signal.throwIfAborted();
    const launch = connections ? await connections.resolve(modelID, effort ?? null) : null;
    const connection = await prepareClaudeConnection(launch, buildEnv());
    let stderrTail = '';
    const options: Options = {
      cwd: workDir,
      pathToClaudeCodeExecutable: executable,
      env: connection.env,
      model: launch?.model ?? claudeLaunchModel(modelID),
      systemPrompt: [UTILITY_INSTRUCTIONS, system, maxOutputTokens ? 'Keep the answer within ' + maxOutputTokens + ' tokens.' : null]
        .filter(Boolean)
        .join('\n\n'),
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
      permissionMode: 'dontAsk',
      settings: connection.settings ?? { env: { ENABLE_TOOL_SEARCH: 'false' } },
      abortController,
      stderr: (data) => {
        stderrTail = (stderrTail + data).slice(-STDERR_TAIL_CHARS);
      },
    };
    if (!variant && !launch?.env && !launch?.acquire) options.thinking = { type: 'disabled' };
    const parsedEffort = effort ? effortLevelSchema.safeParse(effort) : null;
    if (parsedEffort?.success) options.effort = parsedEffort.data;
    if (responseSchema) options.outputFormat = { type: 'json_schema', schema: responseSchema };
    let answer: SDKMessage | null = null;
    try {
      for await (const frame of sdk.query({ prompt, options })) {
        if (frame.type === 'result') answer = frame;
      }
      if (answer === null) throw new Error(stderrTail.trim() || 'Claude Code exited before answering');
      return answerText(answer, Boolean(responseSchema));
    } catch (error) {
      if (launch?.env && error instanceof Error) error.message = redactClaudeConnectionError(error.message, launch);
      throw error;
    } finally {
      await connection.dispose();
    }
  };

  const generate = async ({
    modelID,
    effort,
    variant,
    prompt,
    system,
    maxOutputTokens,
    responseSchema,
    timeoutMs,
    signal,
  }: ClaudeUtilityGenerateInput): Promise<string> => {
  const outputSchema = isRecord(responseSchema)
      ? responseSchema
      : undefined;
    if (responseSchema && !outputSchema) {
      throw Object.assign(new Error('Claude output schema must be an object'), { statusCode: 400 });
    }
    const deadline = AbortSignal.timeout(Number(timeoutMs) > 0 ? Number(timeoutMs) : REQUEST_TIMEOUT_MS);
    const abortSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    abortSignal.throwIfAborted();
    const abortController = new AbortController();
    const result = createDeferredString();
    const onAbort = () => {
      abortController.abort();
      result.reject(abortSignal.reason);
    };
    abortSignal.addEventListener('abort', onAbort, { once: true });
    running.add(abortController);
    runQuery({ modelID, effort, variant, prompt, system, maxOutputTokens, responseSchema: outputSchema, abortController }).then(result.resolve, result.reject);
    try {
      return await result.promise;
    } finally {
      abortSignal.removeEventListener('abort', onAbort);
      running.delete(abortController);
    }
  };

  return {
    available,
    describe,
    generate,
    shutdown() {
      for (const abortController of running) abortController.abort();
    },
  };
};
