import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VERSION = 1;
const FILE_NAME = 'skills-installed-sources.json';

export interface InstalledSourceEntry {
  skillName: string;
  skillDir: string;
  sourceId: string;
  projectDirectory?: unknown;
  scope?: unknown;
  source?: unknown;
  sourceRef?: unknown;
}

const isInstalledSourceEntry = (value: unknown): value is InstalledSourceEntry =>
  value !== null && typeof value === 'object'
    && 'skillName' in value && typeof value.skillName === 'string' && Boolean(value.skillName.trim())
    && 'sourceId' in value && typeof value.sourceId === 'string' && Boolean(value.sourceId.trim())
    && 'skillDir' in value && typeof value.skillDir === 'string' && Boolean(value.skillDir.trim());

const isInstalledSourcesPayload = (value: unknown): value is { version: number; entries: unknown[] } =>
  value !== null && typeof value === 'object'
    && 'version' in value && value.version === VERSION
    && 'entries' in value && Array.isArray(value.entries);

const installedSourcesPath = () => path.join(
  process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber'),
  FILE_NAME,
);

const entryKey = (entry: InstalledSourceEntry) => JSON.stringify([
  entry.sourceId, entry.skillDir, entry.scope, entry.source, entry.projectDirectory ?? null,
]);

export const readInstalledSources = () => {
  const byName = new Map<string, InstalledSourceEntry[]>();
  let payload: unknown;
  try {
    payload = JSON.parse(fs.readFileSync(installedSourcesPath(), 'utf8'));
  } catch {
    return byName;
  }
  if (!isInstalledSourcesPayload(payload)) return byName;
  for (const entry of payload.entries) {
    if (!isInstalledSourceEntry(entry)) continue;
    const skillName = entry.skillName.trim();
    const list = byName.get(skillName) ?? [];
    list.push(entry);
    byName.set(skillName, list);
  }
  return byName;
};

export const appendInstalledSources = (entries: InstalledSourceEntry[]) => {
  const valid = (Array.isArray(entries) ? entries : []).filter(isInstalledSourceEntry);
  if (valid.length === 0) return;

  const existing = readInstalledSources();
  const byName = new Map<string, InstalledSourceEntry[]>();
  for (const [name, list] of existing) byName.set(name, [...list]);

  for (const entry of valid) {
    const list = byName.get(entry.skillName) ?? [];
    const key = entryKey(entry);
    byName.set(entry.skillName, [...list.filter((held) => entryKey(held) !== key), entry]);
  }

  writeEntries([...byName.values()].flat());
};

export const readInstalledSourcesForProject = (directory: string | null) => {
  const records = readInstalledSources();
  for (const [name, entries] of records) {
    records.set(name, entries.filter((entry) => (
      entry.scope === 'user' || (directory !== null && entry.projectDirectory === directory)
    )));
  }
  return records;
};

export const removeInstalledSources = (skillName: string, matches: (entry: InstalledSourceEntry) => boolean = () => true) => {
  const existing = readInstalledSources();
  const entries = existing.get(skillName);
  if (!entries) return;
  const kept = entries.filter((entry) => !matches(entry));
  if (kept.length === entries.length) return;
  if (kept.length) existing.set(skillName, kept);
  else existing.delete(skillName);
  writeEntries([...existing.values()].flat());
};

const writeEntries = (entries: InstalledSourceEntry[]) => {
  const target = installedSourcesPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, entries }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
};

export const isInstalledFromSource = <Directory>(
  provenanceByName: Map<string, InstalledSourceEntry[]>, skillName: string, sourceId: string, skillDir: Directory,
  scope?: 'project' | 'user',
) => {
  const entries = provenanceByName.get(skillName);
  const provenance = scope ? entries?.filter((entry) => entry.scope === scope) : entries;
  return !provenance || provenance.length === 0
    || provenance.some((entry) => entry.sourceId === sourceId && entry.skillDir === skillDir);
};
