import type { SourceControlProviderDescriptor } from './descriptor';

/** How the provider addresses a change request in text: `#12`, `!12`. */
export const formatChangeRequestReference = (
  descriptor: SourceControlProviderDescriptor | string | null | undefined,
  number: number,
): string => {
  if (!descriptor || typeof descriptor === 'string') {
    const prefix = descriptor === 'gitlab' ? '!' : '#';
    return `${prefix}${number}`;
  }
  return `${descriptor.terminology.changeRequestPrefix}${number}`;
};

/**
 * A change request's short label. Where issues and change requests share a
 * prefix the abbreviation tells them apart ("PR #12"); a prefix of its own
 * already does ("!12").
 */
export const formatChangeRequestLabel = (
  descriptor: SourceControlProviderDescriptor | string | null | undefined,
  number: number,
): string => {
  if (!descriptor || typeof descriptor === 'string') {
    return descriptor === 'gitlab' ? `!${number}` : `PR #${number}`;
  }
  const { abbreviation, changeRequestPrefix, issuePrefix } = descriptor.terminology;
  return changeRequestPrefix === issuePrefix
    ? `${abbreviation} ${changeRequestPrefix}${number}`
    : `${changeRequestPrefix}${number}`;
};
