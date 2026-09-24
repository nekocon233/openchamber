// The Claude Agent SDK is large and only native Claude sessions need it, so
// it is imported on first use rather than when the server starts.

let sdkModule = null;

export const loadClaudeSdk = () => {
  sdkModule ??= import('@anthropic-ai/claude-agent-sdk');
  return sdkModule;
};
