import { z } from 'zod';

const claudeConnectionModelSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  modelID: z.string().trim().min(1).max(200),
  contextWindow: z.number().int().min(1024).max(10_000_000),
  outputLimit: z.number().int().min(1).max(1_000_000),
  input: z.object({ image: z.boolean(), pdf: z.boolean() }),
  efforts: z.array(z.enum(['low', 'medium', 'high', 'xhigh', 'max'])).max(5),
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


const chatgptAccountSchema = z.object({
  id: z.string().uuid(), kind: z.literal('chatgpt-plan'), label: z.string(),
  status: z.enum(['connected', 'signed-out', 'permission-required']),
  welcomed: z.boolean(), catalogUnavailable: z.boolean(),
});
export const chatgptAccountsSchema = z.object({ accounts: z.array(chatgptAccountSchema), localLogin: z.boolean() });
export const chatgptAuthorizationSchema = z.object({ attemptId: z.string().uuid(), url: z.string().url().refine((url) => {
  const parsed = new URL(url);
  return !parsed.username && !parsed.password && parsed.origin === 'https://auth.openai.com' && parsed.pathname === '/api/accounts/authorize';
}) });
export const chatgptAuthorizationStatusSchema = z.object({
  status: z.enum(['pending', 'exchanging', 'connected', 'permission-required', 'cancelled', 'expired', 'failed']),
  accountId: z.string().uuid().nullable(),
});
export const chatgptSignOutSchema = z.object({ signedOut: z.literal(true), revoked: z.boolean() });
export const chatgptCancelledSchema = z.object({ cancelled: z.boolean() });
export const chatgptWelcomeSchema = z.object({ acknowledged: z.literal(true) });
export type ChatgptAccount = z.infer<typeof chatgptAccountSchema>;
export type ChatgptAccounts = z.infer<typeof chatgptAccountsSchema>;
export type ChatgptAuthorization = z.infer<typeof chatgptAuthorizationSchema>;
export type ChatgptAuthorizationStatus = z.infer<typeof chatgptAuthorizationStatusSchema>;
export type ChatgptSignOut = z.infer<typeof chatgptSignOutSchema>;
