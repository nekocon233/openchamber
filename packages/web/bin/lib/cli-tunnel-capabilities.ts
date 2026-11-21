import { cloudflareTunnelProviderCapabilities } from '../../server/lib/tunnels/providers/cloudflare.js';
import { frpcTunnelProviderCapabilities } from '../../server/lib/tunnels/providers/frpc.js';
import { ngrokTunnelProviderCapabilities } from '../../server/lib/tunnels/providers/ngrok.js';
import { tailscaleTunnelProviderCapabilities } from '../../server/lib/tunnels/providers/tailscale.js';

const DEFAULT_TUNNEL_PROVIDER_CAPABILITIES = [
  cloudflareTunnelProviderCapabilities,
  frpcTunnelProviderCapabilities,
  ngrokTunnelProviderCapabilities,
  tailscaleTunnelProviderCapabilities,
];

export { DEFAULT_TUNNEL_PROVIDER_CAPABILITIES };
