import type { SourceControlProviderDescriptor } from './descriptor';

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
