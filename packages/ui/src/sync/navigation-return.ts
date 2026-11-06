import { z } from 'zod';

/** Navigation metadata only; composer text and attachments retain their own draft identity. */
const navigationDraftSchema = z.object({
  draftId: z.number().int().nonnegative(),
  open: z.boolean(), target: z.enum(['chat', 'project']),
  directoryOverride: z.string().nullable(), parentID: z.string().nullable(),
  selectedProjectId: z.string().nullable().optional(),
  preparedChatDirectory: z.string().nullable().optional(),
  workDraftId: z.string().nullable().optional(),
  worktreeStartDirectory: z.union([z.string(), z.object({ worktreeRoot: z.string(), directory: z.string().nullable() })]).nullable().optional(),
  permissionMode: z.enum(['ask', 'safety', 'auto']).optional(),
  pendingWorktreeRequestId: z.string().nullable().optional(),
  bootstrapPendingDirectory: z.string().nullable().optional(),
  preserveDirectoryOverride: z.boolean().optional(),
  title: z.string().optional(), initialPrompt: z.string().optional(), targetFolderId: z.string().optional(),
  projectContextPins: z.object({ notes: z.array(z.string()), plans: z.array(z.string()) }).optional(),
});

export const navigationReturnSchema = z.object({
  runtimeKey: z.string().min(1), directory: z.string().min(1),
  sessionId: z.string().nullable(), projectId: z.string().nullable(),
  draft: navigationDraftSchema,
});
export type NavigationReturn = z.infer<typeof navigationReturnSchema>;
