import {
  type AttachIssueRequest,
  type GuestBlockCall,
  type GuestHostSurface,
  type GuestItem,
  type GuestPopoverClosedEvent,
  type GuestPopoverContext,
} from '@openchamber/sdk';
import type { GuestBackgroundAction } from '@/lib/guests/run-action';
import { type GuestFileChannel } from '@/lib/guests/file-editor-channel';
import { type GuestPopoverActivation } from '@/lib/guests/popovers';
import { type GuestStatusControlBinding } from '@/lib/guests/status-controls';
import { type PluginContextPanelMode } from '@/lib/surfaces/modes';

export type PluginPaneProps = {
  mode: PluginContextPanelMode;
  surface?: GuestHostSurface;
  item?: GuestItem | null;
  headless?: boolean;
  backgroundAction?: GuestBackgroundAction;
  onDismiss?: () => void;
  onAttach?: (issue: AttachIssueRequest) => void;
  onSessionStarted?: () => void;
  block?: { call: GuestBlockCall; entry: string; answer: (text: string) => Promise<void> };
  onResize?: (height: number) => void;
  onStatusControls?: (binding: GuestStatusControlBinding | null) => void;
  statusDirectory?: string | null;
  fileEditor?: { editorId: string; channel: GuestFileChannel };
  pinnedDirectory?: string;
  popover?: GuestPopoverContext;
  popoverHost?: { entry: string; directory: string; context: GuestPopoverContext; activation: GuestPopoverActivation; focus: boolean };
  isActive?: () => boolean;
  onPopoverClosed?: (event: GuestPopoverClosedEvent) => void;
  onPopoverActivity?: (active: boolean) => void;
};
