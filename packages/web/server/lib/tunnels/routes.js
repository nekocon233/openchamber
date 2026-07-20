export const createTunnelRoutesRuntime = (dependencies) => {
  const {
    crypto,
    URL,
    tunnelService,
    tunnelProviderRegistry,
    tunnelAuthController,
    readSettingsFromDiskMigrated,
    readManagedRemoteTunnelConfigFromDisk,
    readFrpcTunnelConfigFromDisk,
    normalizeTunnelProvider,
    normalizeTunnelMode,
    normalizeOptionalPath,
    normalizeManagedRemoteTunnelHostname,
    normalizeFrpcCustomDomain,
    normalizeFrpcPublicHostname,
    normalizeFrpcPublicUrl,
    normalizeTunnelBootstrapTtlMs,
    normalizeTunnelSessionTtlMs,
    isSupportedTunnelMode,
    upsertManagedRemoteTunnelToken,
    resolveManagedRemoteTunnelToken,
    upsertFrpcTunnelConfig,
    resolveFrpcTunnelToken,
    TUNNEL_MODE_QUICK,
    TUNNEL_MODE_MANAGED_LOCAL,
    TUNNEL_MODE_MANAGED_REMOTE,
    TUNNEL_PROVIDER_CLOUDFLARE,
    TUNNEL_PROVIDER_FRPC,
    TunnelServiceError,
    getActivePort,
    getRuntimeManagedRemoteTunnelHostname,
    setRuntimeManagedRemoteTunnelHostname,
    getRuntimeManagedRemoteTunnelToken,
    setRuntimeManagedRemoteTunnelToken,
    getActiveTunnelController,
  } = dependencies;

  const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
  const isTunnelManagementAllowed = (req) => tunnelAuthController?.isLocalManagementRequest?.(req) === true;
  const sendHostOnlyResponse = (res) => res.status(403).json({
    ok: false,
    error: 'Tunnel management is only available from the host machine',
    code: 'host_only',
  });
  const normalizeRequestedProvider = (value) => normalizeTunnelProvider(value, { strict: true });
  const normalizeRequestedMode = (value) => normalizeTunnelMode(value, { strict: true });
  const parsePort = (value) => {
    const parsed = typeof value === 'string' ? Number(value.trim()) : value;
    return Number.isInteger(parsed) ? parsed : undefined;
  };
  const normalizeFrpcProxyType = (value) => {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }
    if (typeof value !== 'string') {
      throw new TunnelServiceError('validation_error', 'FRPC proxy type must be tcp or http');
    }
    const normalized = value.trim().toLowerCase();
    if (normalized !== 'tcp' && normalized !== 'http') {
      throw new TunnelServiceError('validation_error', `Unsupported FRPC proxy type: ${value}`);
    }
    return normalized;
  };
  const resolveSettingsFrpcEndpoint = (settings) => {
    const configuredProxyType = normalizeFrpcProxyType(settings?.frpcProxyType);
    const rawCustomDomain = typeof settings?.frpcCustomDomain === 'string'
      ? settings.frpcCustomDomain.trim()
      : '';
    const rawHostname = typeof settings?.frpcPublicHostname === 'string'
      ? settings.frpcPublicHostname.trim()
      : '';
    const rawPublicUrl = typeof settings?.frpcPublicUrl === 'string'
      ? settings.frpcPublicUrl.trim()
      : '';
    const remotePort = parsePort(settings?.frpcRemotePort);
    const hasHttpFields = Boolean(rawCustomDomain || rawHostname);
    const hasTcpFields = remotePort !== undefined || Boolean(rawPublicUrl);

    if (!configuredProxyType && hasHttpFields && hasTcpFields) {
      throw new TunnelServiceError('validation_error', 'FRPC settings contain mixed TCP and HTTP endpoint fields');
    }
    const proxyType = configuredProxyType
      || (hasHttpFields ? 'http' : (hasTcpFields ? 'tcp' : undefined));
    if (proxyType === 'http') {
      return {
        proxyType,
        remotePort: undefined,
        publicUrl: undefined,
        customDomain: normalizeFrpcCustomDomain(rawCustomDomain),
        hostname: normalizeFrpcPublicHostname(rawHostname),
      };
    }
    let publicUrl;
    if (proxyType === 'tcp') {
      try {
        publicUrl = normalizeFrpcPublicUrl(rawPublicUrl);
      } catch (error) {
        throw new TunnelServiceError(
          'validation_error',
          error instanceof Error ? error.message : 'FRPC TCP public HTTPS URL is invalid'
        );
      }
    }
    return {
      proxyType,
      remotePort,
      publicUrl,
      customDomain: undefined,
      hostname: undefined,
    };
  };
  const resolveFrpcEndpoint = ({
    proxyType,
    remotePort,
    publicUrl,
    customDomain,
    hostname,
    endpointExplicit,
    storedConfig,
    settings,
  }) => {
    const normalizedProxyType = normalizeFrpcProxyType(proxyType);
    const hasRemotePort = remotePort !== undefined && remotePort !== null;
    const hasCustomDomain = typeof customDomain === 'string' && customDomain.trim().length > 0;
    const hasPublicUrl = typeof publicUrl === 'string' && publicUrl.trim().length > 0;
    const explicit = endpointExplicit === true || Boolean(normalizedProxyType || hasRemotePort || hasCustomDomain || hasPublicUrl);
    if (explicit) {
      return {
        proxyType: normalizedProxyType
          || (hasCustomDomain && !hasRemotePort ? 'http' : (hasRemotePort && !hasCustomDomain ? 'tcp' : undefined)),
        remotePort,
        publicUrl,
        customDomain,
        hostname,
      };
    }
    if (storedConfig) {
      return {
        proxyType: storedConfig.proxyType,
        remotePort: storedConfig.remotePort,
        publicUrl: storedConfig.publicUrl,
        customDomain: storedConfig.customDomain,
        hostname: storedConfig.hostname,
      };
    }
    return resolveSettingsFrpcEndpoint(settings);
  };

  const assertControllerStillActive = (controller) => {
    if (controller && tunnelService.isActiveController?.(controller) === false) {
      throw new TunnelServiceError(
        'startup_cancelled',
        'Tunnel start was stopped or superseded before completion'
      );
    }
  };

  const resolveActiveNormalizedTunnelMode = () => {
    const mode = tunnelService.resolveActiveMode();
    if (mode === TUNNEL_MODE_MANAGED_LOCAL) {
      return TUNNEL_MODE_MANAGED_LOCAL;
    }
    if (mode === TUNNEL_MODE_MANAGED_REMOTE) {
      return TUNNEL_MODE_MANAGED_REMOTE;
    }
    return TUNNEL_MODE_QUICK;
  };

  const resolveNormalizedTunnelHost = (publicUrl) => {
    if (typeof publicUrl !== 'string' || publicUrl.trim().length === 0) {
      return null;
    }
    try {
      return new URL(publicUrl).hostname.toLowerCase();
    } catch {
      return null;
    }
  };

  const normalizeBrowserReadyPublicUrl = (value) => {
    if (typeof value !== 'string' || !value.trim()) {
      throw new TunnelServiceError('unsafe_public_url', 'Tunnel provider did not supply a browser-ready HTTPS URL');
    }
    let parsed;
    try {
      parsed = new URL(value.trim());
    } catch {
      throw new TunnelServiceError('unsafe_public_url', 'Tunnel provider supplied an invalid public URL');
    }
    if (
      parsed.protocol !== 'https:'
      || parsed.username
      || parsed.password
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash
      || parsed.origin === 'null'
    ) {
      throw new TunnelServiceError('unsafe_public_url', 'Tunnel public URL must be an origin-only HTTPS URL');
    }
    return parsed.origin;
  };

  const resolvePreferredTunnelProvider = async (reqBody = null) => {
    if (hasOwn(reqBody, 'provider')) {
      return normalizeRequestedProvider(reqBody.provider);
    }
    const activeProvider = tunnelService.resolveActiveProvider();
    if (activeProvider) {
      return normalizeTunnelProvider(activeProvider);
    }
    const settings = await readSettingsFromDiskMigrated();
    return normalizeTunnelProvider(settings?.tunnelProvider);
  };

  const startTunnelWithNormalizedRequest = async ({
    provider,
    mode,
    intent,
    hostname,
    token,
    configPath,
    selectedPresetId,
    selectedPresetName,
    serverAddress,
    serverPort,
    trustedCaFile,
    proxyType,
    remotePort,
    publicUrl,
    customDomain,
    frpcEndpointExplicit,
    signal,
  }) => {
    if (provider === TUNNEL_PROVIDER_CLOUDFLARE && mode === TUNNEL_MODE_MANAGED_REMOTE) {
      setRuntimeManagedRemoteTunnelHostname(hostname);
      setRuntimeManagedRemoteTunnelToken(token);

      if (token && hostname) {
        await upsertManagedRemoteTunnelToken({
          id: selectedPresetId || hostname,
          name: selectedPresetName || hostname,
          hostname,
          token,
        });
      }
    }

    let effectiveServerAddress = serverAddress;
    let effectiveServerPort = serverPort;
    let effectiveTrustedCaFile = trustedCaFile;
    let effectiveProxyType = proxyType;
    let effectiveRemotePort = remotePort;
    let effectivePublicUrl = publicUrl;
    let effectiveCustomDomain = customDomain;
    let effectiveHostname = hostname;
    let effectiveToken = token;
    if (provider === TUNNEL_PROVIDER_FRPC) {
      const settings = await readSettingsFromDiskMigrated();
      let storedConfig = null;
      try {
        storedConfig = await readFrpcTunnelConfigFromDisk();
      } catch (error) {
        const canReplaceInvalidConfig = frpcEndpointExplicit === true
          && typeof effectiveServerAddress === 'string'
          && effectiveServerAddress.trim().length > 0
          && effectiveServerPort !== undefined
          && typeof effectiveTrustedCaFile === 'string'
          && effectiveTrustedCaFile.trim().length > 0
          && typeof effectiveToken === 'string'
          && effectiveToken.trim().length > 0;
        if (!canReplaceInvalidConfig) {
          throw error;
        }
      }
      effectiveServerAddress = (typeof effectiveServerAddress === 'string' && effectiveServerAddress.trim())
        ? effectiveServerAddress
        : (storedConfig?.serverAddress ?? settings?.frpcServerAddress);
      effectiveServerPort = effectiveServerPort ?? storedConfig?.serverPort ?? settings?.frpcServerPort;
      effectiveTrustedCaFile = (typeof effectiveTrustedCaFile === 'string' && effectiveTrustedCaFile.trim())
        ? effectiveTrustedCaFile
        : (storedConfig?.trustedCaFile ?? settings?.frpcTrustedCaFile);
      const endpoint = resolveFrpcEndpoint({
        proxyType: effectiveProxyType,
        remotePort: effectiveRemotePort,
        publicUrl: effectivePublicUrl,
        customDomain: effectiveCustomDomain,
        hostname: effectiveHostname,
        endpointExplicit: frpcEndpointExplicit,
        storedConfig,
        settings,
      });
      effectiveProxyType = endpoint.proxyType;
      effectiveRemotePort = endpoint.remotePort;
      effectivePublicUrl = endpoint.publicUrl;
      effectiveCustomDomain = endpoint.customDomain;
      effectiveHostname = endpoint.hostname;
      effectiveToken = effectiveToken || await resolveFrpcTunnelToken({
        serverAddress: effectiveServerAddress,
        serverPort: effectiveServerPort,
      });
    }

    const result = await tunnelService.start({
      provider,
      mode,
      intent,
      configPath,
      token: effectiveToken,
      hostname: effectiveHostname,
      customDomain: effectiveCustomDomain,
      proxyType: effectiveProxyType,
      serverAddress: effectiveServerAddress,
      serverPort: effectiveServerPort,
      trustedCaFile: effectiveTrustedCaFile,
      remotePort: effectiveRemotePort,
      publicUrl: effectivePublicUrl,
    }, { signal });
    const startedController = result.controllerStarted ? result.controller : null;

    let browserPublicUrl;
    try {
      browserPublicUrl = normalizeBrowserReadyPublicUrl(result.publicUrl);
    } catch (error) {
      try {
        if (result.controller) {
          await tunnelService.stop(result.controller);
        }
      } catch (stopError) {
        throw new TunnelServiceError(
          'unsafe_public_url',
          `Tunnel did not provide a secure browser URL and termination failed: ${stopError instanceof Error ? stopError.message : String(stopError)}`
        );
      }
      throw error;
    }

    if (signal?.aborted) {
      if (startedController) {
        await tunnelService.stop(startedController);
      }
      throw new TunnelServiceError('startup_cancelled', 'Tunnel start was cancelled');
    }
    assertControllerStillActive(result.controller);

    if (provider === TUNNEL_PROVIDER_FRPC) {
      try {
        const metadata = result.providerMetadata || {};
        const persistedProxyType = metadata.proxyType
          || (result.request.customDomain ? 'http' : 'tcp');
        await upsertFrpcTunnelConfig({
          serverAddress: metadata.serverAddress ?? result.request.serverAddress,
          serverPort: metadata.serverPort ?? result.request.serverPort,
          trustedCaFile: metadata.trustedCaFile ?? result.request.trustedCaFile,
          proxyType: persistedProxyType,
          remotePort: persistedProxyType === 'tcp'
            ? (metadata.remotePort ?? result.request.remotePort)
            : undefined,
          publicUrl: persistedProxyType === 'tcp'
            ? (metadata.publicUrl ?? result.request.publicUrl)
            : undefined,
          customDomain: persistedProxyType === 'http'
            ? (metadata.customDomain ?? result.request.customDomain)
            : undefined,
          hostname: persistedProxyType === 'http'
            ? (metadata.hostname ?? result.request.hostname)
            : undefined,
          token: result.request.token,
        });
      } catch (error) {
        try {
          if (startedController) {
            await tunnelService.stop(startedController);
          }
        } catch (stopError) {
          throw new TunnelServiceError(
            'config_persistence_failed',
            `FRPC connected, its private configuration could not be saved, and termination failed: ${stopError instanceof Error ? stopError.message : String(stopError)}`,
            { controllerReplaced: result.controllerReplaced === true }
          );
        }
        throw new TunnelServiceError(
          'config_persistence_failed',
          'FRPC connected, but its private configuration could not be saved',
          { controllerReplaced: result.controllerReplaced === true }
        );
      }
    }

    if (signal?.aborted) {
      if (startedController) {
        await tunnelService.stop(startedController);
      }
      throw new TunnelServiceError('startup_cancelled', 'Tunnel start was cancelled');
    }
    assertControllerStillActive(result.controller);

    console.log(`Tunnel active (${result.provider}): ${browserPublicUrl}`);
    return {
      publicUrl: browserPublicUrl,
      mode: result.activeMode,
      provider: result.provider,
      providerMetadata: result.providerMetadata,
      controllerReplaced: result.controllerReplaced === true,
      controller: result.controller,
      controllerStarted: result.controllerStarted === true,
    };
  };

  const createGenericModeChecks = ({ modeKey, requiredFields, doctorRequest, startupReady }) => {
    const checks = [
      {
        id: 'startup_readiness',
        label: 'Provider startup readiness',
        status: startupReady ? 'pass' : 'fail',
        detail: startupReady
          ? 'Provider dependency checks passed.'
          : 'Resolve provider checks before starting tunnels.',
      },
    ];

    for (const field of requiredFields) {
      const value = doctorRequest?.[field];
      const present = typeof value === 'string' ? value.trim().length > 0 : Boolean(value);
      checks.push({
        id: `requirement_${field}`,
        label: `Required: ${field}`,
        status: present ? 'pass' : 'fail',
        detail: present
          ? `${field} is configured.`
          : `${field} is required for ${modeKey}.`,
      });
    }

    const failures = checks.filter((entry) => entry.status === 'fail').length;
    const warnings = checks.filter((entry) => entry.status === 'warn').length;
    return {
      mode: modeKey,
      checks,
      summary: {
        ready: failures === 0,
        failures,
        warnings,
      },
      ready: failures === 0,
      blockers: checks
        .filter((entry) => entry.status === 'fail' && entry.id !== 'startup_readiness')
        .map((entry) => entry.detail || entry.label || entry.id),
    };
  };

  const runTunnelDoctor = async ({ providerId, modeFilter, doctorRequest }) => {
    const provider = tunnelProviderRegistry.get(providerId);
    if (!provider) {
      throw new TunnelServiceError('provider_unsupported', `Unsupported tunnel provider: ${providerId}`);
    }

    const capabilities = provider.capabilities || {};
    const modeKeys = Array.isArray(capabilities.modes)
      ? capabilities.modes.map((entry) => entry?.key).filter((key) => typeof key === 'string' && key.length > 0)
      : [];

    if (modeFilter && !modeKeys.includes(modeFilter)) {
      throw new TunnelServiceError('mode_unsupported', `Provider '${providerId}' does not support mode '${modeFilter}'`);
    }

    if (typeof provider.diagnose === 'function') {
      const diagnosed = await provider.diagnose({
        ...doctorRequest,
        mode: modeFilter || doctorRequest?.mode,
      }, {
        capabilities,
      });
      const providerChecks = Array.isArray(diagnosed?.providerChecks) ? diagnosed.providerChecks : [];
      const allModes = Array.isArray(diagnosed?.modes) ? diagnosed.modes : [];
      const modes = modeFilter ? allModes.filter((entry) => entry?.mode === modeFilter) : allModes;
      return {
        ok: true,
        provider: providerId,
        providerChecks,
        modes,
      };
    }

    const availability = await tunnelService.checkAvailability(providerId);
    const dependencyAvailable = Boolean(availability?.available);
    const providerChecks = [{
      id: 'dependency',
      label: 'Provider dependency',
      status: dependencyAvailable ? 'pass' : 'fail',
      detail: dependencyAvailable
        ? (availability?.version || 'available')
        : (availability?.message || 'Required provider dependency is unavailable.'),
    }];

    const targetModes = (Array.isArray(capabilities.modes) ? capabilities.modes : [])
      .filter((entry) => !modeFilter || entry?.key === modeFilter);
    const modes = targetModes.map((entry) => createGenericModeChecks({
      modeKey: entry.key,
      requiredFields: Array.isArray(entry?.requires) ? entry.requires : [],
      doctorRequest,
      startupReady: dependencyAvailable,
    }));

    return {
      ok: true,
      provider: providerId,
      providerChecks,
      modes,
    };
  };

  const registerRoutes = (app) => {
    app.get('/api/openchamber/tunnel/check', async (req, res) => {
      const managementAllowed = isTunnelManagementAllowed(req);
      if (!managementAllowed) {
        return res.json({
          available: false,
          provider: null,
          version: null,
          dependency: null,
          installCommand: null,
          installUrl: null,
          platform: process.platform,
          message: null,
          managementAllowed,
        });
      }
      try {
        const requestedProvider = hasOwn(req?.query, 'provider')
          ? normalizeRequestedProvider(req.query.provider)
          : await resolvePreferredTunnelProvider();
        const result = await tunnelService.checkAvailability(requestedProvider);
        res.json({
          available: result.available,
          provider: requestedProvider,
          version: result.version || null,
          dependency: result.dependency || null,
          installCommand: result.installCommand || null,
          installUrl: result.installUrl || null,
          platform: result.platform || process.platform,
          message: result.message || null,
          managementAllowed,
        });
      } catch (error) {
        console.warn('Tunnel dependency check failed:', error);
        if (error instanceof TunnelServiceError) {
          return res.status(422).json({
            available: false,
            provider: null,
            error: error.message,
            code: error.code,
          });
        }
        res.json({ available: false, provider: null, version: null, dependency: null, installCommand: null, installUrl: null, platform: process.platform, message: null });
      }
    });

    const handleTunnelDoctor = async (req, res) => {
      if (!isTunnelManagementAllowed(req)) {
        return sendHostOnlyResponse(res);
      }
      try {
        const params = req.query || {};
        const body = req.body || {};

        const providerId = hasOwn(params, 'provider')
          ? normalizeRequestedProvider(params.provider)
          : await resolvePreferredTunnelProvider();
        const modeFilter = hasOwn(params, 'mode')
          ? normalizeRequestedMode(params.mode)
          : null;

        const settings = await readSettingsFromDiskMigrated();
        const storedFrpcConfig = providerId === TUNNEL_PROVIDER_FRPC
          ? await readFrpcTunnelConfigFromDisk()
          : null;
        const selectedPresetId = typeof params.managedRemoteTunnelPresetId === 'string'
          ? params.managedRemoteTunnelPresetId.trim()
          : '';
        const requestConfigPath = normalizeOptionalPath(params.configPath)
          ?? normalizeOptionalPath(settings?.managedLocalTunnelConfigPath);
        const requestManagedRemoteHostname = normalizeManagedRemoteTunnelHostname(params.managedRemoteTunnelHostname);
        const requestTunnelHostname = normalizeManagedRemoteTunnelHostname(params.tunnelHostname);
        const requestHostname = normalizeManagedRemoteTunnelHostname(params.hostname);
        const hostnameFromSettings = normalizeManagedRemoteTunnelHostname(settings?.managedRemoteTunnelHostname);
        const hostname = requestHostname || requestTunnelHostname || requestManagedRemoteHostname || hostnameFromSettings;

        const requestManagedRemoteToken = typeof body.managedRemoteTunnelToken === 'string'
          ? body.managedRemoteTunnelToken.trim()
          : '';
        const requestTunnelToken = typeof body.tunnelToken === 'string'
          ? body.tunnelToken.trim()
          : '';
        const requestToken = typeof body.token === 'string'
          ? body.token.trim()
          : '';
        const requestTokenProvided = body.managedRemoteTunnelTokenProvided === true
          || body.tunnelTokenProvided === true
          || body.tokenProvided === true;
        const requestHostnameProvided = body.managedRemoteTunnelHostnameProvided === true
          || body.tunnelHostnameProvided === true
          || body.hostnameProvided === true;
        const storedManagedRemoteToken = typeof settings?.managedRemoteTunnelToken === 'string'
          ? settings.managedRemoteTunnelToken.trim()
          : '';
        const managedRemoteTunnelConfig = await readManagedRemoteTunnelConfigFromDisk();
        const serverHasSavedManagedRemoteProfile = managedRemoteTunnelConfig.tunnels.some((entry) => {
          const savedHostname = normalizeManagedRemoteTunnelHostname(entry?.hostname);
          const savedToken = typeof entry?.token === 'string' ? entry.token.trim() : '';
          return Boolean(savedHostname && savedToken);
        });
        const cliHasSavedManagedRemoteProfile = params.hasSavedManagedRemoteProfile === '1';
        const hasSavedManagedRemoteProfile = serverHasSavedManagedRemoteProfile || cliHasSavedManagedRemoteProfile;
        const configManagedRemoteToken = providerId === TUNNEL_PROVIDER_CLOUDFLARE
          ? await resolveManagedRemoteTunnelToken({ presetId: selectedPresetId, hostname })
          : '';
        const runtimeHostname = getRuntimeManagedRemoteTunnelHostname();
        const runtimeToken = getRuntimeManagedRemoteTunnelToken();
        const token = requestToken
          || requestTunnelToken
          || requestManagedRemoteToken
          || ((runtimeHostname && hostname && runtimeHostname === hostname) ? runtimeToken : '')
          || configManagedRemoteToken
          || storedManagedRemoteToken;

        const rawServerPort = params.serverPort ?? params.frpcServerPort ?? storedFrpcConfig?.serverPort ?? settings?.frpcServerPort;
        const serverAddress = typeof (params.serverAddress ?? params.frpcServerAddress ?? storedFrpcConfig?.serverAddress ?? settings?.frpcServerAddress) === 'string'
          ? (params.serverAddress ?? params.frpcServerAddress ?? storedFrpcConfig?.serverAddress ?? settings?.frpcServerAddress).trim()
          : '';
        const serverPort = parsePort(rawServerPort);
        const trustedCaFile = typeof (params.trustedCaFile ?? params.frpcTrustedCaFile ?? storedFrpcConfig?.trustedCaFile ?? settings?.frpcTrustedCaFile) === 'string'
          ? (params.trustedCaFile ?? params.frpcTrustedCaFile ?? storedFrpcConfig?.trustedCaFile ?? settings?.frpcTrustedCaFile).trim()
          : '';
        const endpointInput = {
          proxyType: body.proxyType ?? body.frpcProxyType ?? params.proxyType ?? params.frpcProxyType,
          remotePort: parsePort(body.remotePort ?? body.frpcRemotePort ?? params.remotePort ?? params.frpcRemotePort),
          publicUrl: body.publicUrl ?? body.frpcPublicUrl ?? params.publicUrl ?? params.frpcPublicUrl,
          customDomain: body.customDomain ?? body.frpcCustomDomain ?? params.customDomain ?? params.frpcCustomDomain,
          hostname: body.frpcPublicHostname ?? body.hostname ?? params.frpcPublicHostname ?? params.hostname,
        };
        const endpointExplicit = [
          'proxyType',
          'frpcProxyType',
          'remotePort',
          'frpcRemotePort',
          'publicUrl',
          'frpcPublicUrl',
          'customDomain',
          'frpcCustomDomain',
          'frpcPublicHostname',
        ].some((key) => hasOwn(body, key) || hasOwn(params, key))
          || (providerId === TUNNEL_PROVIDER_FRPC && (hasOwn(body, 'hostname') || hasOwn(params, 'hostname')));
        const frpcEndpoint = providerId === TUNNEL_PROVIDER_FRPC
          ? resolveFrpcEndpoint({
            ...endpointInput,
            endpointExplicit,
            storedConfig: storedFrpcConfig,
            settings,
          })
          : null;
        const frpcToken = requestToken || requestTunnelToken || requestManagedRemoteToken || (
          providerId === TUNNEL_PROVIDER_FRPC
            ? await resolveFrpcTunnelToken({ serverAddress, serverPort })
            : ''
        );

        const doctorRequest = {
          mode: modeFilter,
          hostname: providerId === TUNNEL_PROVIDER_FRPC ? frpcEndpoint?.hostname : hostname,
          customDomain: frpcEndpoint?.customDomain,
          proxyType: frpcEndpoint?.proxyType,
          token: providerId === TUNNEL_PROVIDER_FRPC ? frpcToken : token,
          tokenProvided: requestTokenProvided,
          hostnameProvided: requestHostnameProvided,
          configPath: requestConfigPath,
          hasSavedManagedRemoteProfile,
          serverAddress,
          serverPort,
          trustedCaFile,
          remotePort: frpcEndpoint?.remotePort,
          publicUrl: frpcEndpoint?.publicUrl,
        };

        const result = await runTunnelDoctor({
          providerId,
          modeFilter,
          doctorRequest,
        });
        return res.json(result);
      } catch (error) {
        if (error instanceof TunnelServiceError) {
          return res.status(400).json({ ok: false, error: error.message, code: error.code });
        }
        console.warn('Tunnel doctor failed:', error);
        return res.status(500).json({ ok: false, error: 'Failed to run tunnel doctor' });
      }
    };
    app.post('/api/openchamber/tunnel/doctor', handleTunnelDoctor);
    app.get('/api/openchamber/tunnel/doctor', handleTunnelDoctor);

    app.get('/api/openchamber/tunnel/providers', (req, res) => {
      const managementAllowed = isTunnelManagementAllowed(req);
      const providers = managementAllowed ? tunnelProviderRegistry.listCapabilities() : [];
      return res.json({ providers, managementAllowed });
    });

    app.get('/api/openchamber/tunnel/status', async (req, res) => {
      try {
        const managementAllowed = isTunnelManagementAllowed(req);
        if (!managementAllowed) {
          const activeProvider = tunnelService.resolveActiveProvider();
          const publicUrl = tunnelService.getPublicUrl();
          const activeTunnelMode = publicUrl ? resolveActiveNormalizedTunnelMode() : null;
          return res.json({
            active: Boolean(publicUrl),
            url: publicUrl || null,
            mode: activeTunnelMode,
            provider: activeProvider || null,
            managementAllowed,
            policy: 'host-only-management',
            activeTunnelMode,
            activeSessions: [],
          });
        }
        const settings = await readSettingsFromDiskMigrated();
        const normalizedMode = normalizeTunnelMode(settings?.tunnelMode);
        const managedRemoteHostname = normalizeManagedRemoteTunnelHostname(settings?.managedRemoteTunnelHostname);
        const managedRemoteTunnelConfig = await readManagedRemoteTunnelConfigFromDisk();
        const managedRemoteTunnelPresetSummaries = managedRemoteTunnelConfig.tunnels.map((entry) => ({
          id: entry.id,
          name: entry.name,
          hostname: entry.hostname,
        }));
        const hasStoredManagedRemoteToken = typeof settings?.managedRemoteTunnelToken === 'string' && settings.managedRemoteTunnelToken.trim().length > 0;
        const hasManagedRemoteTunnelToken = getRuntimeManagedRemoteTunnelToken().length > 0 || managedRemoteTunnelConfig.tunnels.length > 0 || hasStoredManagedRemoteToken;
        const bootstrapTtlMs = settings?.tunnelBootstrapTtlMs === null
          ? null
          : normalizeTunnelBootstrapTtlMs(settings?.tunnelBootstrapTtlMs);
        const sessionTtlMs = normalizeTunnelSessionTtlMs(settings?.tunnelSessionTtlMs);
        const activeSessions = tunnelAuthController.listTunnelSessions();
        const activeProvider = tunnelService.resolveActiveProvider();
        const provider = activeProvider || normalizeTunnelProvider(settings?.tunnelProvider);
        const publicUrl = tunnelService.getPublicUrl();
        const activeProviderMetadata = publicUrl ? tunnelService.getProviderMetadata() : null;
        let frpcTunnelConfig = null;
        let frpcConfigStatus = 'missing';
        let frpcConfigError = null;
        try {
          frpcTunnelConfig = await readFrpcTunnelConfigFromDisk();
          frpcConfigStatus = frpcTunnelConfig ? 'ready' : 'missing';
        } catch {
          frpcConfigStatus = 'error';
          frpcConfigError = 'FRPC tunnel configuration is invalid or unreadable';
        }
        let configuredFrpcEndpoint = frpcTunnelConfig;
        if (frpcConfigStatus === 'missing') {
          try {
            configuredFrpcEndpoint = {
              serverAddress: settings?.frpcServerAddress,
              serverPort: settings?.frpcServerPort,
              trustedCaFile: settings?.frpcTrustedCaFile,
              ...resolveSettingsFrpcEndpoint(settings),
            };
          } catch {
            frpcConfigStatus = 'error';
            frpcConfigError = 'FRPC tunnel configuration is invalid or unreadable';
            configuredFrpcEndpoint = null;
          }
        }
        const reportedFrpcEndpoint = activeProvider === TUNNEL_PROVIDER_FRPC && activeProviderMetadata
          ? activeProviderMetadata
          : configuredFrpcEndpoint;
        const frpcServerAddress = reportedFrpcEndpoint?.serverAddress ?? null;
        const frpcServerPort = reportedFrpcEndpoint?.serverPort ?? null;
        const frpcTrustedCaFile = reportedFrpcEndpoint?.trustedCaFile ?? null;
        const frpcProxyType = reportedFrpcEndpoint?.proxyType ?? null;
        const frpcRemotePort = frpcProxyType === 'tcp'
          ? (reportedFrpcEndpoint?.remotePort ?? null)
          : null;
        const frpcPublicUrl = frpcProxyType === 'tcp'
          ? (reportedFrpcEndpoint?.publicUrl ?? null)
          : null;
        const frpcCustomDomain = frpcProxyType === 'http'
          ? (reportedFrpcEndpoint?.customDomain ?? null)
          : null;
        const frpcPublicHostname = frpcProxyType === 'http'
          ? (reportedFrpcEndpoint?.hostname ?? null)
          : null;
        const hasFrpcTunnelToken = frpcConfigStatus === 'ready' && Boolean(frpcTunnelConfig?.token);

        if (!publicUrl) {
          return res.json({
            active: false,
            managementAllowed,
            url: null,
            mode: normalizedMode,
            provider,
            providerMetadata: null,
            hasManagedRemoteTunnelToken,
            managedRemoteTunnelHostname: managedRemoteHostname || null,
            managedRemoteTunnelPresets: managedRemoteTunnelPresetSummaries,
            managedRemoteTunnelTokenPresetIds: managedRemoteTunnelConfig.tunnels.map((entry) => entry.id),
            hasFrpcTunnelToken,
            frpcServerAddress,
            frpcServerPort,
            frpcTrustedCaFile,
            frpcRemotePort,
            frpcPublicUrl,
            frpcProxyType,
            frpcCustomDomain,
            frpcPublicHostname,
            frpcConfigStatus,
            frpcConfigError,
            hasBootstrapToken: false,
            bootstrapExpiresAt: null,
            policy: 'tunnel-gated',
            activeTunnelMode: tunnelAuthController.getActiveTunnelMode() || null,
            activeSessions,
            localPort: getActivePort(),
            ttlConfig: {
              bootstrapTtlMs,
              sessionTtlMs,
            },
          });
        }

        const activeNormalizedMode = resolveActiveNormalizedTunnelMode();
        const activeTunnelId = tunnelAuthController.getActiveTunnelId();
        const activeTunnelHost = tunnelAuthController.getActiveTunnelHost();
        const resolvedTunnelHost = resolveNormalizedTunnelHost(publicUrl);
        const activeTunnelMode = tunnelAuthController.getActiveTunnelMode();
        const needsActiveTunnelSync = !activeTunnelId
          || !activeTunnelHost
          || !resolvedTunnelHost
          || activeTunnelHost !== resolvedTunnelHost
          || activeTunnelMode !== activeNormalizedMode;
        if (needsActiveTunnelSync) {
          tunnelAuthController.setActiveTunnel({
            tunnelId: activeTunnelId || crypto.randomUUID(),
            publicUrl,
            mode: activeNormalizedMode,
          });
        }

        const bootstrapStatus = tunnelAuthController.getBootstrapStatus();
        const providerMetadata = activeProviderMetadata;

        return res.json({
          active: true,
          managementAllowed,
          url: publicUrl,
          mode: activeNormalizedMode,
          provider,
          providerMetadata,
          hasManagedRemoteTunnelToken,
          managedRemoteTunnelHostname: managedRemoteHostname || null,
          managedRemoteTunnelPresets: managedRemoteTunnelPresetSummaries,
          managedRemoteTunnelTokenPresetIds: managedRemoteTunnelConfig.tunnels.map((entry) => entry.id),
          hasFrpcTunnelToken,
          frpcServerAddress,
          frpcServerPort,
          frpcTrustedCaFile,
          frpcRemotePort,
          frpcPublicUrl,
          frpcProxyType,
          frpcCustomDomain,
          frpcPublicHostname,
          frpcConfigStatus,
          frpcConfigError,
          hasBootstrapToken: bootstrapStatus.hasBootstrapToken,
          bootstrapExpiresAt: bootstrapStatus.bootstrapExpiresAt,
          policy: 'tunnel-gated',
          activeTunnelMode: activeNormalizedMode,
          activeSessions: tunnelAuthController.listTunnelSessions(),
          localPort: getActivePort(),
          ttlConfig: {
            bootstrapTtlMs,
            sessionTtlMs,
          },
        });
      } catch (error) {
        return res.status(500).json({ error: 'Failed to get tunnel status' });
      }
    });

    app.put('/api/openchamber/tunnel/managed-remote-token', async (req, res) => {
      if (!isTunnelManagementAllowed(req)) {
        return sendHostOnlyResponse(res);
      }
      try {
        const presetId = typeof req?.body?.presetId === 'string' ? req.body.presetId.trim() : '';
        const presetName = typeof req?.body?.presetName === 'string' ? req.body.presetName.trim() : '';
        const managedRemoteTunnelHostname = normalizeManagedRemoteTunnelHostname(req?.body?.managedRemoteTunnelHostname);
        const managedRemoteTunnelToken = typeof req?.body?.managedRemoteTunnelToken === 'string' ? req.body.managedRemoteTunnelToken.trim() : '';

        if (!presetId || !presetName || !managedRemoteTunnelHostname || !managedRemoteTunnelToken) {
          return res.status(400).json({ ok: false, error: 'presetId, presetName, managedRemoteTunnelHostname and managedRemoteTunnelToken are required' });
        }

        await upsertManagedRemoteTunnelToken({
          id: presetId,
          name: presetName,
          hostname: managedRemoteTunnelHostname,
          token: managedRemoteTunnelToken,
        });

        const managedRemoteTunnelConfig = await readManagedRemoteTunnelConfigFromDisk();
        return res.json({ ok: true, managedRemoteTunnelTokenPresetIds: managedRemoteTunnelConfig.tunnels.map((entry) => entry.id) });
      } catch (error) {
        return res.status(500).json({ ok: false, error: 'Failed to save managed remote tunnel token' });
      }
    });

    app.post('/api/openchamber/tunnel/start', async (_req, res) => {
      if (!isTunnelManagementAllowed(_req)) {
        return sendHostOnlyResponse(res);
      }
      const startAbortController = new AbortController();
      const abortStart = () => startAbortController.abort();
      const abortOnResponseClose = () => {
        if (!res.writableEnded) {
          abortStart();
        }
      };
      _req?.once?.('aborted', abortStart);
      res?.once?.('close', abortOnResponseClose);
      try {
        const settings = await readSettingsFromDiskMigrated();
        const providerExplicit = hasOwn(_req?.body, 'provider') && _req.body.provider !== undefined;
        const provider = providerExplicit
          ? normalizeRequestedProvider(_req.body.provider)
          : normalizeTunnelProvider(settings?.tunnelProvider);
        const providerCapabilities = tunnelProviderRegistry.get(provider)?.capabilities;
        if (!providerCapabilities) {
          throw new TunnelServiceError('provider_unsupported', `Unsupported tunnel provider: ${provider}`);
        }
        const providerDefaultMode = providerCapabilities?.defaults?.mode;
        const modeExplicit = hasOwn(_req?.body, 'mode') && _req.body.mode !== undefined;
        const configuredMode = normalizeTunnelMode(settings?.tunnelMode);
        const providerSupportsConfiguredMode = providerCapabilities?.modes?.some((entry) => entry?.key === configuredMode);
        const modeInput = modeExplicit
          ? normalizeRequestedMode(_req.body.mode)
          : (providerSupportsConfiguredMode ? configuredMode : providerDefaultMode);
        const intent = typeof _req?.body?.intent === 'string' ? _req.body.intent.trim().toLowerCase() : undefined;
        const mode = typeof modeInput === 'string'
          ? modeInput.trim().toLowerCase()
          : normalizeTunnelMode(modeInput);
        if (!isSupportedTunnelMode(mode) || !providerCapabilities.modes?.some((entry) => entry?.key === mode)) {
          throw new TunnelServiceError('mode_unsupported', `Provider '${provider}' does not support mode '${mode}'`);
        }
        const selectedPresetId = typeof _req?.body?.managedRemoteTunnelPresetId === 'string' ? _req.body.managedRemoteTunnelPresetId.trim() : '';
        const selectedPresetName = typeof _req?.body?.managedRemoteTunnelPresetName === 'string' ? _req.body.managedRemoteTunnelPresetName.trim() : '';
        const requestConfigPath = normalizeOptionalPath(_req?.body?.configPath)
          ?? normalizeOptionalPath(settings?.managedLocalTunnelConfigPath);
        const requestManagedRemoteHostname = normalizeManagedRemoteTunnelHostname(_req?.body?.managedRemoteTunnelHostname);
        const requestTunnelHostname = normalizeManagedRemoteTunnelHostname(_req?.body?.tunnelHostname);
        const requestHostname = normalizeManagedRemoteTunnelHostname(_req?.body?.hostname);
        const hostnameFromSettings = normalizeManagedRemoteTunnelHostname(settings?.managedRemoteTunnelHostname);
        let hostname = requestHostname || requestTunnelHostname || requestManagedRemoteHostname || hostnameFromSettings;
        const requestManagedRemoteToken = typeof _req?.body?.managedRemoteTunnelToken === 'string' ? _req.body.managedRemoteTunnelToken.trim() : '';
        const requestTunnelToken = typeof _req?.body?.tunnelToken === 'string' ? _req.body.tunnelToken.trim() : '';
        const requestToken = typeof _req?.body?.token === 'string' ? _req.body.token.trim() : '';
        const storedManagedRemoteToken = typeof settings?.managedRemoteTunnelToken === 'string' ? settings.managedRemoteTunnelToken.trim() : '';
        const configManagedRemoteToken = provider === TUNNEL_PROVIDER_CLOUDFLARE
          ? await resolveManagedRemoteTunnelToken({ presetId: selectedPresetId, hostname })
          : '';
        const runtimeHostname = getRuntimeManagedRemoteTunnelHostname();
        const runtimeToken = getRuntimeManagedRemoteTunnelToken();
        const token = provider === TUNNEL_PROVIDER_CLOUDFLARE
          ? (requestToken
            || requestTunnelToken
            || requestManagedRemoteToken
            || ((runtimeHostname && hostname && runtimeHostname === hostname) ? runtimeToken : '')
            || configManagedRemoteToken
             || storedManagedRemoteToken)
          : (requestToken || requestTunnelToken || requestManagedRemoteToken);
        const serverAddress = typeof (_req?.body?.serverAddress ?? _req?.body?.frpcServerAddress) === 'string'
          ? (_req.body.serverAddress ?? _req.body.frpcServerAddress).trim()
          : undefined;
        const serverPort = parsePort(_req?.body?.serverPort ?? _req?.body?.frpcServerPort);
        const trustedCaFile = typeof (_req?.body?.trustedCaFile ?? _req?.body?.frpcTrustedCaFile) === 'string'
          ? (_req.body.trustedCaFile ?? _req.body.frpcTrustedCaFile).trim()
          : undefined;
        const proxyType = _req?.body?.proxyType ?? _req?.body?.frpcProxyType;
        const remotePort = parsePort(_req?.body?.remotePort ?? _req?.body?.frpcRemotePort);
        const frpcPublicUrl = typeof (_req?.body?.publicUrl ?? _req?.body?.frpcPublicUrl) === 'string'
          ? (_req.body.publicUrl ?? _req.body.frpcPublicUrl).trim()
          : undefined;
        const customDomain = typeof (_req?.body?.customDomain ?? _req?.body?.frpcCustomDomain) === 'string'
          ? (_req.body.customDomain ?? _req.body.frpcCustomDomain).trim()
          : undefined;
        const frpcPublicHostname = typeof (_req?.body?.frpcPublicHostname ?? _req?.body?.hostname) === 'string'
          ? (_req.body.frpcPublicHostname ?? _req.body.hostname).trim()
          : undefined;
        const frpcEndpointExplicit = [
          'proxyType',
          'frpcProxyType',
          'remotePort',
          'frpcRemotePort',
          'publicUrl',
          'frpcPublicUrl',
          'customDomain',
          'frpcCustomDomain',
          'hostname',
          'frpcPublicHostname',
        ].some((key) => hasOwn(_req?.body, key));
        if (provider === TUNNEL_PROVIDER_FRPC) {
          hostname = frpcPublicHostname;
        }
        const requestConnectTtlMs = typeof _req?.body?.connectTtlMs === 'number' && Number.isFinite(_req.body.connectTtlMs)
          ? normalizeTunnelBootstrapTtlMs(_req.body.connectTtlMs)
          : undefined;
        const requestSessionTtlMs = typeof _req?.body?.sessionTtlMs === 'number' && Number.isFinite(_req.body.sessionTtlMs)
          ? normalizeTunnelSessionTtlMs(_req.body.sessionTtlMs)
          : undefined;
        const bootstrapTtlMs = requestConnectTtlMs ?? (settings?.tunnelBootstrapTtlMs === null
          ? null
          : normalizeTunnelBootstrapTtlMs(settings?.tunnelBootstrapTtlMs));
        const sessionTtlMs = requestSessionTtlMs ?? normalizeTunnelSessionTtlMs(settings?.tunnelSessionTtlMs);

        const previousTunnelId = tunnelAuthController.getActiveTunnelId();
        const previousMode = tunnelAuthController.getActiveTunnelMode();
        const previousProvider = tunnelService.resolveActiveProvider();
        const previousUrl = tunnelService.getPublicUrl();

        const {
          publicUrl,
          provider: activeProvider,
          providerMetadata,
          controllerReplaced,
          controller: resultController,
          controllerStarted,
        } = await startTunnelWithNormalizedRequest({
          provider,
          mode,
          intent,
          hostname,
          token,
          configPath: requestConfigPath,
          selectedPresetId,
          selectedPresetName,
          serverAddress,
          serverPort,
          trustedCaFile,
          proxyType,
          remotePort,
          publicUrl: frpcPublicUrl,
          customDomain,
          frpcEndpointExplicit,
          signal: startAbortController.signal,
        });

        const managedRemoteTunnelConfig = await readManagedRemoteTunnelConfigFromDisk();
        if (startAbortController.signal.aborted) {
          if (controllerStarted && resultController) {
            await tunnelService.stop(resultController);
          }
          throw new TunnelServiceError('startup_cancelled', 'Tunnel start was cancelled');
        }
        assertControllerStillActive(resultController);

        const replacedTunnel = Boolean(previousTunnelId) && (
          controllerReplaced
          || previousMode !== mode
          || previousProvider !== activeProvider
          || previousUrl !== publicUrl
        );
        let revokedBootstrapCount = 0;
        let invalidatedSessionCount = 0;
        if (replacedTunnel && previousTunnelId) {
          const revoked = tunnelAuthController.revokeTunnelArtifacts(previousTunnelId);
          revokedBootstrapCount = revoked.revokedBootstrapCount;
          invalidatedSessionCount = revoked.invalidatedSessionCount;
        }

        tunnelAuthController.setActiveTunnel({
          tunnelId: replacedTunnel || !previousTunnelId ? crypto.randomUUID() : previousTunnelId,
          publicUrl,
          mode,
        });

        const bootstrapToken = tunnelAuthController.issueBootstrapToken({ ttlMs: bootstrapTtlMs });
        const connectUrl = `${publicUrl.replace(/\/$/, '')}/connect?t=${encodeURIComponent(bootstrapToken.token)}`;
        const isCloudflareProvider = activeProvider === TUNNEL_PROVIDER_CLOUDFLARE;
        const activeFrpcProxyType = activeProvider === TUNNEL_PROVIDER_FRPC
          ? (providerMetadata?.proxyType
            || (providerMetadata?.customDomain ? 'http' : (providerMetadata?.remotePort != null ? 'tcp' : null)))
          : null;

        return res.json({
          ok: true,
          url: publicUrl,
          mode,
          provider: activeProvider,
          providerMetadata,
          managedRemoteTunnelHostname: isCloudflareProvider ? (hostname || null) : null,
          managedRemoteTunnelTokenPresetIds: isCloudflareProvider ? managedRemoteTunnelConfig.tunnels.map((entry) => entry.id) : [],
          hasFrpcTunnelToken: activeProvider === TUNNEL_PROVIDER_FRPC,
          frpcServerAddress: activeProvider === TUNNEL_PROVIDER_FRPC ? providerMetadata?.serverAddress ?? null : null,
          frpcServerPort: activeProvider === TUNNEL_PROVIDER_FRPC ? providerMetadata?.serverPort ?? null : null,
          frpcTrustedCaFile: activeProvider === TUNNEL_PROVIDER_FRPC ? providerMetadata?.trustedCaFile ?? null : null,
          frpcRemotePort: activeFrpcProxyType === 'tcp'
            ? providerMetadata?.remotePort ?? null
            : null,
          frpcPublicUrl: activeFrpcProxyType === 'tcp'
            ? publicUrl
            : null,
          frpcProxyType: activeFrpcProxyType,
          frpcCustomDomain: activeFrpcProxyType === 'http'
            ? providerMetadata?.customDomain ?? null
            : null,
          frpcPublicHostname: activeFrpcProxyType === 'http'
            ? providerMetadata?.hostname ?? null
            : null,
          connectUrl,
          bootstrapExpiresAt: bootstrapToken.expiresAt,
          replacedTunnel,
          replaced: replacedTunnel
            ? {
              mode: previousMode,
              provider: previousProvider,
              url: previousUrl,
            }
            : null,
          revokedBootstrapCount,
          invalidatedSessionCount,
          policy: 'tunnel-gated',
          activeTunnelMode: mode,
          activeSessions: tunnelAuthController.listTunnelSessions(),
          localPort: getActivePort(),
          ttlConfig: {
            bootstrapTtlMs,
            sessionTtlMs,
          },
        });
      } catch (error) {
        console.error('Failed to start tunnel:', error);
        if (!tunnelService.getPublicUrl()) {
          tunnelAuthController.clearActiveTunnel();
        }
        if (error instanceof TunnelServiceError) {
          const status = error.code === 'missing_dependency'
            ? 400
            : (error.code === 'validation_error' || error.code === 'provider_unsupported' || error.code === 'mode_unsupported'
              ? 422
              : 500);
          return res.status(status).json({ ok: false, error: error.message, code: error.code });
        }
        return res.status(500).json({ ok: false, error: 'Failed to start tunnel', code: 'startup_failed' });
      } finally {
        _req?.off?.('aborted', abortStart);
        res?.off?.('close', abortOnResponseClose);
      }
    });

    app.post('/api/openchamber/tunnel/stop', async (_req, res) => {
      if (!isTunnelManagementAllowed(_req)) {
        return sendHostOnlyResponse(res);
      }
      try {
        if (getActiveTunnelController()) {
          console.log('Stopping active tunnel (user requested)...');
        }
        await tunnelService.stop();

        let revokedBootstrapCount = 0;
        let invalidatedSessionCount = 0;
        const activeTunnelId = tunnelAuthController.getActiveTunnelId();
        if (activeTunnelId) {
          const revoked = tunnelAuthController.revokeTunnelArtifacts(activeTunnelId);
          revokedBootstrapCount = revoked.revokedBootstrapCount;
          invalidatedSessionCount = revoked.invalidatedSessionCount;
        }
        tunnelAuthController.clearActiveTunnel();
        return res.json({ ok: true, revokedBootstrapCount, invalidatedSessionCount });
      } catch (error) {
        console.error('Failed to stop tunnel:', error);
        return res.status(500).json({
          ok: false,
          error: error instanceof Error ? error.message : 'Failed to stop tunnel',
          code: 'stop_failed',
        });
      }
    });
  };

  return {
    registerRoutes,
    startTunnelWithNormalizedRequest,
  };
};
