import React from 'react';
import { nativeBackendOfSessionId } from '@/lib/native-agents/ids';
import { WorkStatusGoalRow } from './WorkStatusGoalRow';
import { WorkStatusPrimaryGroup } from './WorkStatusPrimaryGroup';
import { WorkStatusUsageSection } from './WorkStatusUsageSection';
import { WorkStatusTelemetrySection } from './WorkStatusTelemetrySection';
import { WorkStatusSubagentsSection } from './WorkStatusSubagentsSection';
import { WorkStatusTodosSection } from './WorkStatusTodosSection';
import { WorkStatusChecklistSection } from './WorkStatusChecklistSection';
import { WorkStatusBackgroundTasksSection } from './WorkStatusBackgroundTasksSection';
import { WorkStatusPlanSection } from './WorkStatusPlanSection';
import { WorkStatusMcpSection } from './WorkStatusMcpSection';
import { WorkStatusPinnedSection } from './WorkStatusPinnedSection';
import { WorkStatusContextSection } from './WorkStatusContextSection';
import { WorkStatusExtensionSection } from './WorkStatusExtensionSection';
import { isExtensionSectionId, isWorkStatusSectionVisible, type WorkStatusSectionId } from './sections';
import type { WorkStatusSectionLayout } from './useWorkStatusSectionLayout';

export const WorkStatusSectionList: React.FC<{
  sessionId: string | null;
  directory: string | null;
  repositoryEnabled: boolean;
  layout: WorkStatusSectionLayout;
  visible?: boolean;
}> = ({ sessionId, directory, repositoryEnabled, layout, visible = true }) => {
  const { extensionSections, sectionOrder, hiddenSections } = layout;
  const sectionVisible = (id: Parameters<typeof isWorkStatusSectionVisible>[1]) => isWorkStatusSectionVisible(hiddenSections, id);
  const nativeBackend = nativeBackendOfSessionId(sessionId ?? '');

  const secondarySections = {
    usage: <WorkStatusUsageSection visible={visible} />,
    telemetry: <WorkStatusTelemetrySection sessionId={sessionId} directory={directory} />,
    subagents: <WorkStatusSubagentsSection sessionId={sessionId} directory={directory} />,
    taskChecklist: nativeBackend === 'codex'
      ? <WorkStatusTodosSection sessionId={sessionId} directory={directory} />
      : <WorkStatusChecklistSection sessionId={sessionId} directory={directory} />,
    taskBackground: <WorkStatusBackgroundTasksSection sessionId={sessionId} directory={directory} />,
    mcp: <WorkStatusMcpSection sessionId={sessionId} directory={directory} />,
    pinned: <WorkStatusPinnedSection sessionId={sessionId} directory={directory} />,
    contextSources: <WorkStatusContextSection sessionId={sessionId} directory={directory} />,
    taskPlan: <WorkStatusPlanSection sessionId={sessionId} directory={directory} />,
  } satisfies Record<Exclude<WorkStatusSectionId, 'session' | 'repository'>, React.ReactNode>;

  return (
    <WorkStatusPrimaryGroup
      sessionId={sessionId}
      directory={directory}
      showSession={sectionVisible('session')}
      showRepository={repositoryEnabled && sectionVisible('repository')}
      goalRow={<WorkStatusGoalRow sessionId={sessionId} directory={directory} />}
    >
      {(primary) => sectionOrder.map((id) => {
        if (!sectionVisible(id)) return null;
        if (isExtensionSectionId(id)) {
          const guest = extensionSections.byId.get(id);
          return guest ? <WorkStatusExtensionSection key={id} guest={guest} directory={directory} /> : null;
        }
        return <React.Fragment key={id}>{id === 'session' || id === 'repository' ? primary[id] : secondarySections[id]}</React.Fragment>;
      })}
    </WorkStatusPrimaryGroup>
  );
};
