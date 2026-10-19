import React, { type ComponentProps } from 'react';
import { useDeviceInfo } from '@/lib/device';
import type { FinalPlan } from '../planPart';
import { usePlanExpansion } from '../planExpansion';
import ToolPart from './ToolPart';

type Props = Omit<ComponentProps<typeof ToolPart>, 'isExpanded' | 'onToggle'> & {
    callID: string;
    defaultExpanded: boolean;
};

/** The plan has one disclosure owner even when its visible representation changes. */
export function PlanToolPart({ callID, defaultExpanded, ...props }: Props) {
    const { expanded, toggle } = usePlanExpansion(props.part.sessionID, props.part.messageID, callID, defaultExpanded);
    return <ToolPart {...props} isExpanded={expanded} onToggle={toggle} />;
}

export function FinalPlanCard({ plan }: { plan: FinalPlan }) {
    const { isMobile, isTablet } = useDeviceInfo();
    return <div className="chat-message-column mb-2" data-final-plan={plan.part.id}>
        <PlanToolPart part={plan.part} callID={plan.callID} defaultExpanded isMobile={isMobile}
            alwaysShowActions={isMobile || isTablet} />
    </div>;
}
