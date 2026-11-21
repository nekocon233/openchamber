import type { Application, RequestHandler } from '../shared/http-contracts.js';
import { isEnterpriseMode } from '../enterprise-mode.js';
import { isNumber, isString } from '../shared/object-guards.js';
import type {
  FrpcEndpoint,
  NormalizedTunnelRouteRequest,
  TunnelRouteBody,
  TunnelRouteOperations,
  TunnelRoutesDependencies,
} from './routes.js';

export const TUNNEL_BLOCKED_ERROR = 'External tunnels are not available in enterprise mode. Pair devices on your network or through your own relay instead.';

export function createTunnelHttpRegistrar(dependencies: TunnelRoutesDependencies, operations: TunnelRouteOperations) {
  const {
    crypto,
    tunnelService,
    tunnelProviderRegistry,
    tunnelAuthController,
    hasUiPassword,
    readSettingsFromDiskMigrated,
    readManagedRemoteTunnelConfigFromDisk,
    readFrpcTunnelConfigFromDisk,
    resolveFrpcTunnelToken,
    normalizeTunnelProvider,
    normalizeTunnelMode,
    normalizeOptionalPath,
    normalizeManagedRemoteTunnelHostname,
    normalizeTunnelBootstrapTtlMs,
    normalizeTunnelSessionTtlMs,
    isSupportedTunnelMode,
    upsertManagedRemoteTunnelToken,
    resolveManagedRemoteTunnelToken,
    TUNNEL_PROVIDER_CLOUDFLARE,
    TUNNEL_PROVIDER_FRPC,
    TunnelServiceError,
    getActivePort,
    getRuntimeManagedRemoteTunnelHostname,
    getRuntimeManagedRemoteTunnelToken,
    getActiveTunnelController,
  } = dependencies;
  const {
    assertControllerStillActive,
    hasOwn,
    normalizeFrpcProxyType,
    normalizeRequestedMode,
    normalizeRequestedProvider,
    parsePort,
    resolveActiveNormalizedTunnelMode,
    resolveFrpcEndpoint,
    resolveNormalizedTunnelHost,
    resolvePreferredTunnelProvider,
    resolveSettingsFrpcEndpoint,
    runTunnelDoctor,
    startTunnelWithNormalizedRequest,
    trimmedText,
  } = operations;

  return (app: Application) => {
    app.get('/api/openchamber/tunnel/check', async (req, res) => {
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

    const handleTunnelDoctor: RequestHandler<TunnelRouteBody> = async (req, res) => {
      try {
        const params = req.query || {};
        const body = req.body || {};
        if (
          hasOwn(body, 'trustedCaFile') || hasOwn(body, 'frpcTrustedCaFile')
          || hasOwn(params, 'trustedCaFile') || hasOwn(params, 'frpcTrustedCaFile')
        ) {
          throw new TunnelServiceError('validation_error', 'FRPC trusted CA options are no longer supported; host runtime trust roots are used automatically');
        }

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
        const selectedPresetId = isString(params.managedRemoteTunnelPresetId)
          ? params.managedRemoteTunnelPresetId.trim()
          : '';
        const requestConfigPath = normalizeOptionalPath(isString(params.configPath) || params.configPath === null ? params.configPath : undefined)
          ?? normalizeOptionalPath(isString(settings?.managedLocalTunnelConfigPath) || settings?.managedLocalTunnelConfigPath === null ? settings.managedLocalTunnelConfigPath : undefined);
        const requestManagedRemoteHostname = normalizeManagedRemoteTunnelHostname(params.managedRemoteTunnelHostname);
        const requestTunnelHostname = normalizeManagedRemoteTunnelHostname(params.tunnelHostname);
        const requestHostname = normalizeManagedRemoteTunnelHostname(params.hostname);
        const hostnameFromSettings = normalizeManagedRemoteTunnelHostname(settings?.managedRemoteTunnelHostname);
        const hostname = requestHostname || requestTunnelHostname || requestManagedRemoteHostname || hostnameFromSettings;

        const requestManagedRemoteToken = isString(body.managedRemoteTunnelToken)
          ? body.managedRemoteTunnelToken.trim()
          : '';
        const requestTunnelToken = isString(body.tunnelToken)
          ? body.tunnelToken.trim()
          : '';
        const requestToken = isString(body.token)
          ? body.token.trim()
          : '';
        const requestTokenProvided = body.managedRemoteTunnelTokenProvided === true
          || body.tunnelTokenProvided === true
          || body.tokenProvided === true;
        const requestHostnameProvided = body.managedRemoteTunnelHostnameProvided === true
          || body.tunnelHostnameProvided === true
          || body.hostnameProvided === true;
        const storedManagedRemoteToken = isString(settings?.managedRemoteTunnelToken)
          ? settings.managedRemoteTunnelToken.trim()
          : '';
        const managedRemoteTunnelConfig = await readManagedRemoteTunnelConfigFromDisk();
        const serverHasSavedManagedRemoteProfile = managedRemoteTunnelConfig.tunnels.some((entry) => {
          const savedHostname = normalizeManagedRemoteTunnelHostname(entry?.hostname);
          const savedToken = entry.token.trim();
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
        const serverAddress = trimmedText(params.serverAddress ?? params.frpcServerAddress ?? storedFrpcConfig?.serverAddress ?? settings.frpcServerAddress) ?? '';
        const serverPort = parsePort(rawServerPort);
        const endpointInput = {
          proxyType: normalizeFrpcProxyType(body.proxyType ?? body.frpcProxyType ?? params.proxyType ?? params.frpcProxyType),
          remotePort: parsePort(body.remotePort ?? body.frpcRemotePort ?? params.remotePort ?? params.frpcRemotePort),
          publicUrl: trimmedText(body.publicUrl ?? body.frpcPublicUrl ?? params.publicUrl ?? params.frpcPublicUrl),
          customDomain: trimmedText(body.customDomain ?? body.frpcCustomDomain ?? params.customDomain ?? params.frpcCustomDomain),
          hostname: trimmedText(body.frpcPublicHostname ?? body.hostname ?? params.frpcPublicHostname ?? params.hostname),
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

    app.get('/api/openchamber/tunnel/providers', (_req, res) => {
      return res.json({ providers: tunnelProviderRegistry.listCapabilities() });
    });

    app.get('/api/openchamber/tunnel/status', async (req, res) => {
      try {
        const settings = await readSettingsFromDiskMigrated();
        const normalizedMode = normalizeTunnelMode(isString(settings?.tunnelMode) ? settings.tunnelMode : undefined);
        const managedRemoteHostname = normalizeManagedRemoteTunnelHostname(settings?.managedRemoteTunnelHostname);
        const managedRemoteTunnelConfig = await readManagedRemoteTunnelConfigFromDisk();
        const managedRemoteTunnelPresetSummaries = managedRemoteTunnelConfig.tunnels.map((entry) => ({
          id: entry.id,
          name: entry.name,
          hostname: entry.hostname,
        }));
        const hasStoredManagedRemoteToken = isString(settings?.managedRemoteTunnelToken) && settings.managedRemoteTunnelToken.trim().length > 0;
        const hasManagedRemoteTunnelToken = getRuntimeManagedRemoteTunnelToken().length > 0 || managedRemoteTunnelConfig.tunnels.length > 0 || hasStoredManagedRemoteToken;
        const bootstrapTtlMs = settings?.tunnelBootstrapTtlMs === null
          ? null
          : normalizeTunnelBootstrapTtlMs(settings?.tunnelBootstrapTtlMs);
        const sessionTtlMs = normalizeTunnelSessionTtlMs(settings?.tunnelSessionTtlMs);
        const activeSessions = tunnelAuthController.listTunnelSessions();
        const activeProvider = tunnelService.resolveActiveProvider();
        const provider = activeProvider || normalizeTunnelProvider(isString(settings?.tunnelProvider) ? settings.tunnelProvider : undefined);

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
        let configuredFrpcEndpoint: (FrpcEndpoint & Pick<NormalizedTunnelRouteRequest, 'serverAddress' | 'serverPort'>) | null = frpcTunnelConfig;
        if (frpcConfigStatus === 'missing') {
          try {
            configuredFrpcEndpoint = {
              serverAddress: trimmedText(settings.frpcServerAddress),
              serverPort: parsePort(settings.frpcServerPort),
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
            enterpriseMode: isEnterpriseMode(),
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
            frpcRemotePort,
            frpcPublicUrl,
            frpcProxyType,
            frpcCustomDomain,
            frpcPublicHostname,
            frpcConfigStatus,
            frpcConfigError,
            hasBootstrapToken: false,
            bootstrapExpiresAt: null,
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
          frpcRemotePort,
          frpcPublicUrl,
          frpcProxyType,
          frpcCustomDomain,
          frpcPublicHostname,
          frpcConfigStatus,
          frpcConfigError,
          hasBootstrapToken: bootstrapStatus.hasBootstrapToken,
          bootstrapExpiresAt: bootstrapStatus.bootstrapExpiresAt,
          activeTunnelMode: activeNormalizedMode,
          activeSessions: tunnelAuthController.listTunnelSessions(),
          localPort: getActivePort(),
          ttlConfig: {
            bootstrapTtlMs,
            sessionTtlMs,
          },
        });
      } catch {
        return res.status(500).json({ error: 'Failed to get tunnel status' });
      }
    });

    app.put<TunnelRouteBody>('/api/openchamber/tunnel/managed-remote-token', async (req, res) => {
      try {
        const presetId = isString(req?.body?.presetId) ? req.body.presetId.trim() : '';
        const presetName = isString(req?.body?.presetName) ? req.body.presetName.trim() : '';
        const managedRemoteTunnelHostname = normalizeManagedRemoteTunnelHostname(req?.body?.managedRemoteTunnelHostname);
        const managedRemoteTunnelToken = isString(req?.body?.managedRemoteTunnelToken) ? req.body.managedRemoteTunnelToken.trim() : '';

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
      } catch {
        return res.status(500).json({ ok: false, error: 'Failed to save managed remote tunnel token' });
      }
    });

    app.post<TunnelRouteBody>('/api/openchamber/tunnel/start', async (_req, res) => {
      if (isEnterpriseMode()) {
        return res.status(403).json({ ok: false, code: 'enterprise_mode', error: TUNNEL_BLOCKED_ERROR });
      }
      if (!hasUiPassword) {
        return res.status(403).json({ ok: false, code: 'ui_password_required', error: 'A UI password is required before starting a public tunnel. Restart OpenChamber with --ui-password.' });
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
        if (hasOwn(_req?.body, 'trustedCaFile') || hasOwn(_req?.body, 'frpcTrustedCaFile')) {
          throw new TunnelServiceError('validation_error', 'FRPC trusted CA options are no longer supported; host runtime trust roots are used automatically');
        }
        const settings = await readSettingsFromDiskMigrated();
        const providerExplicit = hasOwn(_req?.body, 'provider') && _req.body.provider !== undefined;
        const provider = providerExplicit
          ? normalizeRequestedProvider(_req.body.provider)
          : normalizeTunnelProvider(isString(settings?.tunnelProvider) ? settings.tunnelProvider : undefined);
        const providerCapabilities = tunnelProviderRegistry.get(provider)?.capabilities;
        if (!providerCapabilities) {
          throw new TunnelServiceError('provider_unsupported', `Unsupported tunnel provider: ${provider}`);
        }
        const providerDefaultMode = providerCapabilities?.defaults?.mode;
        const modeExplicit = hasOwn(_req?.body, 'mode') && _req.body.mode !== undefined;
        const configuredMode = normalizeTunnelMode(isString(settings?.tunnelMode) ? settings.tunnelMode : undefined);
        const providerSupportsConfiguredMode = providerCapabilities?.modes?.some((entry) => entry?.key === configuredMode);
        const modeInput = modeExplicit
          ? normalizeRequestedMode(_req.body.mode)
          : (providerSupportsConfiguredMode ? configuredMode : providerDefaultMode);
        const intent = isString(_req?.body?.intent) ? _req.body.intent.trim().toLowerCase() : undefined;
        const mode = isString(modeInput)
          ? modeInput.trim().toLowerCase()
          : normalizeTunnelMode(modeInput);
        if (!isSupportedTunnelMode(mode) || !providerCapabilities.modes?.some((entry) => entry?.key === mode)) {
          throw new TunnelServiceError('mode_unsupported', `Provider '${provider}' does not support mode '${mode}'`);
        }
        const selectedPresetId = isString(_req?.body?.managedRemoteTunnelPresetId) ? _req.body.managedRemoteTunnelPresetId.trim() : '';
        const selectedPresetName = isString(_req?.body?.managedRemoteTunnelPresetName) ? _req.body.managedRemoteTunnelPresetName.trim() : '';
        const requestConfigPath = normalizeOptionalPath(isString(_req?.body?.configPath) || _req?.body?.configPath === null ? _req.body.configPath : undefined)
          ?? normalizeOptionalPath(isString(settings?.managedLocalTunnelConfigPath) || settings?.managedLocalTunnelConfigPath === null ? settings.managedLocalTunnelConfigPath : undefined);
        const requestManagedRemoteHostname = normalizeManagedRemoteTunnelHostname(_req?.body?.managedRemoteTunnelHostname);
        const requestTunnelHostname = normalizeManagedRemoteTunnelHostname(_req?.body?.tunnelHostname);
        const requestHostname = normalizeManagedRemoteTunnelHostname(_req?.body?.hostname);
        const hostnameFromSettings = normalizeManagedRemoteTunnelHostname(settings?.managedRemoteTunnelHostname);
        let hostname = requestHostname || requestTunnelHostname || requestManagedRemoteHostname || hostnameFromSettings;
        const requestManagedRemoteToken = isString(_req?.body?.managedRemoteTunnelToken) ? _req.body.managedRemoteTunnelToken.trim() : '';
        const requestTunnelToken = isString(_req?.body?.tunnelToken) ? _req.body.tunnelToken.trim() : '';
        const requestToken = isString(_req?.body?.token) ? _req.body.token.trim() : '';
        const storedManagedRemoteToken = isString(settings?.managedRemoteTunnelToken) ? settings.managedRemoteTunnelToken.trim() : '';
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
        const serverAddress = trimmedText(_req?.body?.serverAddress ?? _req?.body?.frpcServerAddress);
        const serverPort = parsePort(_req?.body?.serverPort ?? _req?.body?.frpcServerPort);
        const proxyType = normalizeFrpcProxyType(_req?.body?.proxyType ?? _req?.body?.frpcProxyType);
        const remotePort = parsePort(_req?.body?.remotePort ?? _req?.body?.frpcRemotePort);
        const frpcPublicUrl = trimmedText(_req?.body?.publicUrl ?? _req?.body?.frpcPublicUrl);
        const customDomain = trimmedText(_req?.body?.customDomain ?? _req?.body?.frpcCustomDomain);
        const frpcPublicHostname = trimmedText(_req?.body?.frpcPublicHostname ?? _req?.body?.hostname);
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
        const requestConnectTtlMs = isNumber(_req?.body?.connectTtlMs) && Number.isFinite(_req.body.connectTtlMs)
          ? normalizeTunnelBootstrapTtlMs(_req.body.connectTtlMs)
          : undefined;
        const requestSessionTtlMs = isNumber(_req?.body?.sessionTtlMs) && Number.isFinite(_req.body.sessionTtlMs)
          ? normalizeTunnelSessionTtlMs(_req.body.sessionTtlMs)
          : undefined;
        const bootstrapTtlMs = requestConnectTtlMs ?? (settings?.tunnelBootstrapTtlMs === null
          ? null
          : normalizeTunnelBootstrapTtlMs(settings?.tunnelBootstrapTtlMs));
        const sessionTtlMs = requestSessionTtlMs ?? normalizeTunnelSessionTtlMs(settings?.tunnelSessionTtlMs);
        const allowedHttpsPorts = tunnelProviderRegistry.get(provider)?.capabilities?.modes
          ?.find((entry) => entry.key === mode)?.httpsPorts ?? [];
        const savedHttpsPort = isNumber(settings?.tunnelHttpsPort) && allowedHttpsPorts.includes(settings.tunnelHttpsPort) ? settings.tunnelHttpsPort : undefined;
        const httpsPort = _req?.body?.httpsPort ?? savedHttpsPort;

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
          httpsPort,
          selectedPresetId,
          selectedPresetName,
          serverAddress,
          serverPort,
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
          return res.status(status).json({
            ok: false,
            error: error.message,
            code: error.code,
            approvalUrl: error.details?.approvalUrl,
          });
        }
        return res.status(500).json({ ok: false, error: 'Failed to start tunnel', code: 'startup_failed' });
      } finally {
        _req?.off?.('aborted', abortStart);
        res?.off?.('close', abortOnResponseClose);
      }
    });

    app.post('/api/openchamber/tunnel/stop', async (_req, res) => {
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
}
