import type { TunnelCapabilities, TunnelStartRequest } from './types.js';

export interface TunnelController {
  provider?: string;
  mode?: string;
  httpsPort?: number | undefined;
  stop: () => void | boolean | Promise<void | boolean>;
  getPublicUrl?: () => string | null;
  getEffectiveConfigPath?: () => string | null;
  getResolvedHostname?: () => string | null;
}

export interface TunnelProviderMetadata {
  configPath?: string | null;
  resolvedHostname?: string | null;
  serverAddress?: string | null;
  serverPort?: number | null;
  proxyType?: 'tcp' | 'http' | null;
  remotePort?: number | null;
  customDomain?: string | null;
  hostname?: string | null;
  publicUrl?: string | null;
}

export interface TunnelAvailability {
  available: boolean;
  managed?: boolean;
  prepared?: boolean;
  path?: string | null;
  target?: string | null;
  version?: string | null;
  dependency?: string;
  installCommand?: string;
  installUrl?: string;
  platform?: NodeJS.Platform;
  message?: string | null;
}

export interface TunnelStartContext {
  activePort: number | null;
  originUrl: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface TunnelDoctorRequest {
  mode: string | null | undefined;
  hostname: string | undefined;
  token: string;
  tokenProvided: boolean;
  hostnameProvided: boolean;
  configPath: string | null | undefined;
  hasSavedManagedRemoteProfile: boolean;
  serverAddress?: unknown;
  serverPort?: unknown;
  proxyType?: unknown;
  remotePort?: unknown;
  customDomain?: unknown;
  publicUrl?: unknown;
}

export interface TunnelDoctorCheck {
  id: string;
  label: string;
  status: string;
  detail: string | null | undefined;
}

export interface TunnelDoctorMode {
  mode: string;
  checks: TunnelDoctorCheck[];
  summary: { ready: boolean; failures: number; warnings: number };
  ready: boolean;
  blockers: (string | null | undefined)[];
}

export interface TunnelProvider {
  id: string;
  capabilities: TunnelCapabilities;
  checkAvailability: () => Promise<TunnelAvailability>;
  start: (request: TunnelStartRequest, context: TunnelStartContext) => Promise<TunnelController>;
  stop: (controller: TunnelController) => void | boolean | Promise<void | boolean>;
  resolvePublicUrl: (controller: TunnelController | null) => string | null;
  canReuse?: (controller: TunnelController, request: TunnelStartRequest) => boolean;
  getMetadata?: (controller: TunnelController | null) => TunnelProviderMetadata | null;
  diagnose?: (request: TunnelDoctorRequest, context: { capabilities: TunnelCapabilities }) => Promise<{
    providerChecks: TunnelDoctorCheck[];
    modes: TunnelDoctorMode[];
  }>;
}
