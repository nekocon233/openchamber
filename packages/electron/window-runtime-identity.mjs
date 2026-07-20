const normalizeValue = (value) => (
  typeof value === 'string' && value.trim() ? value.trim() : null
);

export const createWindowRuntimeIdentityController = ({
  isLocalSender,
  runtimeKeyFromConfig,
  runtimeKeyFromUrl,
}) => {
  if (
    typeof isLocalSender !== 'function'
    || typeof runtimeKeyFromConfig !== 'function'
    || typeof runtimeKeyFromUrl !== 'function'
  ) {
    throw new TypeError('Window runtime identity requires sender, config, and URL resolvers');
  }

  const isUsableWindow = (browserWindow) => Boolean(
    browserWindow
    && typeof browserWindow.isDestroyed === 'function'
    && !browserWindow.isDestroyed()
  );

  const reset = (browserWindow) => {
    if (!isUsableWindow(browserWindow)) return null;
    let runtimeKey = null;
    try {
      runtimeKey = normalizeValue(runtimeKeyFromConfig(browserWindow.__ocRuntimeConfig));
    } catch {
      runtimeKey = null;
    }
    browserWindow.__ocRuntimeKey = runtimeKey;
    return runtimeKey;
  };

  return {
    get(browserWindow) {
      if (!isUsableWindow(browserWindow)) return null;
      try {
        if (!isLocalSender(browserWindow.webContents)) {
          return normalizeValue(runtimeKeyFromUrl(
            browserWindow.webContents?.getURL?.() || '',
            browserWindow.__ocRuntimeConfig,
          ));
        }
      } catch {
        return null;
      }
      return normalizeValue(browserWindow.__ocRuntimeKey) || reset(browserWindow);
    },

    reset,

    set(browserWindow, runtimeKey) {
      if (!isUsableWindow(browserWindow)) return false;
      const normalized = normalizeValue(runtimeKey);
      if (!normalized) return false;
      browserWindow.__ocRuntimeKey = normalized;
      return true;
    },
  };
};
