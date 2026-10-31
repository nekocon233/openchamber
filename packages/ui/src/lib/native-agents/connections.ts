import { z } from 'zod';

const claudeConnectionModelSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  modelID: z.string().trim().min(1).max(200),
  contextWindow: z.number().int().min(1024).max(10_000_000),
  outputLimit: z.number().int().min(1).max(1_000_000),
  input: z.object({ image: z.boolean(), pdf: z.boolean() }),
  efforts: z.array(z.enum(['low', 'medium', 'high', 'xhigh', 'max'])).max(5),
  followFamily: z.enum(['antigravity-opus', 'antigravity-sonnet']).optional(),
});
export const claudeConnectionWriteSchema = z.object({
  kind: z.literal('anthropic').default('anthropic'),
  name: z.string().trim().min(1).max(120),
  baseURL: z.string().url().max(2048).refine((value) => {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  }),
  auth: z.enum(['api-key', 'bearer']),
  apiKey: z.string().trim().min(1).max(8192).optional(),
  models: z.array(claudeConnectionModelSchema).min(1).max(50)
    .refine((models) => new Set(models.map((model) => model.id)).size === models.length),
});
export const claudeConnectionSchema = claudeConnectionWriteSchema.omit({ apiKey: true }).extend({
  id: z.string().uuid(),
  revision: z.number().int().positive(),
  hasKey: z.boolean(),
  quotaProviderId: z.templateLiteral(['kimi-claude:', z.string().uuid()]).nullable().default(null),
});
export const claudeConnectionListSchema = z.array(claudeConnectionSchema);
export type ClaudeConnection = z.infer<typeof claudeConnectionSchema>;
export type ClaudeConnectionWrite = z.infer<typeof claudeConnectionWriteSchema>;
export type ClaudeConnectionModel = z.infer<typeof claudeConnectionModelSchema>;

// Codex advertises one more effort than Claude Code does.
const codexConnectionModelSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  modelID: z.string().trim().min(1).max(200),
  contextWindow: z.number().int().min(1024).max(10_000_000),
  outputLimit: z.number().int().min(1).max(1_000_000),
  input: z.object({ image: z.boolean(), pdf: z.boolean() }),
  efforts: z.array(z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])).max(6),
});
export const codexConnectionWriteSchema = z.object({
  kind: z.literal('openai-responses').default('openai-responses'),
  name: z.string().trim().min(1).max(120),
  baseURL: z.string().url().max(2048).refine((value) => {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  }),
  apiKey: z.string().trim().min(1).max(8192).optional(),
  models: z.array(codexConnectionModelSchema).min(1).max(50)
    .refine((models) => new Set(models.map((model) => model.id)).size === models.length),
});
export const codexConnectionSchema = codexConnectionWriteSchema.omit({ apiKey: true }).extend({
  id: z.string().uuid(),
  revision: z.number().int().positive(),
  hasKey: z.boolean(),
});
export const codexConnectionListSchema = z.array(codexConnectionSchema);
export type CodexConnection = z.infer<typeof codexConnectionSchema>;
export type CodexConnectionWrite = z.infer<typeof codexConnectionWriteSchema>;
export type CodexConnectionModel = z.infer<typeof codexConnectionModelSchema>;

// The local CLIProxyAPI gateway. OpenChamber manages its Codex and Antigravity accounts
// through the gateway's own management API and writes an ordinary Claude Code
// connection that points at it.
const cliproxyapiAccountSchema = z.object({
  name: z.string().min(1),
  email: z.string().nullable(),
  planType: z.string().nullable(),
  activeUntil: z.string().nullable(),
  status: z.string().nullable(),
  disabled: z.boolean(),
  provider: z.string().nullable().default(null),
});
const cliproxyapiInstallSchema = z.object({
  supported: z.boolean(),
  prepared: z.boolean(),
  target: z.string().nullable(),
  version: z.string(),
  path: z.string().nullable(),
  error: z.string().nullable(),
});
export const cliproxyapiStatusSchema = z.object({
  configured: z.boolean(),
  enabled: z.boolean(),
  running: z.boolean(),
  ready: z.boolean(),
  baseURL: z.string(),
  port: z.number().int(),
  authDir: z.string(),
  upstreamProxy: z.string().nullable(),
  installedVersion: z.string().nullable(),
  runningVersion: z.string().nullable(),
  install: cliproxyapiInstallSchema,
  managementEnabled: z.boolean(),
  keyRejected: z.boolean(),
  accounts: z.array(cliproxyapiAccountSchema),
  loginProviders: z.array(z.enum(['codex', 'antigravity', 'claude'])).default(['codex']),
  opusFailover: z.object({ enabled: z.boolean(), ready: z.boolean() }).default({ enabled: false, ready: false }),
  sonnetFailover: z.object({ enabled: z.boolean(), ready: z.boolean() }).optional(),
  /** Existing gateway keys as their length and last four characters, never their value. */
  clientKeys: z.array(z.object({ hint: z.string(), length: z.number().int().nonnegative() })),
  lastError: z.string().nullable(),
  restarting: z.boolean(),
  /** The Claude Code connection that points at this gateway, when one exists. */
  connection: z.object({ id: z.string().uuid(), name: z.string() }).nullable(),
});
const cliproxyapiModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  contextWindow: z.number().int().positive(),
  outputLimit: z.number().int().positive(),
  image: z.boolean(),
  efforts: z.array(z.string()),
});
export const cliproxyapiModelsSchema = z.object({
  models: z.array(cliproxyapiModelSchema),
  /** Models the gateway serves that this computer has no metadata for. */
  unknown: z.array(z.string()),
});
export const cliproxyapiImportResultSchema = z.object({
  connection: claudeConnectionSchema,
  imported: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});
export const cliproxyapiLoginSchema = z.object({ state: z.string().min(1), url: z.string().url() });
export const cliproxyapiLoginStatusSchema = z.object({
  status: z.enum(['pending', 'connected', 'failed']),
  message: z.string().nullable(),
});
export const cliproxyapiCancelResultSchema = z.object({ cancelled: z.boolean() });
export const cliproxyapiCallbackResultSchema = z.object({ accepted: z.literal(true) });
export const cliproxyapiRemovedSchema = z.object({ removed: z.literal(true) });
const cliproxyapiConnectionSchema = z.object({
  connectionId: z.string().uuid().nullable().default(null),
  name: z.string().trim().min(1).max(120),
  models: z.array(claudeConnectionModelSchema).min(1).max(50),
});
export type CliproxyapiStatus = z.infer<typeof cliproxyapiStatusSchema>;
export type CliproxyapiModels = z.infer<typeof cliproxyapiModelsSchema>;
export type CliproxyapiImportResult = z.infer<typeof cliproxyapiImportResultSchema>;
export type CliproxyapiLogin = z.infer<typeof cliproxyapiLoginSchema>;
export type CliproxyapiOAuthProvider = 'codex' | 'antigravity' | 'claude';
export type CliproxyapiLoginStatus = z.infer<typeof cliproxyapiLoginStatusSchema>;
export type CliproxyapiConnectionWrite = z.infer<typeof cliproxyapiConnectionSchema>;

