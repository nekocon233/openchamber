import type { RecordedInstalledSource } from './installed-sources';

export type InstalledUpdatePlanItem = {
  skillName: string;
  skillDir: string;
  scope: 'user' | 'project';
  source: 'opencode' | 'agents';
  sourceId: string;
  sourceRef: string;
};

export type InstalledUpdateFailureKind =
  | 'authRequired'
  | 'gitUnavailable'
  | 'networkError'
  | 'invalidSource'
  | 'unknown';

export type InstalledUpdateResult = {
  skillName: string;
  scope: 'user' | 'project';
  source: 'opencode' | 'agents';
  status: 'updated' | 'skipped' | 'failed';
  kind?: InstalledUpdateFailureKind;
  reason?: string;
};

export type CatalogCloneIdentity =
  | { transport: 'ssh' | 'account' | 'https'; credentialId?: string; endpoint?: string }
  | { transport: 'anonymous'; anonymous: true }
  | null;

export type InstalledUpdateIdentity = {
  ok: boolean;
  identity?: CatalogCloneIdentity;
  error?: { kind?: string; message?: string };
};

export type InstalledUpdateInstallInput = {
  source: string;
  identity?: CatalogCloneIdentity;
  scope: 'user' | 'project';
  targetSource: 'opencode' | 'agents';
  workingDirectory?: string;
  userSkillDir: string;
  selections: Array<{ skillDir: string }>;
  conflictPolicy: 'overwriteAll';
};

export type InstalledUpdateInstallOutcome = {
  ok: boolean;
  installed?: Array<{ skillName: string }>;
  skipped?: Array<{ skillName: string; reason?: string }>;
  error?: { kind?: string; message?: string };
};

export function planInstalledSkillUpdates(options: {
  provenanceByName: Map<string, RecordedInstalledSource[]>;
  targetDirFor: (item: { skillName: string; scope: string; source: string }) => string | null;
  skillExists: (targetDir: string) => boolean;
}): InstalledUpdatePlanItem[];

export function updateInstalledSkills(options: {
  plan: InstalledUpdatePlanItem[];
  resolveIdentity: (sourceId: string, sourceRef: string) => Promise<InstalledUpdateIdentity>;
  install: (input: InstalledUpdateInstallInput) => Promise<InstalledUpdateInstallOutcome>;
  workingDirectory?: string | null;
  userSkillDir: string;
}): Promise<
  | { ok: true; results: InstalledUpdateResult[] }
  | { ok: false; error: { kind: string; message: string } }
>;
