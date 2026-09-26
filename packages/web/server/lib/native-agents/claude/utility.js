// Small-model calls on the user's Claude Code. Each request is one query with
// every tool, setting file, CLAUDE.md and MCP server off. It writes no
// transcript, so it never appears among the sessions. Claude Code owns the
// login and its refresh.

import { execFile } from 'node:child_process';
import os from 'node:os';

import { z } from 'zod';

import { claudeLaunchModel, claudeModels } from '../catalog.js';

const REQUEST_TIMEOUT_MS = 60_000;
const AUTH_STATUS_TIMEOUT_MS = 10_000;
const STDERR_TAIL_CHARS = 2_000;
const UTILITY_INSTRUCTIONS = 'Generate only the requested text or JSON from the supplied input. This is a standalone text transformation.';

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

// `claude auth status` exits 1 when signed out and still prints its state.
const runClaude = (executable, args, env) => new Promise((resolve, reject) => {
  execFile(executable, args, { env, timeout: AUTH_STATUS_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
    if (error && !stdout) reject(error);
    else resolve(stdout);
  });
});

const answerText = (frame, structured) => {
  const success = successResult.safeParse(frame);
  if (!success.success) {
    const failure = failedResult.parse(frame);
    throw new Error(failure.errors.join('\n') || 'Claude Code stopped the utility query: ' + failure.subtype);
  }
  // An API failure, such as an expired login, ends as a success whose text is
  // the error.
  if (success.data.is_error) throw new Error(success.data.result || 'Claude Code could not answer the utility query');
  const output = success.data.structured_output;
  const text = structured ? (output === undefined ? '' : JSON.stringify(output)) : success.data.result.trim();
  if (!text) throw Object.assign(new Error('Claude Code returned no utility text'), { code: 'output-exhausted' });
  return text;
};

/**
 * @param {object} options
 * @param {() => Promise<import('@anthropic-ai/claude-agent-sdk')>} options.loadSdk
 * @param {() => Promise<string>} options.launchableExecutable path of the user's `claude`
 * @param {() => Record<string, string>} options.buildEnv
 * @param {(executable: string, args: string[], env: Record<string, string>) => Promise<string>} [options.runCli] what `claude <args>` printed
 * @param {string} [options.workDir] where every query runs
 */
export const createClaudeUtility = ({ loadSdk, launchableExecutable, buildEnv, runCli = runClaude, workDir = os.tmpdir() }) => {
  /** @type {Set<AbortController>} */
  const running = new Set();

  const available = async () => {
    const executable = await launchableExecutable();
    return authStatus.parse(JSON.parse(await runCli(executable, ['auth', 'status', '--json'], buildEnv()))).loggedIn;
  };

  const describe = async (modelID) => {
    const model = claudeModels().find((entry) => entry.id === modelID);
    if (!model) {
      throw Object.assign(new Error('The selected model is not available in Claude Code: ' + modelID), {
        statusCode: 404, code: 'claude-model-unavailable',
      });
    }
    return { ...model, hasLogin: await available(), effort: model.efforts.includes('low') ? 'low' : model.defaultEffort };
  };

  const runQuery = async ({ modelID, effort, prompt, system, maxOutputTokens, responseSchema, abortController }) => {
    const [sdk, executable] = await Promise.all([loadSdk(), launchableExecutable()]);
    abortController.signal.throwIfAborted();
    let stderrTail = '';
    const options = {
      // Claude Code shows the model its working directory and that
      // directory's git state; a neutral directory keeps the session's
      // project out of the prompt.
      cwd: workDir,
      pathToClaudeCodeExecutable: executable,
      env: buildEnv(),
      model: claudeLaunchModel(modelID),
      thinking: { type: 'disabled' },
      systemPrompt: [UTILITY_INSTRUCTIONS, system, maxOutputTokens ? 'Keep the answer within ' + maxOutputTokens + ' tokens.' : null]
        .filter(Boolean)
        .join('\n\n'),
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
      permissionMode: 'dontAsk',
      abortController,
      stderr: (data) => {
        stderrTail = (stderrTail + data).slice(-STDERR_TAIL_CHARS);
      },
    };
    if (effort) options.effort = effort;
    // Claude Code answers a schema with a tool call of its own, one extra
    // turn, so the query sets no turn limit.
    if (responseSchema) options.outputFormat = { type: 'json_schema', schema: responseSchema };
    let answer = null;
    for await (const frame of sdk.query({ prompt, options })) {
      if (frame.type === 'result') answer = frame;
    }
    if (answer === null) throw new Error(stderrTail.trim() || 'Claude Code exited before answering');
    return answerText(answer, Boolean(responseSchema));
  };

  const generate = async ({ modelID, effort, prompt, system, maxOutputTokens, responseSchema, timeoutMs, signal }) => {
    const deadline = AbortSignal.timeout(Number(timeoutMs) > 0 ? Number(timeoutMs) : REQUEST_TIMEOUT_MS);
    const abortSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    abortSignal.throwIfAborted();
    const abortController = new AbortController();
    const result = Promise.withResolvers();
    // The SDK takes about two seconds to stop Claude Code. The caller gets its
    // answer at once; the query ends in the background.
    const onAbort = () => {
      abortController.abort();
      result.reject(abortSignal.reason);
    };
    abortSignal.addEventListener('abort', onAbort, { once: true });
    running.add(abortController);
    runQuery({ modelID, effort, prompt, system, maxOutputTokens, responseSchema, abortController }).then(result.resolve, result.reject);
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
    /** Stops every running query. */
    shutdown() {
      for (const abortController of running) abortController.abort();
    },
  };
};
