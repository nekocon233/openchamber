import type { WorkStatusSectionId } from './sections';

const EMPTY_UNAVAILABLE: readonly WorkStatusSectionId[] = [];

export const useUnavailableWorkStatusSections = (): readonly WorkStatusSectionId[] => EMPTY_UNAVAILABLE;
