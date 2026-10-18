export type InstalledSourceEntry = {
  skillName: string;
  skillDir: string;
  sourceId: string;
  scope?: 'user' | 'project';
  source?: 'opencode' | 'agents';
  sourceRef?: string;
};

/** A record as `readInstalledSources` returns it: strings trimmed, unknown targets null. */
export type RecordedInstalledSource = {
  skillName: string;
  skillDir: string;
  sourceId: string;
  scope: 'user' | 'project' | null;
  source: 'opencode' | 'agents' | null;
  sourceRef: string | null;
};

export function readInstalledSources(): Map<string, RecordedInstalledSource[]>;
export function appendInstalledSources(entries: InstalledSourceEntry[]): void;
export function removeInstalledSources(skillName: string): void;
export function isInstalledFromSource(
  provenanceByName: Map<string, InstalledSourceEntry[] | RecordedInstalledSource[]>,
  skillName: string,
  sourceId: string,
  skillDir: string,
): boolean;
