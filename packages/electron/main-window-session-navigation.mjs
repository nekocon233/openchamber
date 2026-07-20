const normalizeValue = (value) => (
  typeof value === 'string' && value.trim() ? value.trim() : null
);

export const createMainWindowSessionNavigation = ({ getMainWindow, getWindowRuntimeKey, emitToWindow }) => {
  if (
    typeof getMainWindow !== 'function'
    || typeof getWindowRuntimeKey !== 'function'
    || typeof emitToWindow !== 'function'
  ) {
    throw new TypeError('Main-window session navigation requires window, runtime, and emit callbacks');
  }

  const readyWindows = new WeakSet();
  let pending = null;

  const isCurrentMainWindow = (browserWindow) => {
    const mainWindow = getMainWindow();
    return Boolean(
      browserWindow
      && mainWindow === browserWindow
      && typeof browserWindow.isDestroyed === 'function'
      && !browserWindow.isDestroyed()
    );
  };

  const flush = (browserWindow = getMainWindow()) => {
    if (!pending || !isCurrentMainWindow(browserWindow) || !readyWindows.has(browserWindow)) {
      return false;
    }

    if (pending.runtimeKey) {
      let currentRuntimeKey = null;
      try {
        currentRuntimeKey = normalizeValue(getWindowRuntimeKey(browserWindow));
      } catch {
        currentRuntimeKey = null;
      }
      if (!currentRuntimeKey) return false;
      if (currentRuntimeKey !== pending.runtimeKey) {
        pending = null;
        return false;
      }
    }

    const detail = pending;
    pending = null;
    emitToWindow(browserWindow, 'openchamber:open-session', detail);
    return true;
  };

  return {
    queue(sessionId, directory, runtimeKey) {
      const normalizedSessionId = normalizeValue(sessionId);
      if (!normalizedSessionId) return false;
      const normalizedRuntimeKey = normalizeValue(runtimeKey);
      pending = {
        sessionId: normalizedSessionId,
        directory: normalizeValue(directory),
        ...(normalizedRuntimeKey ? { runtimeKey: normalizedRuntimeKey } : {}),
      };
      return true;
    },

    markLoading(browserWindow) {
      if (browserWindow && typeof browserWindow === 'object') {
        readyWindows.delete(browserWindow);
      }
    },

    markReady(browserWindow) {
      if (!isCurrentMainWindow(browserWindow)) return false;
      readyWindows.add(browserWindow);
      return flush(browserWindow);
    },

    flush,
  };
};
