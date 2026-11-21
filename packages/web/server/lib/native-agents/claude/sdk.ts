export type ClaudeSdkModule = typeof import('@anthropic-ai/claude-agent-sdk');

let sdkModule: Promise<ClaudeSdkModule> | null = null;

export const loadClaudeSdk = (): Promise<ClaudeSdkModule> => {
  sdkModule ??= import('@anthropic-ai/claude-agent-sdk');
  return sdkModule;
};
