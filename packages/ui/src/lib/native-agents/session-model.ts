import { parseModelIdentifier } from '@/lib/modelIdentifier';
import { isNativeProviderId, nativeBackendOfProviderId, nativeBackendOfSessionId, nativeProviderIdOf } from './ids';

type PickerProvider = { id: string; models: Array<{ id: string }> };

/**
 * The model a session has to switch to because the selected one belongs to
 * the other kind of session, or null when the selection fits. A native session
 * takes its CLI's first model. An OpenCode session takes the default model
 * from settings when that is an OpenCode model, else the first OpenCode model.
 */
export const modelForSessionKind = ({ sessionId, selectedProviderId, providers, defaultModel }: {
  sessionId: string;
  selectedProviderId: string;
  providers: readonly PickerProvider[];
  defaultModel: string | undefined;
}): { providerId: string; modelId: string } | null => {
  const sessionBackend = nativeBackendOfSessionId(sessionId);
  const selectedBackend = selectedProviderId ? nativeBackendOfProviderId(selectedProviderId) : null;
  if (sessionBackend === selectedBackend) return null;

  if (sessionBackend) {
    const provider = providers.find((entry) => entry.id === nativeProviderIdOf(sessionBackend));
    const model = provider?.models[0];
    return provider && model ? { providerId: provider.id, modelId: model.id } : null;
  }

  const preferred = parseModelIdentifier(defaultModel);
  if (preferred && !isNativeProviderId(preferred.providerId)) {
    const available = providers.some((provider) => provider.id === preferred.providerId
      && provider.models.some((model) => model.id === preferred.modelId));
    if (available) return preferred;
  }
  const provider = providers.find((entry) => !isNativeProviderId(entry.id) && entry.models.length > 0);
  return provider ? { providerId: provider.id, modelId: provider.models[0].id } : null;
};
