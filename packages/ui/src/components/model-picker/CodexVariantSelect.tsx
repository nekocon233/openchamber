import { Icon } from '@/components/icon/Icon';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import { CODEX_SPEED_TIERS, codexVariantId, codexVariantSettings, codexVariantLabel } from '@/lib/native-agents/codex-speed';

type Props = {
  field: 'effort' | 'speed';
  variants: readonly string[];
  variant: string | null | undefined;
  onChange: (variant: string | undefined) => void;
  label?: string;
  className?: string;
  toolbar?: boolean;
  disabled?: boolean;
};

/** Both fields edit the same saved variant. Each option changes only its own part. */
export function CodexVariantSelect({ field, variants, variant, onChange, label, className, toolbar, disabled }: Props) {
  const { t } = useI18n();
  const { effort, suffix, serviceTier, speedName } = codexVariantSettings(variant);
  const thinking = field === 'effort';
  const title = label ?? t(thinking ? 'chat.modelControls.thinking' : 'chat.modelControls.speed');
  const efforts = variants.filter((id) => id !== 'default' && !codexVariantSettings(id).suffix);
  const speeds = CODEX_SPEED_TIERS.filter((tier) => variants.some((id) => id.endsWith(tier.suffix)));
  // A saved pair can outlive a catalog entry. Keep showing it until a pick,
  // then retain the other dimension if the model still offers it.
  const retainedEffort = effort && efforts.includes(effort) ? effort : undefined;
  const retainedSuffix = speeds.some((tier) => tier.suffix === suffix) ? suffix : '';
  const options = thinking
    ? [undefined, ...efforts].map((level) => ({
        id: level ?? 'default',
        label: codexVariantLabel(level, t('chat.modelControls.default')),
        variant: codexVariantId(level, retainedSuffix, variants),
      }))
    : [
        { id: 'default', label: t('chat.modelControls.standardSpeed'), variant: codexVariantId(retainedEffort, '', variants) },
        ...speeds.map((tier) => ({
          id: tier.serviceTier, label: tier.name, variant: codexVariantId(retainedEffort, tier.suffix, variants),
        })),
      ];
  const selected = options.find((option) => option.id === (thinking ? effort ?? 'default' : serviceTier));
  const value = selected?.label ?? (thinking ? effort : speedName);
  const unavailable = (id: string | undefined) => id !== undefined && !variants.includes(id);
  const locked = disabled || (options.length === 1 && selected !== undefined);
  if (toolbar) {
    const icon = thinking ? 'brain-ai-3' : 'flashlight';
    const iconColor = thinking ? 'text-[var(--info-text)]' : 'text-[var(--primary-text)]';
    return <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={`model-controls__${thinking ? 'variant' : 'speed'}-trigger inline-flex h-8 min-w-0 items-center gap-1.5 typography-micro text-foreground hover:opacity-70 disabled:text-muted-foreground`}
          aria-label={`${title}: ${value}`} title={title} disabled={locked}>
          <Icon name={icon} className={`size-4 shrink-0 ${locked ? 'text-muted-foreground' : iconColor}`} />
          <span className="truncate">{value}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="min-w-36 overflow-y-auto">
        <DropdownMenuLabel>{title}</DropdownMenuLabel>
        {options.map((option) => <DropdownMenuItem key={option.id} disabled={unavailable(option.variant)} onSelect={() => onChange(option.variant)}>
          {option.label}{option === selected && <Icon name="check" className="ms-auto size-4" />}
        </DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>;
  }
  return <Select disableGlobalShortcuts value={selected?.id ?? ''} disabled={locked} onValueChange={(id) => {
    const choice = options.find((option) => option.id === id);
    if (choice && !unavailable(choice.variant)) onChange(choice.variant);
  }}>
    <SelectTrigger className={className} aria-label={title}><SelectValue>{value}</SelectValue></SelectTrigger>
    <SelectContent>{options.map((option) => <SelectItem key={option.id} value={option.id} disabled={unavailable(option.variant)}>{option.label}</SelectItem>)}</SelectContent>
  </Select>;
}

export function CodexVariantFields({ rows, ...props }: Omit<Props, 'field' | 'label'> & { rows?: boolean }) {
  const { t } = useI18n();
  return <>{(['effort', 'speed'] as const).map((field) => rows ? (
    <label key={field} className="flex items-center justify-between gap-3 px-2 py-1 typography-meta text-muted-foreground">
      {t(field === 'effort' ? 'chat.modelControls.thinking' : 'chat.modelControls.speed')}
      <CodexVariantSelect field={field} {...props} />
    </label>
  ) : <CodexVariantSelect key={field} field={field} {...props} />)}</>;
}
