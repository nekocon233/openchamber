export type UserSkillSyncAgent = 'claude' | 'codex';

export type UserSkillSyncSource = {
  agent: UserSkillSyncAgent;
  plugin: string;
  version: string;
};

/** `external`: a symlink whose target this module does not own. */
export type UserSkillSyncStatus = 'update' | 'current' | 'external' | 'noSource';

export type UserSkillSyncPlanItem = {
  skillName: string;
  status: UserSkillSyncStatus;
  source: UserSkillSyncSource | null;
};

export type UserSkillSyncResult = {
  skillName: string;
  status: 'updated' | 'skipped' | 'failed';
  /** Why a skipped item was left alone. */
  reason?: UserSkillSyncStatus;
  kind?: 'copyFailed';
  message?: string;
  source: UserSkillSyncSource | null;
};

export type UserSkillSyncPlan = {
  ok: true;
  plan: UserSkillSyncPlanItem[];
};

export type UserSkillSyncRun = {
  ok: true;
  results: UserSkillSyncResult[];
  updated: number;
  skipped: number;
  failed: number;
};

export type UserSkillSyncError = {
  kind: 'busy' | 'unknown';
  message: string;
};

export type UserSkillSyncOutcome =
  | UserSkillSyncPlan
  | UserSkillSyncRun
  | { ok: false; error: UserSkillSyncError };

export declare const syncUserSkills: (options: {
  homeDir: string;
  dryRun?: boolean;
}) => Promise<UserSkillSyncOutcome>;
