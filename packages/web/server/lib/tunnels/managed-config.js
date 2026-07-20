export const createManagedTunnelConfigRuntime = (deps) => {
  const {
    fsPromises,
    path,
    crypto,
    normalizeManagedRemoteTunnelHostname,
    normalizeManagedRemoteTunnelPresets,
    normalizeFrpcServerAddress,
    normalizeFrpcServerPort,
    normalizeFrpcTrustedCaFile,
    normalizeFrpcRemotePort,
    normalizeFrpcCustomDomain,
    normalizeFrpcPublicHostname,
    normalizeFrpcPublicUrl,
    normalizeFrpcToken,
    constants,
  } = deps;

  const {
    CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH,
    CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH,
    CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
    FRPC_MANAGED_TUNNEL_FILE_PATH,
    FRPC_MANAGED_TUNNEL_VERSION,
  } = constants;

  let persistManagedRemoteTunnelConfigLock = Promise.resolve();
  let persistFrpcTunnelConfigLock = Promise.resolve();

  const sanitizeManagedRemoteTunnelConfigEntries = (value) => {
    if (!Array.isArray(value)) {
      return [];
    }

    const result = [];
    const seenIds = new Set();
    const seenHostnames = new Set();
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }

      const id = typeof entry.id === 'string' ? entry.id.trim() : '';
      const name = typeof entry.name === 'string' ? entry.name.trim() : '';
      const hostname = normalizeManagedRemoteTunnelHostname(entry.hostname);
      const token = typeof entry.token === 'string' ? entry.token.trim() : '';
      const updatedAt = Number.isFinite(entry.updatedAt) ? entry.updatedAt : Date.now();

      if (!id || !name || !hostname || !token) {
        continue;
      }
      if (seenIds.has(id) || seenHostnames.has(hostname)) {
        continue;
      }

      seenIds.add(id);
      seenHostnames.add(hostname);
      result.push({ id, name, hostname, token, updatedAt });
    }

    return result;
  };

  const writeManagedRemoteTunnelConfigToDisk = async (data) => {
    await fsPromises.mkdir(path.dirname(CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH), { recursive: true });
    await fsPromises.writeFile(CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  };

  const migrateManagedRemoteTunnelConfigFromLegacyFile = async () => {
    try {
      const legacyRaw = await fsPromises.readFile(CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH, 'utf8');
      const parsed = JSON.parse(legacyRaw);
      const tunnels = sanitizeManagedRemoteTunnelConfigEntries(parsed?.tunnels);
      const migrated = {
        version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
        tunnels,
      };
      await writeManagedRemoteTunnelConfigToDisk(migrated);
      return migrated;
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        return { version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION, tunnels: [] };
      }
      console.warn('Failed to migrate legacy named tunnel config file:', error);
      return { version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION, tunnels: [] };
    }
  };

  const readManagedRemoteTunnelConfigFromDisk = async () => {
    try {
      const raw = await fsPromises.readFile(CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') {
        return { version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION, tunnels: [] };
      }

      return {
        version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
        tunnels: sanitizeManagedRemoteTunnelConfigEntries(parsed.tunnels),
      };
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        return migrateManagedRemoteTunnelConfigFromLegacyFile();
      }
      console.warn('Failed to read managed remote tunnel config file:', error);
      return { version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION, tunnels: [] };
    }
  };

  const updateManagedRemoteTunnelConfig = async (mutate) => {
    persistManagedRemoteTunnelConfigLock = persistManagedRemoteTunnelConfigLock.then(async () => {
      const current = await readManagedRemoteTunnelConfigFromDisk();
      const next = mutate({
        version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
        tunnels: sanitizeManagedRemoteTunnelConfigEntries(current.tunnels),
      });

      await writeManagedRemoteTunnelConfigToDisk({
        version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
        tunnels: sanitizeManagedRemoteTunnelConfigEntries(next?.tunnels),
      });
    });

    return persistManagedRemoteTunnelConfigLock;
  };

  const syncManagedRemoteTunnelConfigWithPresets = async (presets) => {
    const sanitizedPresets = normalizeManagedRemoteTunnelPresets(presets) || [];

    await updateManagedRemoteTunnelConfig((current) => {
      const byId = new Map(current.tunnels.map((entry) => [entry.id, entry]));
      const byHostname = new Map(current.tunnels.map((entry) => [entry.hostname, entry]));

      const nextTunnels = [];
      for (const preset of sanitizedPresets) {
        const existing = byId.get(preset.id) || byHostname.get(preset.hostname) || null;
        if (!existing) {
          continue;
        }

        nextTunnels.push({
          ...existing,
          id: preset.id,
          name: preset.name,
          hostname: preset.hostname,
        });
      }

      return {
        version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
        tunnels: nextTunnels,
      };
    });
  };

  const upsertManagedRemoteTunnelToken = async ({ id, name, hostname, token }) => {
    if (typeof id !== 'string' || typeof name !== 'string' || typeof hostname !== 'string' || typeof token !== 'string') {
      return;
    }
    const normalizedId = id.trim();
    const normalizedName = name.trim();
    const normalizedHostname = normalizeManagedRemoteTunnelHostname(hostname);
    const normalizedToken = token.trim();
    if (!normalizedId || !normalizedName || !normalizedHostname || !normalizedToken) {
      return;
    }

    await updateManagedRemoteTunnelConfig((current) => {
      const withoutConflicts = current.tunnels.filter((entry) => entry.id !== normalizedId && entry.hostname !== normalizedHostname);
      withoutConflicts.push({
        id: normalizedId,
        name: normalizedName,
        hostname: normalizedHostname,
        token: normalizedToken,
        updatedAt: Date.now(),
      });

      return {
        version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
        tunnels: withoutConflicts,
      };
    });
  };

  const resolveManagedRemoteTunnelToken = async ({ presetId, hostname }) => {
    const normalizedPresetId = typeof presetId === 'string' ? presetId.trim() : '';
    const normalizedHostname = normalizeManagedRemoteTunnelHostname(hostname);
    const config = await readManagedRemoteTunnelConfigFromDisk();

    if (normalizedPresetId) {
      const byId = config.tunnels.find((entry) => entry.id === normalizedPresetId);
      if (byId?.token) {
        return byId.token;
      }
    }

    if (normalizedHostname) {
      const byHostname = config.tunnels.find((entry) => entry.hostname === normalizedHostname);
      if (byHostname?.token) {
        return byHostname.token;
      }
    }

    return '';
  };

  const sanitizeFrpcTunnelConfig = (value) => {
    if (!value || typeof value !== 'object') {
      throw new Error('FRPC tunnel config has an unsupported format');
    }

    if (value.version === 1) {
      throw new Error('FRPC version-1 tunnel config does not define a trusted CA file');
    }

    if (value.version !== FRPC_MANAGED_TUNNEL_VERSION) {
      throw new Error('FRPC tunnel config has an unsupported format');
    }

    const common = {
      version: FRPC_MANAGED_TUNNEL_VERSION,
      serverAddress: normalizeFrpcServerAddress(value.serverAddress),
      serverPort: normalizeFrpcServerPort(value.serverPort),
      trustedCaFile: normalizeFrpcTrustedCaFile(value.trustedCaFile),
      token: normalizeFrpcToken(value.token),
      updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : Date.now(),
    };

    const proxyType = typeof value.proxyType === 'string' ? value.proxyType.trim().toLowerCase() : '';
    if (proxyType === 'tcp') {
      if (
        (value.customDomain !== undefined && value.customDomain !== null)
        || (value.hostname !== undefined && value.hostname !== null)
      ) {
        throw new Error('FRPC TCP tunnel config contains HTTP endpoint fields');
      }
      return {
        ...common,
        proxyType,
        remotePort: normalizeFrpcRemotePort(value.remotePort),
        publicUrl: normalizeFrpcPublicUrl(value.publicUrl),
      };
    }
    if (proxyType === 'http') {
      if (
        (value.remotePort !== undefined && value.remotePort !== null)
        || (value.publicUrl !== undefined && value.publicUrl !== null)
      ) {
        throw new Error('FRPC HTTP tunnel config contains TCP endpoint fields');
      }
      return {
        ...common,
        proxyType,
        customDomain: normalizeFrpcCustomDomain(value.customDomain),
        hostname: normalizeFrpcPublicHostname(value.hostname),
      };
    }

    throw new Error('FRPC tunnel config has an unsupported proxy type');
  };

  const readFrpcTunnelConfigFromDisk = async () => {
    try {
      const raw = await fsPromises.readFile(FRPC_MANAGED_TUNNEL_FILE_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      return sanitizeFrpcTunnelConfig(parsed);
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        return null;
      }
      throw new Error('Failed to read FRPC tunnel config', { cause: error });
    }
  };

  const writeFrpcTunnelConfigToDisk = async (config) => {
    const sanitized = sanitizeFrpcTunnelConfig(config);
    const directory = path.dirname(FRPC_MANAGED_TUNNEL_FILE_PATH);
    const tempPath = `${FRPC_MANAGED_TUNNEL_FILE_PATH}.${crypto.randomUUID()}.tmp`;
    await fsPromises.mkdir(directory, { recursive: true });
    try {
      await fsPromises.writeFile(tempPath, JSON.stringify(sanitized, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await fsPromises.chmod(tempPath, 0o600);
      await fsPromises.rename(tempPath, FRPC_MANAGED_TUNNEL_FILE_PATH);
    } catch (error) {
      await fsPromises.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  };

  const upsertFrpcTunnelConfig = async ({
    serverAddress,
    serverPort,
    trustedCaFile,
    proxyType,
    remotePort,
    publicUrl,
    customDomain,
    hostname,
    token,
  }) => {
    const next = sanitizeFrpcTunnelConfig({
      version: FRPC_MANAGED_TUNNEL_VERSION,
      serverAddress,
      serverPort,
      trustedCaFile,
      proxyType,
      remotePort,
      publicUrl,
      customDomain,
      hostname,
      token,
      updatedAt: Date.now(),
    });
    const operation = persistFrpcTunnelConfigLock
      .catch(() => undefined)
      .then(() => writeFrpcTunnelConfigToDisk(next));
    persistFrpcTunnelConfigLock = operation;
    return operation;
  };

  const resolveFrpcTunnelToken = async ({ serverAddress, serverPort }) => {
    const config = await readFrpcTunnelConfigFromDisk();
    if (!config) {
      return '';
    }
    let normalizedAddress;
    let normalizedPort;
    try {
      normalizedAddress = normalizeFrpcServerAddress(serverAddress);
      normalizedPort = normalizeFrpcServerPort(serverPort);
    } catch {
      return '';
    }
    return config.serverAddress === normalizedAddress && config.serverPort === normalizedPort
      ? config.token
      : '';
  };

  return {
    readManagedRemoteTunnelConfigFromDisk,
    syncManagedRemoteTunnelConfigWithPresets,
    upsertManagedRemoteTunnelToken,
    resolveManagedRemoteTunnelToken,
    readFrpcTunnelConfigFromDisk,
    upsertFrpcTunnelConfig,
    resolveFrpcTunnelToken,
  };
};
