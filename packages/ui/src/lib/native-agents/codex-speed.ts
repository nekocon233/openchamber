export const CODEX_SPEED_TIERS = [
  { suffix: '-fast', serviceTier: 'priority' },
  { suffix: '-ultrafast', serviceTier: 'ultrafast' },
] as const;

export const codexVariantSettings = (variant: string | undefined) => {
  const speed = CODEX_SPEED_TIERS.find(({ suffix }) => variant?.endsWith(suffix));
  return {
    effort: speed ? variant?.slice(0, -speed.suffix.length) : variant,
    suffix: speed?.suffix ?? '',
    serviceTier: speed?.serviceTier ?? 'default',
  };
};
