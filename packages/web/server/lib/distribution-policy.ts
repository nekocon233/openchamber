export interface DistributionPolicy {
  readonly id: string;
  readonly repositoryUrl: string;
  readonly webUpdateMode: 'external' | 'self-update';
}

export const DISTRIBUTION_POLICY: DistributionPolicy = Object.freeze({
  id: 'nekocon233/openchamber',
  repositoryUrl: 'https://github.com/nekocon233/openchamber',
  webUpdateMode: 'external',
});
