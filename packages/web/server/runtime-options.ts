import fs from 'node:fs';
import { isRecord, isString } from './lib/shared/object-guards.js';
import { createBootstrapRuntime } from './lib/server-frame/bootstrap-runtime.js';
import { createStartupPipelineRuntime } from './lib/server-frame/startup-pipeline-runtime.js';
import { createNotificationEmitterRuntime } from './lib/notifications/emitter-runtime.js';
import { createNotificationTriggerRuntime } from './lib/notifications/runtime.js';
import { attachRealtimeProxy } from './lib/realtime-proxy.js';

type StartupPipelineInput = Parameters<ReturnType<typeof createStartupPipelineRuntime>['run']>[0];

type BootstrapInput = Parameters<ReturnType<typeof createBootstrapRuntime>['setupBaseRoutes']>[1];

export interface WebUiServerOptions {
  port?: number | undefined;
  host?: string | undefined;
  uiPassword?: string | null | undefined;
  tryCfTunnel?: boolean | undefined;
  apiOnly?: boolean | undefined;
  tunnelMode?: string | undefined;
  tunnelProvider?: string | undefined;
  tunnelConfigPath?: string | null | undefined;
  tunnelToken?: string | undefined;
  tunnelHostname?: string | undefined;
  tunnelPublicUrl?: string | undefined;
  tunnelCustomDomain?: string | undefined;
  tunnelTrustedCaFile?: unknown;
  tunnelServerAddress?: string | undefined;
  tunnelServerPort?: number | undefined;
  tunnelRemotePort?: number | undefined;
  attachSignals?: boolean | undefined;
  exitOnShutdown?: boolean | undefined;
  onTunnelReady?: StartupPipelineInput['onTunnelReady'] | undefined;
  onDesktopNotification?: Parameters<ReturnType<typeof createNotificationEmitterRuntime>['setOnDesktopNotification']>[0] | undefined;
  getIsWindowFocused?: Parameters<ReturnType<typeof createNotificationTriggerRuntime>['setGetIsWindowFocused']>[0] | undefined;
  getDesktopRuntimeConfig?: Parameters<typeof attachRealtimeProxy>[0]['getDesktopRuntimeConfig'] | undefined;
  desktopUpdater?: BootstrapInput['desktopUpdater'] | undefined;
  builtInExtensionsDir?: string | undefined;
}

export function readRuntimeVersion(packagePath: string) {
  try {
    const raw = fs.readFileSync(packagePath, 'utf8');
    const pkg: unknown = JSON.parse(raw);
    if (isRecord(pkg) && isString(pkg.version) && pkg.version.trim().length > 0) {
      return pkg.version.trim();
    }
  } catch {
    return 'unknown';
  }
  return 'unknown';
}

export const isEnvFlagEnabled = (value: string | boolean | number | undefined) => {
  if (value === true || value === 1) return true;
  if (!isString(value)) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
};

const isEnvFlagDisabled = (value: string | boolean | number | undefined) => {
  if (value === false || value === 0) return true;
  if (!isString(value)) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '0' || normalized === 'false';
};

export const shouldSkipApiCompression = () => {
  if (isEnvFlagEnabled(process.env.OPENCHAMBER_SKIP_API_COMPRESSION)) return true;
  if (isEnvFlagEnabled(process.env.OPENCHAMBER_COMPRESS_API)) return false;
  if (isEnvFlagDisabled(process.env.OPENCHAMBER_COMPRESS_API)) return true;
  return process.env.OPENCHAMBER_RUNTIME === 'desktop';
};
