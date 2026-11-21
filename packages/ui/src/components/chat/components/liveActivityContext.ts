import { createContext } from 'react';

import type { ShownPart } from '../lib/turns/liveActivity';

export const LiveFinalActivityContext = createContext<{
    messageId: string;
    expanded: boolean;
    contentId: string;
    pages: readonly ShownPart[];
} | null>(null);

export const LiveTurnHoistedPagesContext = createContext<ReadonlySet<string> | null>(null);

/** The final plan is drawn outside Activity; its original rows stay in the record. */
export const LiveTurnHoistedPlanContext = createContext<ReadonlySet<string> | null>(null);
