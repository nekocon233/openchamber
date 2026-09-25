import { z } from 'zod';

export interface AuthMethod {
  type?: string;
  name?: string;
  label?: string;
  description?: string;
  help?: string;
  method?: number;
  /** Inputs an OAuth method wants answered before authorize; see `provider-oauth.ts`. */
  prompts?: unknown;
  [key: string]: unknown;
}

export interface OAuthAuthMethodEntry {
  method: AuthMethod;
  /** Index in the full provider auth-methods array (passed to oauth authorize/callback). */
  methodIndex: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export const normalizeAuthType = (method: AuthMethod): string => {
  const raw = typeof method.type === 'string' ? method.type : '';
  const label = `${method.name ?? ''} ${method.label ?? ''}`.toLowerCase();
  const merged = `${raw} ${label}`.toLowerCase();
  if (merged.includes('oauth')) return 'oauth';
  if (merged.includes('api')) return 'api';
  return raw.toLowerCase();
};

export const parseAuthPayload = (payload: unknown): Record<string, AuthMethod[]> => {
  if (!isRecord(payload)) {
    return {};
  }
  const result: Record<string, AuthMethod[]> = {};
  for (const [providerId, value] of Object.entries(payload)) {
    if (Array.isArray(value)) {
      result[providerId] = value.filter((entry) => isRecord(entry)) as AuthMethod[];
    }
  }
  return result;
};

/**
 * Show the API key form when the provider declares API auth, or when auth
 * methods are still unknown (empty). OAuth-only providers must not get an
 * API key prompt.
 */
export const shouldShowApiKeyAuth = (methods: AuthMethod[]): boolean => {
  if (methods.length === 0) {
    return true;
  }
  return methods.some((method) => normalizeAuthType(method) === 'api');
};

export const getOAuthAuthMethods = (methods: AuthMethod[]): OAuthAuthMethodEntry[] =>
  methods
    .map((method, methodIndex) => ({ method, methodIndex }))
    .filter(({ method }) => normalizeAuthType(method) === 'oauth');

export interface ProviderCredentialInput {
  /** Present when OpenCode reports an active credential (api/env/oauth). */
  key?: string | null;
  /** OpenChamber auth.json provenance for this provider. */
  authSourceExists?: boolean | null;
  /**
   * Provider.options is shipped to the client for config-defined providers
   * but never reaches `Provider.key` (upstream only sets `key` from a single
   * resolved env var or an api-type auth.json entry). Treat a non-empty
   * `options.apiKey` as a usable login, per
   * `packages/web/server/lib/walkthrough/DOCUMENTATION.md:134`.
   */
  optionsApiKey?: string | null;
  /**
   * The provider declares environment variables it reads credentials from.
   * Multi-variable providers (Bedrock, Azure, Vertex) never resolve a single
   * `Provider.key` upstream, so without this signal they read as
   * "Credentials missing" even when fully configured.
   */
  envDeclared?: boolean;
}

export type ProviderAuthSourceSnapshot = {
  exists: boolean;
  status?: 'connected' | 'disconnected' | 'unavailable';
  canDisconnect?: boolean;
  path?: string | null;
};

const providerSourceInfoSchema = z.object({
  exists: z.boolean(),
  path: z.string().nullable().optional(),
});

const providerSourcesSchema = z.object({
  auth: providerSourceInfoSchema.extend({
    status: z.enum(['connected', 'disconnected', 'unavailable']).optional(),
    canDisconnect: z.boolean().optional(),
  }),
  user: providerSourceInfoSchema,
  project: providerSourceInfoSchema,
  custom: providerSourceInfoSchema.optional(),
});

export type ProviderSourcesSnapshot = z.infer<typeof providerSourcesSchema>;
type ProviderSourcesInput = Parameters<typeof providerSourcesSchema.safeParse>[0];

export const parseProviderSourcesSnapshot = (
  value: ProviderSourcesInput,
): ProviderSourcesSnapshot | null => {
  const parsed = providerSourcesSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

export type ProviderSourceLoadStatus = 'loading' | 'loaded' | 'failed';

type ProviderAuthenticationState =
  | { status: 'loading'; hasCredentials: false; canDisconnect: false }
  | { status: 'connected'; hasCredentials: true; canDisconnect: boolean }
  | { status: 'disconnected'; hasCredentials: false; canDisconnect: boolean }
  | { status: 'unavailable'; hasCredentials: false; canDisconnect: false };

/**
 * Prefer authoritative credential signals. Declared env vars are the weakest of
 * them — the array holds variable *names*, not values — but for providers whose
 * credentials span several env vars it is the only signal OpenCode exposes.
 */
export const providerHasCredentials = (input: ProviderCredentialInput): boolean => {
  if (typeof input.key === 'string' && input.key.trim().length > 0) {
    return true;
  }
  if (typeof input.optionsApiKey === 'string' && input.optionsApiKey.trim().length > 0) {
    return true;
  }
  if (input.envDeclared === true) {
    return true;
  }
  return input.authSourceExists === true;
};

export const resolveProviderAuthenticationState = (input: {
  sourceLoadStatus: ProviderSourceLoadStatus;
  authSource?: ProviderAuthSourceSnapshot;
  credentials: ProviderCredentialInput;
}): ProviderAuthenticationState => {
  if (input.sourceLoadStatus === 'loading') {
    return { status: 'loading', hasCredentials: false, canDisconnect: false };
  }
  if (
    input.sourceLoadStatus === 'failed'
    || !input.authSource
    || input.authSource.status === 'unavailable'
  ) {
    return { status: 'unavailable', hasCredentials: false, canDisconnect: false };
  }

  const hasCredentials = providerHasCredentials({
    ...input.credentials,
    authSourceExists: input.authSource?.status === 'connected' || input.authSource?.exists === true,
  });
  const canDisconnect = input.authSource?.canDisconnect === true;
  if (hasCredentials) {
    return { status: 'connected', hasCredentials: true, canDisconnect };
  }
  return { status: 'disconnected', hasCredentials: false, canDisconnect };
};

type ProviderDisconnectResult = { success?: boolean; removed?: boolean } | null | undefined;

export const providerAuthWasRemoved = (payload: ProviderDisconnectResult): boolean =>
  payload?.removed === true;

export const shouldShowModelsSection = (input: {
  modelCount: number;
  sourcesLoaded: boolean;
  hasCredentials: boolean;
  /**
   * Config-defined custom providers (providerSources.custom present and parsed
   * via `isConfigDefinedCustomProvider`) are user-editable in place, so a
   * stale `Credentials missing` signal must not hide their models section.
   * Optional for back-compat; defaults to `false`, restoring the pre-rewrite
   * exemption that `requiresProviderAuth` carried via `providerAvailability.ts`.
   */
  isEditableCustomProvider?: boolean;
}): boolean =>
  input.modelCount > 0 &&
  (!input.sourcesLoaded || input.hasCredentials || Boolean(input.isEditableCustomProvider));

export const shouldAutoOpenAuthPanel = (input: {
  sourcesLoaded: boolean;
  hasCredentials: boolean;
  userDismissed: boolean;
  /**
   * Config-defined custom providers (providerSources.custom present and parsed
   * via `isConfigDefinedCustomProvider`) do not auto-open the auth panel: the
   * provider is editable directly in the form, and a stale `Credentials
   * missing` summary would be misleading. Optional for back-compat; defaults to
   * `false`, restoring the pre-rewrite exemption that `requiresProviderAuth`
   * carried via `providerAvailability.ts`.
   */
  isEditableCustomProvider?: boolean;
}): boolean =>
  input.sourcesLoaded &&
  !input.hasCredentials &&
  !input.userDismissed &&
  !input.isEditableCustomProvider;
