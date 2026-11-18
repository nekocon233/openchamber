export const CODEX_SPEED_TIERS = [
  { suffix: '-fast', serviceTier: 'priority', name: 'Fast' },
  { suffix: '-ultrafast', serviceTier: 'ultrafast', name: 'Ultrafast' },
] as const;

export const codexVariantSettings = (variant: string | null | undefined) => {
  const speed = CODEX_SPEED_TIERS.find(({ suffix }) => variant?.endsWith(suffix));
  const effort = speed ? variant?.slice(0, -speed.suffix.length) : variant;
  return {
    effort: effort === 'default' ? undefined : effort ?? undefined,
    suffix: speed?.suffix ?? '',
    serviceTier: speed?.serviceTier ?? 'default',
    speedName: speed?.name,
  } as const;
};

export const codexVariantLabel = (variant: string | null | undefined, defaultLabel: string, standardLabel?: string) => {
  const { effort, speedName } = codexVariantSettings(variant);
  const label = effort ? effort.charAt(0).toUpperCase() + effort.slice(1) : defaultLabel;
  const speed = speedName ?? standardLabel;
  return speed ? `${label} · ${speed}` : label;
};

type SpeedSuffix = typeof CODEX_SPEED_TIERS[number]['suffix'] | '';

export const codexVariantId = (effort: string | undefined, suffix: SpeedSuffix, variants: readonly string[]): string | undefined =>
  suffix ? `${effort ?? 'default'}${suffix}` : effort ?? (variants.includes('default') ? 'default' : undefined);

/** Effort shortcuts stay on the current speed, including at the CLI default. */
export const codexEffortCycle = (variants: readonly string[], current: string | null | undefined): (string | undefined)[] => {
  const { suffix } = codexVariantSettings(current);
  const choices = [undefined, ...variants.filter((id) => id !== 'default' && !codexVariantSettings(id).suffix)];
  return choices.map((effort) => codexVariantId(effort, suffix, variants)).filter((id) => id === undefined || variants.includes(id));
};
