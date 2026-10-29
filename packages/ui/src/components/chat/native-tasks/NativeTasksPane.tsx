import React from 'react';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { isNativeSessionId, nativeBackendOfSessionId } from '@/lib/native-agents/ids';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { NativeTasksBody } from './NativeTasksBody';
import { useNativeTasksUIStore } from './task-ui-store';

/**
 * The context-panel surface for the native CLIs' task views. It follows the
 * currently selected session; the panel itself owns tab and visibility
 * lifecycle, and the body decides which views the session's backend has. On
 * mobile the workspace drawer hosts the same body and passes `onClose` so a
 * child-session link can dismiss the drawer.
 */
export function NativeTasksPane({ onClose }: { onClose?: () => void }) {
  const { t } = useI18n();
  const { nativeAgents } = useRuntimeAPIs();
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const sessionDirectory = useSessionUIStore(
    React.useCallback((state) => (currentSessionId ? state.getDirectoryForSession(currentSessionId) : null), [currentSessionId]),
  );
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const directory = sessionDirectory || currentDirectory || null;
  const runtimeGeneration = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const tab = useNativeTasksUIStore((state) => state.tab);

  const unsupportedBackend = currentSessionId ? nativeBackendOfSessionId(currentSessionId) === 'antigravity' : false;
  const eligible = Boolean(currentSessionId && directory
    && isNativeSessionId(currentSessionId)
    && !unsupportedBackend
    && nativeAgents.supported);

  if (!eligible || !currentSessionId || !directory) {
    const reason = !nativeAgents.supported || unsupportedBackend
      ? t('chat.nativeTasks.unsupported')
      : t('chat.nativeTasks.notNative');
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 p-6 text-center">
        <p className="text-sm text-muted-foreground">{reason}</p>
      </div>
    );
  }

  return (
    <NativeTasksBody
      key={`${runtimeGeneration}:${directory}:${currentSessionId}`}
      scope={{ sessionId: currentSessionId, directory, runtimeGeneration, tab }}
      onClose={onClose}
    />
  );
}
