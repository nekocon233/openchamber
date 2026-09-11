import { parse as parseJsonc } from 'jsonc-parser';
import { z } from 'zod';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { listProviderAuths } from '../opencode/auth.js';

const pluginEntrySchema = z.union([z.string(), z.tuple([z.string(), z.record(z.string(), z.json())])]);
const configSchema = z.object({
  plugin: z.array(pluginEntrySchema).optional(),
  provider: z.record(z.string(), z.json()).optional(),
  enabled_providers: z.array(z.string()).optional(),
}).catchall(z.json());
const inlineAuthProviderIDsSchema = z.record(z.string(), z.json()).transform((auth) => Object.keys(auth));
const providerIDSchema = z.string().min(1).max(256).regex(/^[a-z0-9][a-z0-9._-]*$/i);
const staticallyRegisteredProviderIDs = new Set(['anthropic', 'kimi-for-coding', 'openai']);
const unsupportedDynamicProviderIDs = new Set(['claude-code', 'cloudflare-ai-gateway', 'gitlab', 'sap-ai-core']);

const pluginSpecifier = (entry) => Array.isArray(entry) ? entry[0] : entry;

function pluginModuleURL(specifier) {
  try {
    const url = new URL(specifier);
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return specifier;
  }
}

function getDynamicProviderIDs(providerIDs) {
  const validProviderIDs = new Set();
  for (const providerID of providerIDs) {
    const parsed = providerIDSchema.safeParse(providerID);
    if (parsed.success) validProviderIDs.add(parsed.data);
  }
  if (validProviderIDs.has('copilot')) validProviderIDs.add('github-copilot');
  return Array.from(validProviderIDs)
    .filter((providerID) => {
      return !staticallyRegisteredProviderIDs.has(providerID)
        && !unsupportedDynamicProviderIDs.has(providerID);
    })
    .sort();
}

function authenticatedProviderIDs(env, readProviderIDs) {
  const inline = env.OPENCODE_AUTH_CONTENT?.trim();
  if (inline) {
    try {
      const providerIDs = inlineAuthProviderIDsSchema.safeParse(JSON.parse(inline));
      return providerIDs.success ? providerIDs.data : [];
    } catch {
      // OpenCode also falls back to auth.json when the inline value is malformed.
    }
  }
  try {
    const providerIDs = readProviderIDs();
    return Array.isArray(providerIDs) ? providerIDs : [];
  } catch {
    return [];
  }
}

export function prepareClaudeExecutionEnv(rawConfig, settingsPath, authenticatedIDs = []) {
  const errors = [];
  const parsed = rawConfig?.trim() ? parseJsonc(rawConfig, errors, { allowTrailingComma: true }) : {};
  if (errors.length) throw new Error('Invalid OpenCode config for Claude Code execution');
  const config = configSchema.parse(parsed);
  const pluginURL = process.env.OPENCHAMBER_CLAUDE_EXECUTION_PLUGIN
    ? pathToFileURL(process.env.OPENCHAMBER_CLAUDE_EXECUTION_PLUGIN).href
    : new URL('./plugin.js', import.meta.url).href;
  const providerPluginURL = new URL('./provider-plugin.js', pluginURL).href;
  const providerIDs = getDynamicProviderIDs([
    ...authenticatedIDs,
    ...Object.keys(config.provider ?? {}),
    ...(config.enabled_providers ?? []),
  ]);
  const managedPluginURLs = new Set([pluginURL, providerPluginURL]);
  const existingPlugins = (config.plugin ?? []).filter((entry) => {
    return !managedPluginURLs.has(pluginModuleURL(pluginSpecifier(entry)));
  });
  const providerPlugins = providerIDs.map((providerID) => {
    const instanceURL = new URL(providerPluginURL);
    instanceURL.searchParams.set('provider', providerID);
    return [instanceURL.href, { providerID }];
  });
  return {
    OPENCHAMBER_CLAUDE_EXECUTION_SETTINGS: settingsPath,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, plugin: [...existingPlugins, pluginURL, ...providerPlugins] }),
  };
}

const requestIdentity = z.object({ sessionID: z.string().min(1).max(256), messageID: z.string().min(1).max(256), directory: z.string().min(1).max(16384) });
const preparedRequest = requestIdentity.extend({ executionFramework: z.enum(['opencode', 'claude-code']) }).strict();
const requestKey = (request) => JSON.stringify([request.directory, request.sessionID, request.messageID]);

export function createClaudeExecutionRuntime({
  readSettings,
  getActivePort,
  settingsPath,
  isExternal,
  listAuthenticatedProviderIDs = listProviderAuths,
  env = process.env,
}) {
  let token = randomBytes(32).toString('hex');
  const pending = new Map();
  const internalPath = '/internal/claude-execution/decision';
  return {
    prepareEnv(rawConfig) {
      const port = getActivePort();
      if (!port) throw new Error('Claude execution requires the OpenChamber listener');
      const prepared = prepareClaudeExecutionEnv(
        rawConfig,
        settingsPath,
        authenticatedProviderIDs(env, listAuthenticatedProviderIDs),
      );
      token = randomBytes(32).toString('hex');
      pending.clear();
      return {
        ...prepared,
        OPENCHAMBER_CLAUDE_EXECUTION_URL: `http://127.0.0.1:${port}${internalPath}`,
        OPENCHAMBER_CLAUDE_EXECUTION_TOKEN: token,
      };
    },
    registerInternal(app, express) {
      app.post(internalPath, (req, res, next) => {
        const expected = Buffer.from(`Bearer ${token}`);
        const supplied = Buffer.from(req.get('authorization') ?? '');
        const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
        if (!local || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return res.sendStatus(401);
        next();
      }, express.json({ limit: '32kb' }), async (req, res) => {
        const parsed = requestIdentity.strict().safeParse(req.body);
        if (!parsed.success) return res.sendStatus(400);
        try {
          const key = requestKey(parsed.data);
          const prepared = pending.get(key);
          if (prepared) {
            pending.delete(key);
            if (prepared.expiresAt <= Date.now()) return res.status(409).json({ error: 'Prepared execution expired; submit the message again' });
            return res.json({ enabled: prepared.framework === 'claude-code' });
          }
          return res.json({ enabled: (await readSettings()).claudeCodeExecution === true });
        } catch {
          return res.status(503).json({ error: 'Execution settings are unavailable' });
        }
      });
    },
    registerPublic(app, express) {
      // Registered after the ordinary OpenChamber API authentication middleware.
      app.post('/api/claude-execution/requests', express.json({ limit: '32kb' }), async (req, res) => {
        if (isExternal()) return res.status(409).json({ error: 'Claude Code execution requires a managed OpenCode server' });
        const parsed = preparedRequest.safeParse(req.body);
        if (!parsed.success) return res.sendStatus(400);
        try { parsed.data.directory = await realpath(parsed.data.directory); }
        catch { return res.status(422).json({ error: 'The session directory is unavailable' }); }
        const now = Date.now();
        for (const [key, value] of pending) if (value.expiresAt <= now) pending.delete(key);
        const key = requestKey(parsed.data);
        const current = pending.get(key);
        if (current && current.framework !== parsed.data.executionFramework) return res.status(409).json({ error: 'This message already has an execution framework' });
        if (!current && pending.size >= 1024) return res.sendStatus(429);
        pending.set(key, { framework: parsed.data.executionFramework, expiresAt: now + 10 * 60_000 });
        return res.json({ prepared: true });
      });
    },
  };
}
