import React from 'react';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { useConfigStore } from '@/stores/useConfigStore';
import { nativeAgentModelSchema, type NativeAgentModel } from '@/lib/native-agents/combinations';
import { isNativeProviderId } from '@/lib/native-agents/ids';
import { listModelVariantIds, preferredModelVariant } from '@/lib/modelVariants';
import { useI18n } from '@/lib/i18n';

export const NativeAgentModelPicker = ({ label, value, onChange, nullable = false, disabled = false }: {
  label: string; value: NativeAgentModel | null; onChange: (value: NativeAgentModel | null) => void; nullable?: boolean; disabled?: boolean;
}) => {
  const { t } = useI18n();
  const providers = useConfigStore((state) => state.providers);
  const model = providers.find((provider) => provider.id === value?.model.providerID)?.models.find((model) => model.id === value?.model.modelID);
  const variants = listModelVariantIds(model?.variants);
  return <div role="group" aria-label={label} className="flex min-w-0 flex-wrap items-center gap-2" aria-disabled={disabled}>
    <div className={disabled ? 'pointer-events-none opacity-50' : ''}>
      <ModelSelector providerId={value?.model.providerID ?? ''} modelId={value?.model.modelID ?? ''} allowNativeModels
        disabled={disabled}
        isModelAllowed={isNativeProviderId}
        allowedProviderIds={providers.filter((provider) => isNativeProviderId(provider.id)).map((provider) => provider.id)}
        placeholder={nullable ? t('agents.combinations.nativeDefault') : undefined}
        onChange={(providerID, modelID) => {
          if (!providerID || !modelID) { onChange(null); return; }
          const target = providers.find((provider) => provider.id === providerID)?.models.find((model) => model.id === modelID);
          onChange(nativeAgentModelSchema.parse({ model: { providerID, modelID }, variant: preferredModelVariant(listModelVariantIds(target?.variants)) }));
        }} />
    </div>
    {value && variants.length ? <Select value={value.variant ?? '__default__'} onValueChange={(variant) => onChange({ ...value, variant: variant === '__default__' ? undefined : variant })} disabled={disabled}>
      <SelectTrigger className="w-24" aria-label={t('settings.openchamber.defaults.field.defaultThinking')}><SelectValue /></SelectTrigger>
      <SelectContent><SelectItem value="__default__">{t('agents.combinations.nativeDefault')}</SelectItem>{variants.map((variant) => <SelectItem key={variant} value={variant}>{variant}</SelectItem>)}</SelectContent>
    </Select> : null}
    {nullable && value ? <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => onChange(null)}>{t('agents.combinations.reset')}</Button> : null}
  </div>;
};
