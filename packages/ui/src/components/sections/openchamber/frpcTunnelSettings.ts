type FrpcStartEndpointInput =
  | {
    proxyType: 'tcp';
    serverAddress: string;
    serverPort: number;
    remotePort: number;
    publicUrl: string;
  }
  | {
    proxyType: 'http';
    serverAddress: string;
    serverPort: number;
    customDomain: string;
    publicHostname: string;
  };

export const normalizeFrpcHostname = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  try {
    const parsed = trimmed.includes('://') ? new URL(trimmed) : new URL(`https://${trimmed}`);
    return parsed.hostname.trim().toLowerCase();
  } catch {
    return '';
  }
};

export const normalizeFrpcPublicUrl = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  try {
    const parsed = new URL(trimmed);
    if (
      parsed.protocol !== 'https:'
      || parsed.username
      || parsed.password
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash
      || parsed.origin === 'null'
    ) {
      return '';
    }
    return parsed.origin;
  } catch {
    return '';
  }
};

export type FrpcStartEndpointPayload =
  | {
    proxyType: 'tcp';
    serverAddress: string;
    serverPort: number;
    remotePort: number;
    publicUrl: string;
  }
  | {
    proxyType: 'http';
    serverAddress: string;
    serverPort: number;
    customDomain: string;
    hostname: string;
  };

export const buildFrpcStartEndpointPayload = (input: FrpcStartEndpointInput): FrpcStartEndpointPayload => {
  if (input.proxyType === 'tcp') {
    return {
      proxyType: 'tcp',
      serverAddress: input.serverAddress,
      serverPort: input.serverPort,
      remotePort: input.remotePort,
      publicUrl: input.publicUrl,
    };
  }

  return {
    proxyType: 'http',
    serverAddress: input.serverAddress,
    serverPort: input.serverPort,
    customDomain: input.customDomain,
    hostname: input.publicHostname,
  };
};
